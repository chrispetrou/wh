use crate::commands::ls::{self, Row};
use crate::{output, WdError};
use std::collections::VecDeque;
use std::env;
use std::fs::{File, OpenOptions};
use std::io::{self, IsTerminal, Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};

pub fn run(query: Option<&str>) -> Result<(), WdError> {
    let cwd = env::current_dir()?;
    let rows = ls::collect_rows(&cwd)?;
    if rows.is_empty() {
        return Err(WdError::Msg("no worktrees".into()));
    }

    if let Some(q) = query {
        let hits = matches(&rows, q);
        return match hits[..] {
            [] => Err(WdError::Msg(format!("no worktree matches '{q}'"))),
            [i] => finish(&rows[i], &cwd),
            _ => {
                for &i in &hits {
                    eprintln!("{}", rows[i].name);
                }
                Err(WdError::Msg(format!(
                    "'{q}' matches {} worktrees",
                    hits.len()
                )))
            }
        };
    }

    if !io::stdin().is_terminal() {
        return Err(WdError::Msg(
            "not a terminal; pass a query: wd switch <query>".into(),
        ));
    }
    let mut tty = open_tty()
        .map_err(|_| WdError::Msg("not a terminal; pass a query: wd switch <query>".into()))?;
    match pick(&rows, &mut tty)? {
        Some(i) => finish(&rows[i], &cwd),
        None => std::process::exit(1), // cancelled; raw mode already restored
    }
}

/// Path to stdout for the shell wrapper; the human-facing line to stderr.
fn finish(row: &Row, cwd: &Path) -> Result<(), WdError> {
    let abs = row.path.canonicalize().unwrap_or_else(|_| row.path.clone());
    println!("{}", abs.display());
    output::success_to_stderr(&format!(
        "switched {}",
        output::display_path(&row.path, cwd)
    ));
    Ok(())
}

/// Exact name match wins; otherwise case-insensitive substring on the name.
fn matches(rows: &[Row], q: &str) -> Vec<usize> {
    let ql = q.to_lowercase();
    if let Some(i) = rows.iter().position(|r| r.name.to_lowercase() == ql) {
        return vec![i];
    }
    rows.iter()
        .enumerate()
        .filter(|(_, r)| r.name.to_lowercase().contains(&ql))
        .map(|(i, _)| i)
        .collect()
}

fn filter(names: &[String], query: &str) -> Vec<usize> {
    let ql = query.to_lowercase();
    names
        .iter()
        .enumerate()
        .filter(|(_, n)| n.to_lowercase().contains(&ql))
        .map(|(i, _)| i)
        .collect()
}

enum Key {
    Up,
    Down,
    Enter,
    Esc,
    Backspace,
    Char(char),
}

struct State {
    query: String,
    sel: usize, // position within the filtered list
}

enum Step {
    Continue,
    Cancel,
    Select(usize), // index into the full row list
}

fn step(state: &mut State, key: Key, filtered: &[usize]) -> Step {
    match key {
        Key::Esc => return Step::Cancel,
        Key::Enter => {
            if let Some(&i) = filtered.get(state.sel) {
                return Step::Select(i);
            }
        }
        Key::Up => {
            state.sel = if state.sel == 0 {
                filtered.len().saturating_sub(1)
            } else {
                state.sel - 1
            };
        }
        Key::Down => {
            state.sel = if filtered.len() <= 1 || state.sel + 1 >= filtered.len() {
                0
            } else {
                state.sel + 1
            };
        }
        Key::Backspace => {
            state.query.pop();
            state.sel = 0;
        }
        Key::Char(c) => {
            state.query.push(c);
            state.sel = 0;
        }
    }
    Step::Continue
}

// ---- terminal plumbing: raw mode via stty (no extra deps) ----

fn open_tty() -> io::Result<File> {
    let tty = OpenOptions::new().read(true).write(true).open("/dev/tty")?;
    if !tty.is_terminal() {
        return Err(io::Error::other("/dev/tty is not a terminal"));
    }
    Ok(tty)
}

fn stty(tty: &File, args: &[&str]) -> io::Result<String> {
    let out = Command::new("stty")
        .args(args)
        .stdin(Stdio::from(tty.try_clone()?))
        .output()?;
    if !out.status.success() {
        return Err(io::Error::other("stty failed"));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

struct RawGuard {
    tty: File,
    saved: String,
}

impl Drop for RawGuard {
    fn drop(&mut self) {
        let _ = stty(&self.tty, &[&self.saved]);
        let _ = self.tty.write_all(b"\x1b[?25h"); // show cursor
    }
}

fn pick(rows: &[Row], tty: &mut File) -> Result<Option<usize>, WdError> {
    let names: Vec<String> = rows.iter().map(|r| r.name.clone()).collect();
    let lines = ls::render(rows, false); // fixed widths, styling added per frame

    let saved = stty(tty, &["-g"])?;
    // min 0 time 1: reads return empty after ~0.1s, which lets us tell a lone
    // ESC keypress apart from an arrow-key escape sequence
    stty(tty, &["raw", "-echo", "min", "0", "time", "1"])?;
    let _guard = RawGuard {
        tty: tty.try_clone()?,
        saved,
    };
    tty.write_all(b"\x1b[?25l")?;

    let mut state = State {
        query: String::new(),
        sel: 0,
    };
    let mut drawn = 0usize;
    let mut pending = VecDeque::new();
    loop {
        let filtered = filter(&names, &state.query);
        state.sel = state.sel.min(filtered.len().saturating_sub(1));
        draw(tty, &state, &filtered, &lines, &mut drawn)?;
        let key = read_key(tty, &mut pending)?;
        match step(&mut state, key, &filtered) {
            Step::Continue => {}
            Step::Cancel => {
                clear(tty, drawn)?;
                return Ok(None);
            }
            Step::Select(i) => {
                clear(tty, drawn)?;
                return Ok(Some(i));
            }
        }
    }
}

fn clear(tty: &mut File, drawn: usize) -> io::Result<()> {
    if drawn > 0 {
        write!(tty, "\x1b[{drawn}A\r\x1b[J")?;
    }
    Ok(())
}

fn draw(
    tty: &mut File,
    state: &State,
    filtered: &[usize],
    lines: &[String],
    drawn: &mut usize,
) -> io::Result<()> {
    let mut out = String::new();
    if *drawn > 0 {
        out.push_str(&format!("\x1b[{}A\r\x1b[J", drawn));
    } else {
        out.push('\r');
    }
    out.push_str(&format!(
        "\x1b[2m? select worktree\x1b[0m {}\x1b[2m▏\x1b[0m\r\n",
        state.query
    ));
    if filtered.is_empty() {
        out.push_str("\x1b[2m  no match\x1b[0m\r\n");
        *drawn = 2;
    } else {
        for (pos, &i) in filtered.iter().enumerate() {
            if pos == state.sel {
                out.push_str(&format!("\x1b[7m› {}\x1b[0m\r\n", lines[i]));
            } else {
                out.push_str(&format!("  {}\r\n", lines[i]));
            }
        }
        *drawn = 1 + filtered.len();
    }
    tty.write_all(out.as_bytes())?;
    tty.flush()
}

/// One byte from the tty, via the pending queue so no burst input is lost.
/// Non-blocking mode returns None after the ~0.1s stty read window, which is
/// how a lone ESC is told apart from an arrow-key sequence.
fn next_byte(tty: &mut File, pending: &mut VecDeque<u8>, block: bool) -> io::Result<Option<u8>> {
    if let Some(b) = pending.pop_front() {
        return Ok(Some(b));
    }
    let mut buf = [0u8; 16];
    loop {
        let n = tty.read(&mut buf)?;
        if n > 0 {
            pending.extend(&buf[1..n]);
            return Ok(Some(buf[0]));
        }
        if !block {
            return Ok(None);
        }
    }
}

fn read_key(tty: &mut File, pending: &mut VecDeque<u8>) -> io::Result<Key> {
    loop {
        let Some(b) = next_byte(tty, pending, true)? else {
            continue;
        };
        let key = match b {
            0x03 => Some(Key::Esc), // ctrl-c
            0x0d | 0x0a => Some(Key::Enter),
            0x7f | 0x08 => Some(Key::Backspace),
            0x10 => Some(Key::Up),   // ctrl-p
            0x0e => Some(Key::Down), // ctrl-n
            0x1b => match next_byte(tty, pending, false)? {
                None => Some(Key::Esc), // nothing followed: a real ESC press
                Some(b'[') => {
                    // consume the CSI sequence through its final byte
                    let mut key = None;
                    while let Some(c) = next_byte(tty, pending, false)? {
                        if (0x40..=0x7e).contains(&c) {
                            key = match c {
                                b'A' => Some(Key::Up),
                                b'B' => Some(Key::Down),
                                _ => None,
                            };
                            break;
                        }
                    }
                    key
                }
                Some(_) => None, // alt-modified key or unknown sequence: ignore
            },
            b if (0x20..0x7f).contains(&b) => Some(Key::Char(b as char)),
            _ => None,
        };
        if let Some(k) = key {
            return Ok(k);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn rows(names: &[&str]) -> Vec<Row> {
        names
            .iter()
            .map(|n| Row {
                name: n.to_string(),
                status: "clean".into(),
                extra: String::new(),
                path: PathBuf::from(format!("/r/{n}")),
            })
            .collect()
    }

    fn names(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn exact_match_beats_substring() {
        let r = rows(&["main", "maintenance"]);
        assert_eq!(matches(&r, "main"), vec![0]);
    }

    #[test]
    fn substring_is_case_insensitive() {
        let r = rows(&["feat/auth", "fix/nav"]);
        assert_eq!(matches(&r, "AUTH"), vec![0]);
        assert_eq!(matches(&r, "f"), vec![0, 1]);
        assert!(matches(&r, "zzz").is_empty());
    }

    #[test]
    fn filter_empty_query_keeps_all() {
        let n = names(&["main", "feat/auth"]);
        assert_eq!(filter(&n, ""), vec![0, 1]);
        assert_eq!(filter(&n, "au"), vec![1]);
    }

    #[test]
    fn arrows_wrap_around() {
        let mut s = State {
            query: String::new(),
            sel: 0,
        };
        let f = vec![0, 1, 2];
        assert!(matches!(step(&mut s, Key::Down, &f), Step::Continue));
        assert_eq!(s.sel, 1);
        step(&mut s, Key::Down, &f);
        step(&mut s, Key::Down, &f);
        assert_eq!(s.sel, 0); // wrapped
        step(&mut s, Key::Up, &f);
        assert_eq!(s.sel, 2); // wrapped back
    }

    #[test]
    fn typing_resets_selection_and_enter_selects() {
        let mut s = State {
            query: String::new(),
            sel: 2,
        };
        let f = vec![0, 1, 2];
        step(&mut s, Key::Char('a'), &f);
        assert_eq!(s.query, "a");
        assert_eq!(s.sel, 0);
        step(&mut s, Key::Backspace, &f);
        assert_eq!(s.query, "");
        match step(&mut s, Key::Enter, &[7, 8]) {
            Step::Select(i) => assert_eq!(i, 7),
            _ => panic!("expected select"),
        }
    }

    #[test]
    fn enter_on_empty_filter_is_noop() {
        let mut s = State {
            query: "zzz".into(),
            sel: 0,
        };
        assert!(matches!(step(&mut s, Key::Enter, &[]), Step::Continue));
    }

    #[test]
    fn esc_cancels() {
        let mut s = State {
            query: String::new(),
            sel: 0,
        };
        assert!(matches!(step(&mut s, Key::Esc, &[0]), Step::Cancel));
    }
}

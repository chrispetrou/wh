use crate::{git, output, WdError};
use std::env;
use std::path::{Path, PathBuf};

pub struct Row {
    pub name: String,
    pub status: String,
    pub extra: String,
    pub path: PathBuf,
}

pub fn run() -> Result<(), WdError> {
    let cwd = env::current_dir()?;
    let rows = collect_rows(&cwd)?;
    for line in render(&rows, output::color()) {
        println!("{line}");
    }
    Ok(())
}

/// Worktree rows with status columns, main first then alphabetical.
/// Shared by `wd ls` and the `wd switch` picker.
pub fn collect_rows(cwd: &Path) -> Result<Vec<Row>, WdError> {
    let wts = git::worktrees(cwd)?;
    let mut list: Vec<&git::Worktree> = wts.iter().filter(|w| !w.is_bare).collect();
    list.sort_by_key(|w| (!w.is_main, name_of(w)));
    Ok(list
        .iter()
        .map(|w| {
            let (status, extra) = status_words(w);
            Row {
                name: name_of(w),
                status,
                extra,
                path: w.path.clone(),
            }
        })
        .collect())
}

fn name_of(w: &git::Worktree) -> String {
    match &w.branch {
        Some(b) => b.clone(),
        None => format!("{} detached", &w.head[..w.head.len().min(7)]),
    }
}

fn status_words(w: &git::Worktree) -> (String, String) {
    if w.prunable {
        return ("stale".into(), String::new());
    }
    match git::status_of(&w.path) {
        Ok(st) => {
            let status = if st.dirty == 0 {
                "clean".to_string()
            } else {
                format!("{} dirty", st.dirty)
            };
            let extra = match st.ahead_behind {
                None | Some((0, 0)) => String::new(),
                Some((a, 0)) => format!("ahead {a}"),
                Some((0, b)) => format!("behind {b}"),
                Some((a, b)) => format!("ahead {a} behind {b}"),
            };
            (status, extra)
        }
        Err(_) => ("stale".into(), String::new()),
    }
}

pub fn render(rows: &[Row], colored: bool) -> Vec<String> {
    let w1 = rows.iter().map(|r| r.name.len()).max().unwrap_or(0) + 2;
    let w2 = rows.iter().map(|r| r.status.len()).max().unwrap_or(0) + 2;
    rows.iter()
        .map(|r| {
            if r.extra.is_empty() {
                format!("{:<w1$}{}", r.name, r.status)
            } else {
                let extra = format!("·  {}", r.extra);
                let extra = if colored {
                    format!("\x1b[2m{extra}\x1b[0m")
                } else {
                    extra
                };
                format!("{:<w1$}{:<w2$}{}", r.name, r.status, extra)
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(name: &str, status: &str, extra: &str) -> Row {
        Row {
            name: name.into(),
            status: status.into(),
            extra: extra.into(),
            path: PathBuf::new(),
        }
    }

    #[test]
    fn aligns_columns_like_the_mock() {
        let rows = vec![
            row("main", "clean", ""),
            row("fix/nav-323", "2 dirty", "ahead 3"),
            row("spike/wasm", "clean", "behind 12"),
        ];
        let lines = render(&rows, false);
        assert_eq!(lines[0], "main         clean");
        assert_eq!(lines[1], "fix/nav-323  2 dirty  ·  ahead 3");
        assert_eq!(lines[2], "spike/wasm   clean    ·  behind 12");
    }

    #[test]
    fn no_trailing_spaces_without_extra() {
        let lines = render(&[row("main", "clean", "")], false);
        assert_eq!(lines[0], "main  clean");
    }
}

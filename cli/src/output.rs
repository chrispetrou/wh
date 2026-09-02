use std::env;
use std::io::IsTerminal;
use std::path::Path;

pub fn color() -> bool {
    std::io::stdout().is_terminal() && env::var_os("NO_COLOR").is_none()
}

/// Success line: green arrow, per the landing demo.
pub fn success(msg: &str) {
    if color() {
        println!("\x1b[32m→\x1b[0m {msg}");
    } else {
        println!("→ {msg}");
    }
}

/// Success line on stderr, for commands whose stdout is machine-read
/// (e.g. the `wh switch` path captured by the shell wrapper).
pub fn success_to_stderr(msg: &str) {
    let colored = std::io::stderr().is_terminal() && env::var_os("NO_COLOR").is_none();
    if colored {
        eprintln!("\x1b[32m→\x1b[0m {msg}");
    } else {
        eprintln!("→ {msg}");
    }
}

/// Muted informational line.
pub fn info(msg: &str) {
    println!("{}", muted(msg));
}

fn stderr_colored() -> bool {
    std::io::stderr().is_terminal() && env::var_os("NO_COLOR").is_none()
}

/// A status line beside an answer (`reading 3 commits ...`, `· 4.1s ·
/// model`): stdout when it is a terminal, stderr when stdout is piped
/// somewhere, so `wh explain > notes.md` holds only the answer.
pub fn status(msg: &str) {
    if std::io::stdout().is_terminal() {
        info(msg);
    } else if stderr_colored() {
        eprintln!("\x1b[2m{msg}\x1b[0m");
    } else {
        eprintln!("{msg}");
    }
}

/// An error on stderr: amber `error:` label, then the message; any
/// further lines (the way out) muted.
pub fn error(msg: &str) {
    let mut lines = msg.lines();
    let first = lines.next().unwrap_or("");
    if stderr_colored() {
        eprintln!("\x1b[33merror:\x1b[0m {first}");
        for l in lines {
            eprintln!("\x1b[2m{l}\x1b[0m");
        }
    } else {
        eprintln!("error: {first}");
        for l in lines {
            eprintln!("{l}");
        }
    }
}

/// A warning on stderr, amber.
pub fn warn(msg: &str) {
    if stderr_colored() {
        eprintln!("\x1b[33m{msg}\x1b[0m");
    } else {
        eprintln!("{msg}");
    }
}

pub fn muted(s: &str) -> String {
    if color() {
        format!("\x1b[2m{s}\x1b[0m")
    } else {
        s.to_string()
    }
}

/// Path relative to cwd, "../repo.feat-auth" style.
pub fn display_path(p: &Path, cwd: &Path) -> String {
    let p = p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
    let cwd = cwd.canonicalize().unwrap_or_else(|_| cwd.to_path_buf());
    relative(&p, &cwd)
}

fn relative(p: &Path, cwd: &Path) -> String {
    let pc: Vec<_> = p.components().collect();
    let cc: Vec<_> = cwd.components().collect();
    let common = pc.iter().zip(&cc).take_while(|(a, b)| a == b).count();
    let mut parts: Vec<String> = vec!["..".into(); cc.len() - common];
    parts.extend(
        pc[common..]
            .iter()
            .map(|c| c.as_os_str().to_string_lossy().into_owned()),
    );
    if parts.is_empty() {
        ".".into()
    } else {
        parts.join("/")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn sibling_is_dot_dot() {
        assert_eq!(
            relative(
                &PathBuf::from("/h/repo.feat-auth"),
                &PathBuf::from("/h/repo")
            ),
            "../repo.feat-auth"
        );
    }

    #[test]
    fn same_dir_is_dot() {
        assert_eq!(
            relative(&PathBuf::from("/h/repo"), &PathBuf::from("/h/repo")),
            "."
        );
    }

    #[test]
    fn child_has_no_prefix() {
        assert_eq!(
            relative(&PathBuf::from("/h/repo/sub"), &PathBuf::from("/h/repo")),
            "sub"
        );
    }

    #[test]
    fn cousin_walks_up() {
        assert_eq!(
            relative(&PathBuf::from("/h/a/x"), &PathBuf::from("/h/b/y")),
            "../../a/x"
        );
    }
}

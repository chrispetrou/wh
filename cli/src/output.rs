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

/// Muted informational line.
pub fn info(msg: &str) {
    println!("{}", muted(msg));
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

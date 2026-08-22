use std::fs;
use std::io;
use std::path::Path;

/// `.env` and `.env.*` — not `.envrc`, not `.environment`.
pub fn is_env_file(name: &str) -> bool {
    name == ".env" || (name.len() > 5 && name.starts_with(".env."))
}

/// Copy env files from one worktree root to another, non-recursive, regular
/// files only. Files already present at the destination (e.g. a tracked
/// `.env.example` that got checked out) are left alone. Returns sorted names.
pub fn copy_env_files(from: &Path, to: &Path) -> io::Result<Vec<String>> {
    let mut copied = Vec::new();
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !is_env_file(&name) {
            continue;
        }
        if !fs::metadata(entry.path())
            .map(|m| m.is_file())
            .unwrap_or(false)
        {
            continue;
        }
        let dest = to.join(&name);
        if dest.exists() {
            continue;
        }
        fs::copy(entry.path(), &dest)?;
        copied.push(name);
    }
    copied.sort();
    Ok(copied)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_env_files() {
        assert!(is_env_file(".env"));
        assert!(is_env_file(".env.local"));
        assert!(is_env_file(".env.production"));
        assert!(!is_env_file(".env."));
        assert!(!is_env_file(".envrc"));
        assert!(!is_env_file(".environment"));
        assert!(!is_env_file("env"));
        assert!(!is_env_file("a.env"));
    }

    #[test]
    fn copies_and_skips() {
        let tmp = tempfile::tempdir().unwrap();
        let from = tmp.path().join("a");
        let to = tmp.path().join("b");
        fs::create_dir_all(&from).unwrap();
        fs::create_dir_all(&to).unwrap();
        fs::write(from.join(".env"), "x").unwrap();
        fs::write(from.join(".env.local"), "y").unwrap();
        fs::write(from.join(".envrc"), "no").unwrap();
        fs::write(from.join(".env.example"), "new").unwrap();
        fs::write(to.join(".env.example"), "tracked").unwrap();

        let copied = copy_env_files(&from, &to).unwrap();
        assert_eq!(copied, vec![".env", ".env.local"]);
        assert!(!to.join(".envrc").exists());
        assert_eq!(
            fs::read_to_string(to.join(".env.example")).unwrap(),
            "tracked"
        );
    }
}

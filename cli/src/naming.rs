use crate::WdError;
use std::path::{Path, PathBuf};

/// Branch name -> directory-safe suffix: `/` and anything outside
/// [A-Za-z0-9._-] become `-`, runs collapse, edges trimmed.
pub fn sanitize(branch: &str) -> String {
    let mut out = String::with_capacity(branch.len());
    let mut prev_dash = false;
    for c in branch.chars() {
        let mapped = if c.is_ascii_alphanumeric() || c == '.' || c == '_' {
            c
        } else {
            '-'
        };
        if mapped == '-' {
            if prev_dash {
                continue;
            }
            prev_dash = true;
        } else {
            prev_dash = false;
        }
        out.push(mapped);
    }
    out.trim_matches(|c| c == '-' || c == '.').to_string()
}

/// Sibling dir for a branch: `<parent>/<main-dirname>.<sanitized-branch>`.
/// A bare repo's trailing `.git` is stripped from the dirname.
pub fn sibling_path(main_worktree: &Path, branch: &str) -> Result<PathBuf, WdError> {
    let parent = main_worktree
        .parent()
        .ok_or_else(|| WdError::Msg("repository has no parent directory".into()))?;
    let name = main_worktree
        .file_name()
        .ok_or_else(|| WdError::Msg("cannot determine repository directory name".into()))?
        .to_string_lossy();
    let name = name.strip_suffix(".git").unwrap_or(&name);
    let suffix = sanitize(branch);
    if suffix.is_empty() {
        return Err(WdError::Msg(format!(
            "cannot derive a directory name from '{branch}'"
        )));
    }
    Ok(parent.join(format!("{name}.{suffix}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_branch_names() {
        assert_eq!(sanitize("feat/auth"), "feat-auth");
        assert_eq!(sanitize("fix/nav#323"), "fix-nav-323");
        assert_eq!(sanitize("a//b"), "a-b");
        assert_eq!(sanitize("release/v1.2"), "release-v1.2");
        assert_eq!(sanitize("héllo"), "h-llo");
        assert_eq!(sanitize("-lead./"), "lead");
        assert_eq!(sanitize("///"), "");
    }

    #[test]
    fn builds_sibling_path() {
        let p = sibling_path(Path::new("/home/u/repo"), "feat/auth").unwrap();
        assert_eq!(p, PathBuf::from("/home/u/repo.feat-auth"));
    }

    #[test]
    fn strips_bare_git_suffix() {
        let p = sibling_path(Path::new("/home/u/repo.git"), "x").unwrap();
        assert_eq!(p, PathBuf::from("/home/u/repo.x"));
    }

    #[test]
    fn rejects_unusable_names() {
        assert!(sibling_path(Path::new("/home/u/repo"), "///").is_err());
    }
}

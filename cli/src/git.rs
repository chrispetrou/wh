use crate::WhError;
use std::path::{Path, PathBuf};
use std::process::Command;

fn base(dir: &Path) -> Command {
    let mut c = Command::new("git");
    c.arg("-C").arg(dir).env("GIT_OPTIONAL_LOCKS", "0");
    c
}

/// Run git in `dir`; trimmed stdout on success, error carrying stderr otherwise.
pub fn run(dir: &Path, args: &[&str]) -> Result<String, WhError> {
    let out = base(dir).args(args).output().map_err(WhError::Io)?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim_end().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&out.stderr).trim_end().to_string();
        if stderr.contains("not a git repository") {
            Err(WhError::NotARepo)
        } else {
            Err(WhError::Git { stderr })
        }
    }
}

/// Run git for its exit code only (rev-parse --verify, merge-base --is-ancestor).
pub fn run_ok(dir: &Path, args: &[&str]) -> bool {
    base(dir)
        .args(args)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// The ref merges and pr drafts are judged against: origin's HEAD when
/// known, else local main/master.
pub fn default_ref(dir: &Path) -> Result<String, WhError> {
    if let Ok(r) = run(
        dir,
        &[
            "symbolic-ref",
            "--quiet",
            "--short",
            "refs/remotes/origin/HEAD",
        ],
    ) {
        if !r.is_empty() {
            return Ok(r);
        }
    }
    for b in ["main", "master"] {
        if run_ok(
            dir,
            &[
                "rev-parse",
                "--verify",
                "--quiet",
                &format!("refs/heads/{b}"),
            ],
        ) {
            return Ok(b.to_string());
        }
    }
    Err(WhError::Msg("cannot determine default branch".into()))
}

/// The checked-out branch, or None when detached.
pub fn current_branch(dir: &Path) -> Option<String> {
    run(dir, &["rev-parse", "--abbrev-ref", "HEAD"])
        .ok()
        .filter(|b| !b.is_empty() && b != "HEAD")
}

pub fn toplevel(dir: &Path) -> Result<PathBuf, WhError> {
    Ok(PathBuf::from(run(dir, &["rev-parse", "--show-toplevel"])?))
}

/// The main worktree (or the bare repo dir), regardless of which worktree we
/// run from. Anchor for sibling naming.
pub fn main_worktree(dir: &Path) -> Result<PathBuf, WhError> {
    let common = match run(
        dir,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    ) {
        Ok(p) => PathBuf::from(p),
        // --path-format needs git >= 2.31; fall back to absolutizing by hand
        Err(WhError::NotARepo) => return Err(WhError::NotARepo),
        Err(_) => {
            let p = PathBuf::from(run(dir, &["rev-parse", "--git-common-dir"])?);
            if p.is_absolute() {
                p
            } else {
                dir.join(p)
            }
        }
    };
    let common = common.canonicalize().map_err(WhError::Io)?;
    if common.file_name().is_some_and(|n| n == ".git") {
        Ok(common
            .parent()
            .expect(".git dir has a parent")
            .to_path_buf())
    } else {
        Ok(common) // bare repo: the git dir itself
    }
}

pub struct Worktree {
    pub path: PathBuf,
    pub head: String,
    pub branch: Option<String>, // short name; None when detached
    pub is_main: bool,
    pub is_bare: bool,
    pub locked: bool,
    pub prunable: bool,
}

pub fn worktrees(dir: &Path) -> Result<Vec<Worktree>, WhError> {
    Ok(parse_worktree_list(&run(
        dir,
        &["worktree", "list", "--porcelain"],
    )?))
}

pub fn parse_worktree_list(s: &str) -> Vec<Worktree> {
    let mut out = Vec::new();
    for block in s.split("\n\n") {
        let block = block.trim();
        if block.is_empty() {
            continue;
        }
        let mut wt = Worktree {
            path: PathBuf::new(),
            head: String::new(),
            branch: None,
            is_main: false,
            is_bare: false,
            locked: false,
            prunable: false,
        };
        for line in block.lines() {
            if let Some(p) = line.strip_prefix("worktree ") {
                wt.path = PathBuf::from(p);
            } else if let Some(h) = line.strip_prefix("HEAD ") {
                wt.head = h.to_string();
            } else if let Some(b) = line.strip_prefix("branch ") {
                wt.branch = Some(b.strip_prefix("refs/heads/").unwrap_or(b).to_string());
            } else if line == "bare" {
                wt.is_bare = true;
            } else if line == "detached" {
                wt.branch = None;
            } else if line == "locked" || line.starts_with("locked ") {
                wt.locked = true;
            } else if line == "prunable" || line.starts_with("prunable ") {
                wt.prunable = true;
            }
        }
        out.push(wt);
    }
    if let Some(first) = out.first_mut() {
        first.is_main = true;
    }
    out
}

pub struct WtStatus {
    pub dirty: usize,
    pub ahead_behind: Option<(usize, usize)>,
}

pub fn status_of(wt: &Path) -> Result<WtStatus, WhError> {
    let st = run(wt, &["status", "--porcelain"])?;
    let dirty = st.lines().filter(|l| !l.trim().is_empty()).count();
    let ahead_behind = run(
        wt,
        &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
    )
    .ok()
    .and_then(|s| {
        let mut it = s.split_whitespace();
        Some((it.next()?.parse().ok()?, it.next()?.parse().ok()?))
    });
    Ok(WtStatus {
        dirty,
        ahead_behind,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_main_linked_detached_bare_locked_prunable() {
        let s = "worktree /r/main\nHEAD 1111111111111111111111111111111111111111\nbranch refs/heads/main\n\n\
                 worktree /r/det\nHEAD 2222222222222222222222222222222222222222\ndetached\n\n\
                 worktree /r/bare.git\nbare\n\n\
                 worktree /r/lck\nHEAD 3333333333333333333333333333333333333333\nbranch refs/heads/x\nlocked reason\n\n\
                 worktree /r/gone\nHEAD 4444444444444444444444444444444444444444\nbranch refs/heads/y\nprunable gitdir file points to non-existent location\n";
        let w = parse_worktree_list(s);
        assert_eq!(w.len(), 5);
        assert!(w[0].is_main);
        assert_eq!(w[0].branch.as_deref(), Some("main"));
        assert!(!w[1].is_main);
        assert_eq!(w[1].branch, None);
        assert!(w[2].is_bare);
        assert!(w[3].locked);
        assert_eq!(w[3].branch.as_deref(), Some("x"));
        assert!(w[4].prunable);
    }

    #[test]
    fn parses_empty() {
        assert!(parse_worktree_list("").is_empty());
    }
}

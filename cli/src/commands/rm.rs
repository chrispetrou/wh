use crate::{git, output, WdError};
use std::env;
use std::io::{self, BufRead, IsTerminal, Write};
use std::path::{Path, PathBuf};

pub fn run(name: Option<&str>, dry_run: bool, yes: bool, force: bool) -> Result<(), WdError> {
    let cwd = env::current_dir()?;
    let wts = git::worktrees(&cwd)?;
    let current = git::toplevel(&cwd).ok().and_then(|p| p.canonicalize().ok());

    match name {
        Some(n) => remove_named(n, force, dry_run, &wts, &cwd, current.as_deref()),
        None => prune(dry_run, yes, &wts, &cwd, current.as_deref()),
    }
}

/// Merged means one of: an ancestor of the default ref, a branch whose
/// every commit has an equivalent patch there (rebase merge), or a branch
/// whose whole tree landed as one commit (squash merge). `--force` is left
/// for the genuinely unmerged.
fn merged(cwd: &Path, sha: &str, default: &str) -> bool {
    if git::run_ok(cwd, &["merge-base", "--is-ancestor", sha, default]) {
        return true;
    }
    // rebase merge: `git cherry` marks a commit `-` when its patch id
    // already exists upstream
    if let Ok(out) = git::run(cwd, &["cherry", default, sha]) {
        if !out.is_empty() && out.lines().all(|l| l.starts_with('-')) {
            return true;
        }
    }
    squash_merged(cwd, sha, default)
}

/// A squash merge leaves no commit in common, but the branch's tree as a
/// single patch over the merge base matches the squash commit's patch id.
/// The synthetic commit is a dangling object that git gc reaps; the ident
/// is pinned because the check must not depend on the user's config.
fn squash_merged(cwd: &Path, sha: &str, default: &str) -> bool {
    let Ok(base) = git::run(cwd, &["merge-base", default, sha]) else {
        return false;
    };
    let Ok(tree) = git::run(cwd, &["rev-parse", &format!("{sha}^{{tree}}")]) else {
        return false;
    };
    let Ok(synth) = git::run(
        cwd,
        &[
            "-c",
            "user.name=wd",
            "-c",
            "user.email=wd@localhost",
            "commit-tree",
            &tree,
            "-p",
            &base,
            "-m",
            "wd squash check",
        ],
    ) else {
        return false;
    };
    match git::run(cwd, &["cherry", default, &synth]) {
        Ok(out) => out.starts_with('-'),
        Err(_) => false,
    }
}

fn is_current(w: &git::Worktree, current: Option<&Path>) -> bool {
    match (w.path.canonicalize(), current) {
        (Ok(p), Some(c)) => p == c,
        _ => false,
    }
}

fn worktree_noun(n: usize) -> &'static str {
    if n == 1 {
        "worktree"
    } else {
        "worktrees"
    }
}

fn prune(
    dry_run: bool,
    yes: bool,
    wts: &[git::Worktree],
    cwd: &Path,
    current: Option<&Path>,
) -> Result<(), WdError> {
    let default = git::default_ref(cwd)?;
    let mut candidates = Vec::new();
    for w in wts {
        if w.is_main || w.is_bare || w.locked || w.prunable || is_current(w, current) {
            continue;
        }
        let Some(branch) = &w.branch else { continue };
        if !merged(cwd, &w.head, &default) {
            continue;
        }
        match git::status_of(&w.path) {
            Ok(st) if st.dirty == 0 => candidates.push(w),
            Ok(st) => output::info(&format!(
                "skipped {} ({branch}): {} dirty",
                output::display_path(&w.path, cwd),
                st.dirty
            )),
            Err(_) => continue,
        }
    }

    if candidates.is_empty() {
        output::info("nothing to prune");
        return Ok(());
    }

    for w in &candidates {
        println!(
            "would remove {} ({})",
            output::display_path(&w.path, cwd),
            w.branch.as_deref().unwrap_or("detached")
        );
    }
    if dry_run {
        return Ok(());
    }
    if !yes && !confirm(candidates.len())? {
        return Ok(());
    }

    for w in &candidates {
        remove_one(cwd, w, false)?;
    }
    git::run(cwd, &["worktree", "prune"])?;
    output::success(&format!(
        "pruned {} {}",
        candidates.len(),
        worktree_noun(candidates.len())
    ));
    Ok(())
}

fn confirm(n: usize) -> Result<bool, WdError> {
    if !io::stdin().is_terminal() {
        return Err(WdError::Msg(
            "not a terminal; run with --yes to remove".into(),
        ));
    }
    print!("remove {n} {}? [y/N] ", worktree_noun(n));
    io::stdout().flush()?;
    let mut line = String::new();
    io::stdin().lock().read_line(&mut line)?;
    let ans = line.trim().to_lowercase();
    if ans == "y" || ans == "yes" {
        Ok(true)
    } else {
        output::info("aborted");
        Ok(false)
    }
}

fn remove_named(
    name: &str,
    force: bool,
    dry_run: bool,
    wts: &[git::Worktree],
    cwd: &Path,
    current: Option<&Path>,
) -> Result<(), WdError> {
    let matches_dir = |p: &PathBuf| p.file_name().is_some_and(|f| f == name);
    let w = wts
        .iter()
        .find(|w| w.branch.as_deref() == Some(name) || matches_dir(&w.path))
        .ok_or_else(|| WdError::Msg(format!("no worktree for {name}")))?;

    if w.is_main || w.is_bare {
        return Err(WdError::Msg("refusing to remove the main worktree".into()));
    }
    if is_current(w, current) {
        return Err(WdError::Msg(
            "refusing to remove the current worktree".into(),
        ));
    }
    if w.locked {
        return Err(WdError::Msg(format!(
            "{} is locked",
            output::display_path(&w.path, cwd)
        )));
    }

    let dirty = git::status_of(&w.path).map(|s| s.dirty).unwrap_or(0);
    if !force {
        if dirty > 0 {
            return Err(WdError::Msg(format!(
                "{} is dirty (use --force)",
                output::display_path(&w.path, cwd)
            )));
        }
        match &w.branch {
            Some(b) => {
                let default = git::default_ref(cwd)?;
                if !merged(cwd, &w.head, &default) {
                    return Err(WdError::Msg(format!("{b} is not merged (use --force)")));
                }
            }
            None => {
                return Err(WdError::Msg("detached worktree (use --force)".into()));
            }
        }
    }

    if dry_run {
        println!(
            "would remove {} ({})",
            output::display_path(&w.path, cwd),
            w.branch.as_deref().unwrap_or("detached")
        );
        return Ok(());
    }

    remove_one(cwd, w, force)?;
    git::run(cwd, &["worktree", "prune"])?;
    Ok(())
}

fn remove_one(cwd: &Path, w: &git::Worktree, force: bool) -> Result<(), WdError> {
    // resolve the shown path while the dir still exists
    let shown = output::display_path(&w.path, cwd);
    let path_s = w.path.to_string_lossy().into_owned();
    if force {
        git::run(cwd, &["worktree", "remove", "--force", &path_s])?;
    } else {
        git::run(cwd, &["worktree", "remove", &path_s])?;
    }
    if let Some(b) = &w.branch {
        let flag = if force { "-D" } else { "-d" };
        if !git::run_ok(cwd, &["branch", flag, b]) && !force {
            // already verified merged against the default ref; git's own -d
            // check judges against HEAD/upstream and can disagree
            git::run(cwd, &["branch", "-D", b])?;
        }
    }
    println!(
        "removed {} ({})",
        shown,
        w.branch.as_deref().unwrap_or("detached")
    );
    Ok(())
}

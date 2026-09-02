use crate::{envfiles, git, naming, output, WhError};
use std::env;

pub fn run(branch: &str, from: Option<&str>) -> Result<(), WhError> {
    let cwd = env::current_dir()?;
    let main = git::main_worktree(&cwd)?;
    let dest = naming::sibling_path(&main, branch)?;
    if dest.exists() {
        return Err(WhError::Msg(format!(
            "{} already exists",
            output::display_path(&dest, &cwd)
        )));
    }

    let dest_s = dest.to_string_lossy().into_owned();
    let branch_ref = format!("refs/heads/{branch}");
    let exists = git::run_ok(&cwd, &["rev-parse", "--verify", "--quiet", &branch_ref]);
    let added = if exists {
        git::run(&cwd, &["worktree", "add", &dest_s, branch])
    } else {
        git::run(
            &cwd,
            &[
                "worktree",
                "add",
                "-b",
                branch,
                &dest_s,
                from.unwrap_or("HEAD"),
            ],
        )
    };
    if let Err(e) = added {
        if let WhError::Git { stderr } = &e {
            if stderr.contains("already checked out") || stderr.contains("already used by worktree")
            {
                let at = git::worktrees(&cwd)?
                    .into_iter()
                    .find(|w| w.branch.as_deref() == Some(branch))
                    .map(|w| output::display_path(&w.path, &cwd))
                    .unwrap_or_else(|| "another worktree".into());
                return Err(WhError::Msg(format!(
                    "{branch} already checked out at {at}"
                )));
            }
        }
        return Err(e);
    }

    println!("created worktree {}", output::display_path(&dest, &cwd));

    // env copy source is the worktree we're standing in (absent for bare repos)
    if let Ok(top) = git::toplevel(&cwd) {
        let copied = envfiles::copy_env_files(&top, &dest)?;
        if !copied.is_empty() {
            println!("copied {}", copied.join(" "));
        }
    }

    output::success(&format!("ready {branch} checked out"));
    Ok(())
}

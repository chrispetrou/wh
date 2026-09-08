use crate::commands::answer::answer;
use crate::{git, llm, output, preprocess, WhError};
use std::env;

pub fn run(
    range: Option<&str>,
    dry_run: bool,
    mode: llm::Mode,
    uncommitted: bool,
    chat: bool,
    paths: &[String],
) -> Result<(), WhError> {
    let cwd = env::current_dir()?;
    let describe = mode == llm::Mode::Describe;
    // a pr draft with no explicit range is judged against the default
    // branch; resolved only then, so every other call stays local to cwd.
    // uncommitted work has no base to speak of
    let base_default = if !uncommitted && describe && range.is_none_or(|r| !r.contains("..")) {
        git::default_ref(&cwd).map_err(|_| {
            WhError::Msg("cannot determine default branch, pass a range like main..".into())
        })?
    } else {
        String::new()
    };
    let ranges = normalize(range, &base_default, describe, uncommitted);
    let what = label(&ranges.source, paths);

    let diff = git::run(
        &cwd,
        &diff_args(&["--no-color", "--no-ext-diff"], &ranges, paths),
    )?;
    if diff.trim().is_empty() {
        return Err(WhError::Msg(if uncommitted {
            format!(
                "nothing uncommitted to explain{}\nuntracked files are not in a diff until you git add them",
                paths_suffix(paths)
            )
        } else {
            format!("nothing to explain in {what}")
        }));
    }
    let numstat = git::run(&cwd, &diff_args(&["--numstat"], &ranges, paths))?;
    // uncommitted work has no commits to list, so the payload carries no
    // `commits:` block (shared/prompts/preprocess.md)
    let commits = match &ranges.log {
        Some(r) => git::run(&cwd, &log_args(r, paths))?,
        None => String::new(),
    };

    let rules = preprocess::default_rules();
    let payload = preprocess::preprocess(&diff, &commits, &numstat, &Default::default(), &rules);

    if dry_run {
        print!("{payload}");
        return Ok(());
    }

    let n_commits = commits.lines().filter(|l| !l.trim().is_empty()).count();
    let (files, added, deleted) = preprocess::stats(&numstat);
    // the fancy minus and middle dot match the landing demo; ui only
    let head = if ranges.log.is_none() {
        what.clone()
    } else {
        format!(
            "{n_commits} {}",
            if n_commits == 1 { "commit" } else { "commits" }
        )
    };
    output::status(&format!(
        "reading {head} · {files} {} · +{added} \u{2212}{deleted}",
        if files == 1 { "file" } else { "files" },
    ));

    let mut tail = String::new();
    if describe {
        // the branch and its base, after the payload (shared/prompts/README.md)
        let head = ranges.head.clone().or_else(|| git::current_branch(&cwd));
        tail.push_str("\n\ncontext:\n");
        match (head, ranges.base.is_empty()) {
            (Some(h), true) => tail.push_str(&format!("branch {h}")),
            (Some(h), false) => tail.push_str(&format!("branch {h} into {}", ranges.base)),
            (None, _) => tail.push_str(&format!("into {}", ranges.base)),
        }
    }

    answer(&payload, mode, &tail, chat)
}

/// The args for one `git diff` call: the fixed flags, then whatever names
/// this diff (a range, or `HEAD` for uncommitted work), then the pathspec.
fn diff_args<'a>(extra: &[&'a str], ranges: &'a Ranges, paths: &'a [String]) -> Vec<&'a str> {
    let mut args = vec!["diff", "-M"];
    args.extend_from_slice(extra);
    args.push(&ranges.diff);
    push_paths(&mut args, paths);
    args
}

fn log_args<'a>(range: &'a str, paths: &'a [String]) -> Vec<&'a str> {
    let mut args = vec!["log", "--format=%h %s", range];
    push_paths(&mut args, paths);
    args
}

fn push_paths<'a>(args: &mut Vec<&'a str>, paths: &'a [String]) {
    if !paths.is_empty() {
        args.push("--");
        args.extend(paths.iter().map(String::as_str));
    }
}

fn paths_suffix(paths: &[String]) -> String {
    if paths.is_empty() {
        String::new()
    } else {
        format!(" under {}", paths.join(" "))
    }
}

/// What the status and error lines call this diff.
fn label(source: &str, paths: &[String]) -> String {
    format!("{source}{}", paths_suffix(paths))
}

/// The range as git diff and git log want it, plus its two sides for the
/// describe context. `A...B` stays three-dot for the diff (merge base) but
/// the log gets `A..B`: three-dot log is the symmetric difference.
struct Ranges {
    diff: String,
    /// None when there are no commits to list (uncommitted work)
    log: Option<String>,
    /// what the status and error lines call it
    source: String,
    base: String,
    head: Option<String>,
}

/// Default HEAD~1..; a bare ref becomes <ref>..HEAD. In describe mode the
/// default is <base_default>...HEAD and a bare ref becomes <ref>...HEAD.
/// Uncommitted work is `git diff HEAD`: staged and unstaged together.
fn normalize(range: Option<&str>, base_default: &str, describe: bool, uncommitted: bool) -> Ranges {
    if uncommitted {
        return Ranges {
            diff: "HEAD".to_string(),
            log: None,
            source: "uncommitted work".to_string(),
            base: String::new(),
            head: None,
        };
    }
    let (base, head) = match range {
        None if describe => (base_default.to_string(), "HEAD".to_string()),
        None => ("HEAD~1".to_string(), "HEAD".to_string()),
        Some(r) => match r.find("..") {
            Some(i) => {
                let rest = &r[i..];
                let dots = if rest.starts_with("...") { 3 } else { 2 };
                (r[..i].to_string(), r[i + dots..].to_string())
            }
            None => (r.to_string(), "HEAD".to_string()),
        },
    };
    // a typed range is passed on as written (git reads an empty side as
    // HEAD); only the log loses the third dot
    let (diff, log) = match range {
        Some(r) if r.contains("..") => (r.to_string(), r.replacen("...", "..", 1)),
        _ => (
            format!("{base}{}{head}", if describe { "..." } else { ".." }),
            format!("{base}..{head}"),
        ),
    };
    let head = Some(head).filter(|h| !h.is_empty() && h != "HEAD");
    Ranges {
        source: diff.clone(),
        diff,
        log: Some(log),
        base,
        head,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn n(range: Option<&str>, describe: bool) -> (String, String, String, Option<String>) {
        let r = normalize(range, "main", describe, false);
        (r.diff, r.log.unwrap_or_default(), r.base, r.head)
    }

    #[test]
    fn normalizes_ranges() {
        assert_eq!(n(None, false).0, "HEAD~1..HEAD");
        assert_eq!(n(None, false).1, "HEAD~1..HEAD");
        assert_eq!(n(Some("main..dev"), false).0, "main..dev");
        assert_eq!(n(Some("main..dev"), false).3.as_deref(), Some("dev"));
        assert_eq!(n(Some("HEAD~3.."), false).0, "HEAD~3..");
        assert_eq!(n(Some("HEAD~3.."), false).3, None);
        assert_eq!(n(Some("main"), false).0, "main..HEAD");
    }

    #[test]
    fn three_dot_diff_keeps_the_merge_base_and_the_log_drops_it() {
        let (diff, log, base, head) = n(Some("main...dev"), false);
        assert_eq!(diff, "main...dev");
        assert_eq!(log, "main..dev");
        assert_eq!(base, "main");
        assert_eq!(head.as_deref(), Some("dev"));
    }

    #[test]
    fn describe_defaults_to_the_default_branch() {
        let (diff, log, base, head) = n(None, true);
        assert_eq!(diff, "main...HEAD");
        assert_eq!(log, "main..HEAD");
        assert_eq!(base, "main");
        assert_eq!(head, None);
        let (diff, log, _, _) = n(Some("dev"), true);
        assert_eq!(diff, "dev...HEAD");
        assert_eq!(log, "dev..HEAD");
        // an explicit two-dot range is taken as written
        assert_eq!(n(Some("HEAD~3.."), true).0, "HEAD~3..");
    }

    #[test]
    fn uncommitted_work_is_git_diff_head_and_lists_no_commits() {
        let r = normalize(None, "main", false, true);
        assert_eq!(r.diff, "HEAD");
        assert_eq!(r.log, None);
        assert_eq!(r.source, "uncommitted work");
        assert_eq!(r.base, "");
    }

    #[test]
    fn a_pathspec_follows_a_double_dash() {
        let r = normalize(Some("main..dev"), "main", false, false);
        let paths = vec!["src/".to_string(), "docs/".to_string()];
        assert_eq!(
            diff_args(&["--numstat"], &r, &paths),
            vec![
                "diff",
                "-M",
                "--numstat",
                "main..dev",
                "--",
                "src/",
                "docs/"
            ]
        );
        assert_eq!(
            diff_args(&["--numstat"], &r, &[]),
            vec!["diff", "-M", "--numstat", "main..dev"]
        );
        assert_eq!(
            log_args("main..dev", &paths),
            vec!["log", "--format=%h %s", "main..dev", "--", "src/", "docs/"]
        );
    }

    #[test]
    fn the_label_names_the_pathspec() {
        assert_eq!(label("main..dev", &[]), "main..dev");
        assert_eq!(
            label("main..dev", &["src/".to_string()]),
            "main..dev under src/"
        );
        assert_eq!(
            label("uncommitted work", &["a".to_string(), "b".to_string()]),
            "uncommitted work under a b"
        );
    }
}

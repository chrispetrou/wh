use crate::commands::answer::answer;
use crate::{git, llm, output, preprocess, WhError};
use std::env;

pub fn run(target: &str, dry_run: bool, chat: bool) -> Result<(), WhError> {
    let cwd = env::current_dir()?;
    let (path, first, last) = parse_target(target)?;
    // git's own words carry the file's length and a missing path
    let b = git::blame(&cwd, path, first, last)?;
    // any uncommitted line in the span, not just the first: the rest of
    // the answer would be about a commit that never saw it
    if b.uncommitted {
        return Err(WhError::Msg(format!(
            "{target} is not committed yet\ncommit or stash it first"
        )));
    }
    if b.sha.is_empty() {
        return Err(WhError::Msg(format!("no blame for {path}")));
    }
    let meta = git::commit_meta(&cwd, &b.sha)?;

    // the blaming commit, cut to the file. `git show` covers the root
    // commit too, where <sha>~1 does not resolve; -m --first-parent makes
    // a merge commit show a diff instead of nothing
    let show = |extra: &[&str]| -> Vec<String> {
        let mut a = vec![
            "show".to_string(),
            "--format=".to_string(),
            "-M".to_string(),
            "-m".to_string(),
            "--first-parent".to_string(),
        ];
        a.extend(extra.iter().map(|s| s.to_string()));
        a.push(b.sha.clone());
        a.push("--".to_string());
        // blame follows renames, `git show -- <path>` does not, so ask
        // for the name the file had in that commit
        a.push(b.path.clone());
        a
    };
    let diff_args = show(&["--no-color", "--no-ext-diff"]);
    let numstat_args = show(&["--numstat"]);
    let diff = git::run(&cwd, &as_str(&diff_args))?;
    if diff.trim().is_empty() {
        return Err(WhError::Msg(format!(
            "{} changed nothing in {}",
            meta.short, b.path
        )));
    }
    let numstat = git::run(&cwd, &as_str(&numstat_args))?;
    let commits = format!("{} {}", meta.short, meta.subject);

    let rules = preprocess::default_rules();
    let payload = preprocess::preprocess(&diff, &commits, &numstat, &Default::default(), &rules);

    if dry_run {
        print!("{payload}");
        return Ok(());
    }

    let span = span_label(first, last);
    let mut status = format!(
        "reading {path}:{span} · last changed in {} by {} on {}",
        meta.short, meta.author, meta.date
    );
    if b.others > 0 {
        status.push_str(&format!(
            " · {} more {}",
            b.others,
            if b.others == 1 {
                "commit touches it"
            } else {
                "commits touch it"
            }
        ));
    }
    output::status(&status);

    // the line itself, after the payload (shared/prompts/README.md)
    let tail = format!(
        "\n\nthe {} in question, {path}:{span}:\n{}",
        if first == last { "line" } else { "lines" },
        b.lines.join("\n")
    );
    answer(&payload, llm::Mode::Why, &tail, chat)
}

fn as_str(v: &[String]) -> Vec<&str> {
    v.iter().map(String::as_str).collect()
}

fn span_label(first: u32, last: u32) -> String {
    if first == last {
        first.to_string()
    } else {
        format!("{first}-{last}")
    }
}

/// `src/main.rs:42` or `src/main.rs:13-17`. Splits on the last colon, so
/// a path may contain one.
fn parse_target(s: &str) -> Result<(&str, u32, u32), WhError> {
    let bad = || WhError::Msg("expected <path>:<line>, like src/main.rs:42".to_string());
    let (path, span) = s.rsplit_once(':').ok_or_else(bad)?;
    if path.is_empty() {
        return Err(bad());
    }
    let (a, b) = match span.split_once('-') {
        Some((a, b)) => (a, b),
        None => (span, span),
    };
    let first: u32 = a.parse().map_err(|_| bad())?;
    let last: u32 = b.parse().map_err(|_| bad())?;
    if first == 0 || last < first {
        return Err(bad());
    }
    Ok((path, first, last))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(s: &str) -> Option<(String, u32, u32)> {
        parse_target(s).ok().map(|(a, b, c)| (a.to_string(), b, c))
    }

    #[test]
    fn parses_a_line_and_a_span() {
        assert_eq!(p("src/main.rs:42"), Some(("src/main.rs".into(), 42, 42)));
        assert_eq!(p("src/x.rs:13-17"), Some(("src/x.rs".into(), 13, 17)));
        // the last colon wins, so a path may carry one
        assert_eq!(p("a:b:12"), Some(("a:b".into(), 12, 12)));
    }

    #[test]
    fn refuses_a_malformed_target() {
        for bad in [
            "src/main.rs",
            ":42",
            "src/main.rs:",
            "src/main.rs:abc",
            "src/main.rs:0",
            "src/main.rs:17-13",
        ] {
            assert!(p(bad).is_none(), "{bad} should not parse");
        }
    }

    #[test]
    fn labels_a_span() {
        assert_eq!(span_label(42, 42), "42");
        assert_eq!(span_label(13, 17), "13-17");
    }
}

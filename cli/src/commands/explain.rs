use crate::{git, llm, output, preprocess, usage, WhError};
use std::env;
use std::io::Write;
use std::time::Instant;

pub fn run(range: Option<&str>, dry_run: bool, mode: llm::Mode) -> Result<(), WhError> {
    let cwd = env::current_dir()?;
    let describe = mode == llm::Mode::Describe;
    // a pr draft with no explicit range is judged against the default
    // branch; resolved only then, so every other call stays local to cwd
    let base_default = if describe && range.is_none_or(|r| !r.contains("..")) {
        git::default_ref(&cwd).map_err(|_| {
            WhError::Msg("cannot determine default branch, pass a range like main..".into())
        })?
    } else {
        String::new()
    };
    let ranges = normalize(range, &base_default, describe);

    let diff = git::run(
        &cwd,
        &["diff", "-M", "--no-color", "--no-ext-diff", &ranges.diff],
    )?;
    if diff.trim().is_empty() {
        return Err(WhError::Msg(format!(
            "nothing to explain in {}",
            ranges.diff
        )));
    }
    let numstat = git::run(&cwd, &["diff", "-M", "--numstat", &ranges.diff])?;
    let commits = git::run(&cwd, &["log", "--format=%h %s", &ranges.log])?;

    let rules = preprocess::default_rules();
    let payload = preprocess::preprocess(&diff, &commits, &numstat, &Default::default(), &rules);

    if dry_run {
        print!("{payload}");
        return Ok(());
    }

    let n_commits = commits.lines().filter(|l| !l.trim().is_empty()).count();
    let (files, added, deleted) = preprocess::stats(&numstat);
    // the fancy minus and middle dot match the landing demo; ui only
    output::status(&format!(
        "reading {n_commits} {} · {files} {} · +{added} \u{2212}{deleted}",
        if n_commits == 1 { "commit" } else { "commits" },
        if files == 1 { "file" } else { "files" },
    ));

    let getenv = |k: &str| env::var(k).ok();
    let provider = llm::choose(&getenv)?;
    let model = llm::model_for(&provider, &getenv);
    let (system, mut user) = llm::prompt(&payload, mode);
    if describe {
        // the branch and its base, after the payload (shared/prompts/README.md)
        let head = ranges.head.clone().or_else(|| git::current_branch(&cwd));
        user.push_str("\n\ncontext:\n");
        match head {
            Some(h) => user.push_str(&format!("branch {h} into {}", ranges.base)),
            None => user.push_str(&format!("into {}", ranges.base)),
        }
    }

    let mut printer = LinePrinter::new(output::color());
    let started = Instant::now();
    let res = llm::stream(&provider, &model, &system, &user, &mut |chunk| {
        printer.push(chunk)
    });
    // whatever arrived is shown before an error is
    printer.finish();
    let reply = res?;

    // the closing line: elapsed, model, and the tokens when the provider
    // said (shared/prompts/provider.md, "lines")
    let mut closing = format!("· {:.1}s · {model}", started.elapsed().as_secs_f64());
    if let Some(u) = reply.usage {
        closing.push_str(&format!(
            " · {} in · {} out",
            usage::fmt_tokens(u.input),
            usage::fmt_tokens(u.output)
        ));
    }
    output::status(&closing);
    let anthropic = matches!(provider, llm::Provider::Anthropic { .. });
    if let Some(h) = usage::headroom(&reply.head, anthropic) {
        if let Some(line) = usage::low_line(provider.name(), &h) {
            output::warn(&line);
        }
    }
    Ok(())
}

/// The range as git diff and git log want it, plus its two sides for the
/// describe context. `A...B` stays three-dot for the diff (merge base) but
/// the log gets `A..B`: three-dot log is the symmetric difference.
struct Ranges {
    diff: String,
    log: String,
    base: String,
    head: Option<String>,
}

/// Default HEAD~1..; a bare ref becomes <ref>..HEAD. In describe mode the
/// default is <base_default>...HEAD and a bare ref becomes <ref>...HEAD.
fn normalize(range: Option<&str>, base_default: &str, describe: bool) -> Ranges {
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
        diff,
        log,
        base,
        head,
    }
}

/// The section labels of the three output contracts (review, changelog,
/// describe).
const LABELS: [&str; 9] = [
    "summary",
    "watch out",
    "added",
    "changed",
    "fixed",
    "removed",
    "title",
    "description",
    "testing",
];

/// Streams chunks to stdout line by line, painting the contract's section
/// labels amber like the landing demo.
struct LinePrinter {
    buf: String,
    colored: bool,
}

impl LinePrinter {
    fn new(colored: bool) -> Self {
        LinePrinter {
            buf: String::new(),
            colored,
        }
    }

    fn push(&mut self, chunk: &str) {
        for c in chunk.chars() {
            if c == '\n' {
                let line = std::mem::take(&mut self.buf);
                println!("{}", self.paint(&line));
            } else {
                self.buf.push(c);
            }
        }
    }

    fn paint(&self, line: &str) -> String {
        if self.colored && LABELS.contains(&line.trim_end()) {
            format!("\x1b[33m{line}\x1b[0m")
        } else {
            line.to_string()
        }
    }

    fn finish(&mut self) {
        if !self.buf.is_empty() {
            let line = std::mem::take(&mut self.buf);
            println!("{}", self.paint(&line));
        }
        let _ = std::io::stdout().flush();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn n(range: Option<&str>, describe: bool) -> (String, String, String, Option<String>) {
        let r = normalize(range, "main", describe);
        (r.diff, r.log, r.base, r.head)
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
}

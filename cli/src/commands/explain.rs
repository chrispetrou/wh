use crate::{git, llm, output, preprocess, WdError};
use std::env;
use std::io::Write;

pub fn run(range: Option<&str>, dry_run: bool, changelog: bool) -> Result<(), WdError> {
    let cwd = env::current_dir()?;
    let range = normalize(range);

    let diff = git::run(&cwd, &["diff", "-M", "--no-color", "--no-ext-diff", &range])?;
    if diff.trim().is_empty() {
        return Err(WdError::Msg(format!("nothing to explain in {range}")));
    }
    let numstat = git::run(&cwd, &["diff", "-M", "--numstat", &range])?;
    let commits = git::run(&cwd, &["log", "--format=%h %s", &range])?;

    let rules = preprocess::default_rules();
    let payload = preprocess::preprocess(&diff, &commits, &numstat, &Default::default(), &rules);

    if dry_run {
        print!("{payload}");
        return Ok(());
    }

    let n_commits = commits.lines().filter(|l| !l.trim().is_empty()).count();
    let (files, added, deleted) = preprocess::stats(&numstat);
    // the fancy minus and middle dot match the landing demo; ui only
    output::info(&format!(
        "reading {n_commits} {} · {files} {} · +{added} \u{2212}{deleted}",
        if n_commits == 1 { "commit" } else { "commits" },
        if files == 1 { "file" } else { "files" },
    ));

    let getenv = |k: &str| env::var(k).ok();
    let provider = llm::choose(&getenv)?;
    let model = llm::model_for(&provider, &getenv);
    let (system, user) = llm::prompt(&payload, changelog);

    let mut printer = LinePrinter::new(output::color());
    llm::stream(&provider, &model, &system, &user, &mut |chunk| {
        printer.push(chunk)
    })?;
    printer.finish();
    Ok(())
}

/// Default HEAD~1..; a bare ref becomes <ref>..HEAD.
fn normalize(range: Option<&str>) -> String {
    match range {
        None => "HEAD~1..HEAD".to_string(),
        Some(r) if r.contains("..") => r.to_string(),
        Some(r) => format!("{r}..HEAD"),
    }
}

/// The section labels of both output contracts (review and changelog).
const LABELS: [&str; 6] = [
    "summary",
    "watch out",
    "added",
    "changed",
    "fixed",
    "removed",
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

    #[test]
    fn normalizes_ranges() {
        assert_eq!(normalize(None), "HEAD~1..HEAD");
        assert_eq!(normalize(Some("main..dev")), "main..dev");
        assert_eq!(normalize(Some("HEAD~3..")), "HEAD~3..");
        assert_eq!(normalize(Some("main")), "main..HEAD");
    }
}

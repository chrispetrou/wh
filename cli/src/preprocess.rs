//! Rust implementation of shared/prompts/preprocess.md. Must reproduce
//! shared/fixtures/explain/*/expected.txt byte for byte; the TS twin in
//! web/ follows the same spec.

pub struct Caps {
    pub per_file: usize,
    pub total: usize,
}

impl Default for Caps {
    fn default() -> Self {
        Caps {
            per_file: 400,
            total: 4000,
        }
    }
}

pub enum Matcher {
    Name,
    Segment,
    Suffix,
}

pub struct Rule {
    pub kind: String,
    pub matcher: Matcher,
    pub value: String,
}

pub fn default_rules() -> Vec<Rule> {
    parse_rules(include_str!("../../shared/prompts/exclude.txt"))
}

pub fn parse_rules(s: &str) -> Vec<Rule> {
    s.lines()
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .filter_map(|l| {
            let mut it = l.split('\t');
            let kind = it.next()?.to_string();
            let matcher = match it.next()? {
                "name" => Matcher::Name,
                "segment" => Matcher::Segment,
                "suffix" => Matcher::Suffix,
                _ => return None,
            };
            let value = it.next()?.to_string();
            Some(Rule {
                kind,
                matcher,
                value,
            })
        })
        .collect()
}

pub fn classify<'a>(path: &str, rules: &'a [Rule]) -> Option<&'a str> {
    let segs: Vec<&str> = path.split('/').collect();
    for r in rules {
        let hit = match r.matcher {
            Matcher::Name => segs.last() == Some(&r.value.as_str()),
            Matcher::Segment => segs.contains(&r.value.as_str()),
            Matcher::Suffix => path.ends_with(&r.value),
        };
        if hit {
            return Some(&r.kind);
        }
    }
    None
}

/// (files, added, deleted) from numstat text; binary `-` columns count 0.
pub fn stats(numstat: &str) -> (usize, u64, u64) {
    let mut n = 0;
    let mut a = 0;
    let mut d = 0;
    for l in numstat.lines().filter(|l| !l.trim().is_empty()) {
        let mut it = l.splitn(3, '\t');
        let add = it.next().unwrap_or("-");
        let del = it.next().unwrap_or("-");
        n += 1;
        a += add.parse::<u64>().unwrap_or(0);
        d += del.parse::<u64>().unwrap_or(0);
    }
    (n, a, d)
}

pub fn preprocess(diff: &str, commits: &str, numstat: &str, caps: &Caps, rules: &[Rule]) -> String {
    let mut out: Vec<String> = Vec::new();

    let commit_lines: Vec<&str> = commits.lines().filter(|l| !l.trim().is_empty()).collect();
    if !commit_lines.is_empty() {
        out.push(format!("commits: {}", commit_lines.len()));
        for c in &commit_lines {
            out.push(format!("- {c}"));
        }
    }

    let (n, a, d) = stats(numstat);
    out.push(format!("files: {n} (+{a} -{d})"));

    // split into file sections
    let mut sections: Vec<Vec<&str>> = Vec::new();
    for line in diff.lines() {
        if line.starts_with("diff --git ") {
            sections.push(vec![line]);
        } else if let Some(cur) = sections.last_mut() {
            cur.push(line);
        }
    }

    let mut kept: Vec<(String, Vec<&str>)> = Vec::new();
    let mut excluded: Vec<(String, String)> = Vec::new();
    for sec in sections {
        let header = sec[0];
        let path = match header.rfind(" b/") {
            Some(i) => header[i + 3..].to_string(),
            None => header.to_string(),
        };
        let binary = sec
            .iter()
            .any(|l| l.starts_with("Binary files ") || l.starts_with("GIT binary patch"));
        let reason = if binary {
            Some("binary")
        } else {
            classify(&path, rules)
        };
        match reason {
            Some(r) => excluded.push((path, r.to_string())),
            None => kept.push((path, sec)),
        }
    }
    if !excluded.is_empty() {
        excluded.sort();
        out.push("excluded:".to_string());
        for (path, reason) in &excluded {
            out.push(format!("- {path} ({reason})"));
        }
    }
    out.push("---".to_string());

    kept.sort_by(|x, y| x.0.cmp(&y.0));
    let mut total = 0usize;
    for (path, sec) in kept {
        let mut lines: Vec<String> = sec.iter().map(|l| l.to_string()).collect();
        if lines.len() > caps.per_file {
            let dropped = lines.len() - caps.per_file;
            lines.truncate(caps.per_file);
            lines.push(format!("... truncated ({dropped} more lines)"));
        }
        if total + lines.len() > caps.total {
            out.push(format!("... omitted {path} (size cap)"));
            total += 1;
            continue;
        }
        total += lines.len();
        out.extend(lines);
    }

    let mut s = out.join("\n");
    s.push('\n');
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;

    #[test]
    fn classifies_paths() {
        let rules = default_rules();
        assert_eq!(classify("Cargo.lock", &rules), Some("lockfile"));
        assert_eq!(classify("web/package-lock.json", &rules), Some("lockfile"));
        assert_eq!(classify("a/node_modules/b/c.js", &rules), Some("vendored"));
        assert_eq!(classify("dist/app.min.js", &rules), Some("minified"));
        assert_eq!(classify("dist/app.js.map", &rules), Some("generated"));
        assert_eq!(classify("src/main.rs", &rules), None);
        // "vendor" must match a segment, not a substring
        assert_eq!(classify("src/vendors.rs", &rules), None);
    }

    #[test]
    fn stats_handles_binary_columns() {
        assert_eq!(stats("1\t2\ta.txt\n-\t-\tb.png\n"), (2, 1, 2));
        assert_eq!(stats(""), (0, 0, 0));
    }

    #[test]
    fn reproduces_golden_fixtures() {
        let base = Path::new(env!("CARGO_MANIFEST_DIR")).join("../shared/fixtures/explain");
        let rules = default_rules();
        let mut cases = 0;
        let mut dirs: Vec<_> = fs::read_dir(&base)
            .expect("fixtures dir")
            .filter_map(|e| e.ok())
            .filter(|e| e.path().is_dir())
            .map(|e| e.path())
            .collect();
        dirs.sort();
        for dir in dirs {
            let read = |name: &str| fs::read_to_string(dir.join(name)).unwrap_or_default();
            let mut caps = Caps::default();
            for l in read("params.txt").lines() {
                if let Some((k, v)) = l.split_once('=') {
                    match k {
                        "per_file_cap" => caps.per_file = v.trim().parse().unwrap(),
                        "total_cap" => caps.total = v.trim().parse().unwrap(),
                        _ => {}
                    }
                }
            }
            let got = preprocess(
                &read("input.diff"),
                &read("input.commits"),
                &read("input.numstat"),
                &caps,
                &rules,
            );
            let want = read("expected.txt");
            assert_eq!(got, want, "fixture {} mismatch", dir.display());
            cases += 1;
        }
        assert!(cases >= 4, "expected at least 4 fixtures, found {cases}");
    }
}

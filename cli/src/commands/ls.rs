use crate::{git, output, WhError};
use serde_json::{json, Value};
use std::env;
use std::path::{Path, PathBuf};

#[derive(Default)]
pub struct Row {
    pub name: String,
    pub status: String,
    pub extra: String,
    pub path: PathBuf,
    pub branch: Option<String>,
    pub head: String,
    pub is_main: bool,
    pub locked: bool,
    /// None when stale: git can no longer read the worktree
    pub dirty: Option<usize>,
    /// None without an upstream
    pub ahead_behind: Option<(usize, usize)>,
}

pub fn run(json: bool) -> Result<(), WhError> {
    let cwd = env::current_dir()?;
    let rows = collect_rows(&cwd)?;
    if json {
        println!("{}", render_json(&rows));
        return Ok(());
    }
    for line in render(&rows, output::color()) {
        println!("{line}");
    }
    Ok(())
}

/// Worktree rows with status columns, main first then alphabetical.
/// Shared by `wh ls` and the `wh switch` picker.
pub fn collect_rows(cwd: &Path) -> Result<Vec<Row>, WhError> {
    let wts = git::worktrees(cwd)?;
    let mut list: Vec<&git::Worktree> = wts.iter().filter(|w| !w.is_bare).collect();
    list.sort_by_key(|w| (!w.is_main, name_of(w)));
    Ok(list.into_iter().map(row_of).collect())
}

fn row_of(w: &git::Worktree) -> Row {
    let st = if w.prunable {
        None
    } else {
        git::status_of(&w.path).ok()
    };
    let (status, extra) = status_words(st.as_ref());
    Row {
        name: name_of(w),
        status,
        extra,
        path: w.path.clone(),
        branch: w.branch.clone(),
        head: w.head.clone(),
        is_main: w.is_main,
        locked: w.locked,
        dirty: st.as_ref().map(|s| s.dirty),
        ahead_behind: st.and_then(|s| s.ahead_behind),
    }
}

fn name_of(w: &git::Worktree) -> String {
    match &w.branch {
        Some(b) => b.clone(),
        None => format!("{} detached", &w.head[..w.head.len().min(7)]),
    }
}

fn status_words(st: Option<&git::WtStatus>) -> (String, String) {
    let Some(st) = st else {
        return ("stale".into(), String::new());
    };
    let status = if st.dirty == 0 {
        "clean".to_string()
    } else {
        format!("{} dirty", st.dirty)
    };
    let extra = match st.ahead_behind {
        None | Some((0, 0)) => String::new(),
        Some((a, 0)) => format!("ahead {a}"),
        Some((0, b)) => format!("behind {b}"),
        Some((a, b)) => format!("ahead {a} behind {b}"),
    };
    (status, extra)
}

pub fn render(rows: &[Row], colored: bool) -> Vec<String> {
    let w1 = rows.iter().map(|r| r.name.len()).max().unwrap_or(0) + 2;
    let w2 = rows.iter().map(|r| r.status.len()).max().unwrap_or(0) + 2;
    rows.iter()
        .map(|r| {
            if r.extra.is_empty() {
                format!("{:<w1$}{}", r.name, r.status)
            } else {
                let extra = format!("·  {}", r.extra);
                let extra = if colored {
                    format!("\x1b[2m{extra}\x1b[0m")
                } else {
                    extra
                };
                format!("{:<w1$}{:<w2$}{}", r.name, r.status, extra)
            }
        })
        .collect()
}

/// `wh ls --json`: one compact array in table order. `dirty` is null for
/// a stale worktree and `ahead`/`behind` null without an upstream, so 0
/// always means a real zero.
pub fn render_json(rows: &[Row]) -> String {
    let list = rows
        .iter()
        .map(|r| {
            json!({
                "name": r.name,
                "branch": r.branch,
                "head": r.head,
                "path": r.path.to_string_lossy(),
                "main": r.is_main,
                "locked": r.locked,
                "stale": r.dirty.is_none(),
                "dirty": r.dirty,
                "ahead": r.ahead_behind.map(|(a, _)| a),
                "behind": r.ahead_behind.map(|(_, b)| b),
            })
        })
        .collect();
    Value::Array(list).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(name: &str, status: &str, extra: &str) -> Row {
        Row {
            name: name.into(),
            status: status.into(),
            extra: extra.into(),
            ..Default::default()
        }
    }

    #[test]
    fn aligns_columns_like_the_mock() {
        let rows = vec![
            row("main", "clean", ""),
            row("fix/nav-323", "2 dirty", "ahead 3"),
            row("spike/wasm", "clean", "behind 12"),
        ];
        let lines = render(&rows, false);
        assert_eq!(lines[0], "main         clean");
        assert_eq!(lines[1], "fix/nav-323  2 dirty  ·  ahead 3");
        assert_eq!(lines[2], "spike/wasm   clean    ·  behind 12");
    }

    #[test]
    fn no_trailing_spaces_without_extra() {
        let lines = render(&[row("main", "clean", "")], false);
        assert_eq!(lines[0], "main  clean");
    }

    #[test]
    fn json_keeps_null_apart_from_zero() {
        let rows = vec![
            Row {
                name: "main".into(),
                branch: Some("main".into()),
                head: "68d394f".into(),
                path: PathBuf::from("/h/repo"),
                is_main: true,
                dirty: Some(0),
                ahead_behind: Some((0, 0)),
                ..Default::default()
            },
            Row {
                name: "68d394f detached".into(),
                path: PathBuf::from("/h/repo.det"),
                ..Default::default()
            },
        ];
        let v: Value = serde_json::from_str(&render_json(&rows)).unwrap();
        assert_eq!(v[0]["path"], "/h/repo");
        assert_eq!(v[0]["main"], true);
        assert_eq!(v[0]["stale"], false);
        assert_eq!(v[0]["dirty"], 0);
        assert_eq!(v[0]["ahead"], 0);
        assert_eq!(v[0]["behind"], 0);
        assert!(v[1]["branch"].is_null());
        assert!(v[1]["dirty"].is_null());
        assert!(v[1]["ahead"].is_null());
        assert_eq!(v[1]["stale"], true);
    }
}

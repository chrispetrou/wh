mod common;

use common::TestRepo;
use predicates::prelude::*;

#[test]
fn single_main_clean() {
    let t = TestRepo::new();
    t.commit("init");
    t.wh()
        .arg("ls")
        .assert()
        .success()
        .stdout(predicate::str::contains("main  clean"));
}

#[test]
fn counts_dirty_files() {
    let t = TestRepo::new();
    t.write("a.txt", "1");
    t.commit("init");
    t.write("a.txt", "changed");
    t.write("b.txt", "untracked");
    t.wh()
        .arg("ls")
        .assert()
        .success()
        .stdout(predicate::str::contains("2 dirty"));
}

#[test]
fn no_upstream_no_segment() {
    let t = TestRepo::new();
    t.commit("init");
    t.wh()
        .arg("ls")
        .assert()
        .success()
        .stdout(predicate::str::contains("ahead").not())
        .stdout(predicate::str::contains("behind").not())
        .stdout(predicate::str::contains("·").not());
}

#[test]
fn shows_ahead_and_behind() {
    let t = TestRepo::new();
    t.write("a.txt", "1");
    t.commit("init");
    let clone = t.root.join("clone");
    t.git_in(&t.root, &["clone", "repo", "clone"]);
    t.configure_user(&clone);

    // one local commit -> ahead 1
    std::fs::write(clone.join("b.txt"), "x").unwrap();
    t.git_in(&clone, &["add", "-A"]);
    t.git_in(&clone, &["commit", "-m", "local"]);
    t.wh_in(&clone)
        .arg("ls")
        .assert()
        .success()
        .stdout(predicate::str::contains("·  ahead 1"));

    // origin gains a commit, fetched -> ahead 1 behind 1
    t.write("c.txt", "y");
    t.commit("remote");
    t.git_in(&clone, &["fetch", "origin"]);
    t.wh_in(&clone)
        .arg("ls")
        .assert()
        .success()
        .stdout(predicate::str::contains("·  ahead 1 behind 1"));
}

#[test]
fn detached_worktree_listed() {
    let t = TestRepo::new();
    t.commit("init");
    t.git(&["worktree", "add", "--detach", "../repo.det"]);
    t.wh()
        .arg("ls")
        .assert()
        .success()
        .stdout(predicate::str::contains("detached"));
}

#[test]
fn main_listed_first() {
    let t = TestRepo::new();
    t.commit("init");
    t.wh().args(["new", "aaa"]).assert().success();
    let out = t.wh().arg("ls").assert().success();
    let stdout = String::from_utf8(out.get_output().stdout.clone()).unwrap();
    let first = stdout.lines().next().unwrap();
    assert!(
        first.starts_with("main"),
        "expected main first, got: {first}"
    );
}

fn ls_json(t: &TestRepo) -> Vec<serde_json::Value> {
    let out = t.wh().args(["ls", "--json"]).assert().success();
    let v: serde_json::Value = serde_json::from_slice(&out.get_output().stdout).unwrap();
    v.as_array().unwrap().clone()
}

#[test]
fn json_lists_paths_and_counts() {
    let t = TestRepo::new();
    t.write("a.txt", "1");
    t.commit("init");
    t.wh().args(["new", "feat/auth"]).assert().success();
    t.write("a.txt", "changed");
    let rows = ls_json(&t);
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["name"], "main");
    assert_eq!(rows[0]["main"], true);
    assert_eq!(rows[0]["dirty"], 1);
    assert_eq!(rows[0]["path"], t.repo.to_str().unwrap());
    assert!(rows[0]["ahead"].is_null());
    assert_eq!(rows[1]["branch"], "feat/auth");
    assert_eq!(rows[1]["dirty"], 0);
    assert_eq!(
        rows[1]["path"],
        t.root.join("repo.feat-auth").to_str().unwrap()
    );
}

#[test]
fn json_detached_has_null_branch() {
    let t = TestRepo::new();
    t.commit("init");
    t.git(&["worktree", "add", "--detach", "../repo.det"]);
    let rows = ls_json(&t);
    let det = &rows[1];
    assert!(det["branch"].is_null());
    assert!(det["name"].as_str().unwrap().ends_with(" detached"));
    assert_eq!(det["head"].as_str().unwrap().len(), 40);
}

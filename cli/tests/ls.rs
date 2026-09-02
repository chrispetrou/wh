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

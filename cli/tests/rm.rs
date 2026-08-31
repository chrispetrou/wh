mod common;

use common::TestRepo;
use predicates::prelude::*;
use std::fs;
use std::path::Path;

fn commit_in(t: &TestRepo, wt: &Path, file: &str) {
    fs::write(wt.join(file), "x").unwrap();
    t.git_in(wt, &["add", "-A"]);
    t.git_in(wt, &["commit", "-m", "wt commit"]);
}

#[test]
fn prunes_merged_with_yes() {
    let t = TestRepo::new();
    t.commit("init");
    t.wd().args(["new", "feat/a"]).assert().success();
    t.wd()
        .args(["rm", "--yes"])
        .assert()
        .success()
        .stdout(predicate::str::contains("removed ../repo.feat-a (feat/a)"))
        .stdout(predicate::str::contains("→ pruned 1 worktree"));
    assert!(!t.root.join("repo.feat-a").exists());
    assert_eq!(t.git(&["branch", "--list", "feat/a"]), "");
}

#[test]
fn unmerged_kept() {
    let t = TestRepo::new();
    t.commit("init");
    t.wd().args(["new", "feat/b"]).assert().success();
    let wt = t.root.join("repo.feat-b");
    commit_in(&t, &wt, "new.txt");
    t.wd()
        .args(["rm", "--yes"])
        .assert()
        .success()
        .stdout(predicate::str::contains("nothing to prune"));
    assert!(wt.exists());
}

#[test]
fn prunes_squash_merged() {
    let t = TestRepo::new();
    t.commit("init");
    t.wd().args(["new", "feat/sq"]).assert().success();
    let wt = t.root.join("repo.feat-sq");
    commit_in(&t, &wt, "one.txt");
    commit_in(&t, &wt, "two.txt");
    t.git(&["merge", "--squash", "feat/sq"]);
    t.git(&["commit", "-m", "squash"]);
    t.wd()
        .args(["rm", "--yes"])
        .assert()
        .success()
        .stdout(predicate::str::contains(
            "removed ../repo.feat-sq (feat/sq)",
        ))
        .stdout(predicate::str::contains("→ pruned 1 worktree"));
    assert!(!wt.exists());
    assert_eq!(t.git(&["branch", "--list", "feat/sq"]), "");
}

#[test]
fn prunes_rebase_merged() {
    let t = TestRepo::new();
    t.commit("init");
    t.wd().args(["new", "feat/rb"]).assert().success();
    let wt = t.root.join("repo.feat-rb");
    commit_in(&t, &wt, "one.txt");
    let sha = t.git_in(&wt, &["rev-parse", "HEAD"]);
    t.commit("unrelated");
    t.git(&["cherry-pick", &sha]);
    t.wd()
        .args(["rm", "--yes"])
        .assert()
        .success()
        .stdout(predicate::str::contains("→ pruned 1 worktree"));
    assert!(!wt.exists());
}

#[test]
fn named_squash_merged_without_force() {
    let t = TestRepo::new();
    t.commit("init");
    t.wd().args(["new", "feat/sq"]).assert().success();
    let wt = t.root.join("repo.feat-sq");
    commit_in(&t, &wt, "one.txt");
    t.git(&["merge", "--squash", "feat/sq"]);
    t.git(&["commit", "-m", "squash"]);
    t.wd()
        .args(["rm", "feat/sq"])
        .assert()
        .success()
        .stdout(predicate::str::contains(
            "removed ../repo.feat-sq (feat/sq)",
        ));
    assert!(!wt.exists());
}

#[test]
fn dirty_merged_skipped() {
    let t = TestRepo::new();
    t.commit("init");
    t.wd().args(["new", "feat/c"]).assert().success();
    let wt = t.root.join("repo.feat-c");
    fs::write(wt.join("scratch.txt"), "wip").unwrap();
    t.wd()
        .args(["rm", "--yes"])
        .assert()
        .success()
        .stdout(predicate::str::contains(
            "skipped ../repo.feat-c (feat/c): 1 dirty",
        ))
        .stdout(predicate::str::contains("nothing to prune"));
    assert!(wt.exists());
}

#[test]
fn dry_run_inert() {
    let t = TestRepo::new();
    t.commit("init");
    t.wd().args(["new", "feat/a"]).assert().success();
    t.wd()
        .args(["rm", "--dry-run"])
        .assert()
        .success()
        .stdout(predicate::str::contains(
            "would remove ../repo.feat-a (feat/a)",
        ))
        .stdout(predicate::str::contains("removed ").not());
    assert!(t.root.join("repo.feat-a").exists());
}

#[test]
fn non_tty_without_yes_exits_1() {
    let t = TestRepo::new();
    t.commit("init");
    t.wd().args(["new", "feat/a"]).assert().success();
    t.wd()
        .arg("rm")
        .assert()
        .failure()
        .stderr(predicate::str::contains("--yes"));
    assert!(t.root.join("repo.feat-a").exists());
}

#[test]
fn named_removes_merged_without_prompt() {
    let t = TestRepo::new();
    t.commit("init");
    t.wd().args(["new", "feat/a"]).assert().success();
    t.wd()
        .args(["rm", "feat/a"])
        .assert()
        .success()
        .stdout(predicate::str::contains("removed ../repo.feat-a (feat/a)"));
    assert!(!t.root.join("repo.feat-a").exists());
}

#[test]
fn named_dirty_without_force_errors() {
    let t = TestRepo::new();
    t.commit("init");
    t.wd().args(["new", "feat/c"]).assert().success();
    fs::write(t.root.join("repo.feat-c/scratch.txt"), "wip").unwrap();
    t.wd()
        .args(["rm", "feat/c"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("dirty (use --force)"));
    assert!(t.root.join("repo.feat-c").exists());
}

#[test]
fn named_unmerged_without_force_errors() {
    let t = TestRepo::new();
    t.commit("init");
    t.wd().args(["new", "feat/b"]).assert().success();
    commit_in(&t, &t.root.join("repo.feat-b"), "new.txt");
    t.wd()
        .args(["rm", "feat/b"])
        .assert()
        .failure()
        .stderr(predicate::str::contains(
            "feat/b is not merged (use --force)",
        ));
}

#[test]
fn named_force_removes_dirty_and_unmerged() {
    let t = TestRepo::new();
    t.commit("init");
    t.wd().args(["new", "feat/d"]).assert().success();
    let wt = t.root.join("repo.feat-d");
    commit_in(&t, &wt, "new.txt");
    fs::write(wt.join("scratch.txt"), "wip").unwrap();
    t.wd()
        .args(["rm", "feat/d", "--force"])
        .assert()
        .success()
        .stdout(predicate::str::contains("removed ../repo.feat-d (feat/d)"));
    assert!(!wt.exists());
    assert_eq!(t.git(&["branch", "--list", "feat/d"]), "");
}

#[test]
fn refuses_main_worktree() {
    let t = TestRepo::new();
    t.commit("init");
    t.wd()
        .args(["rm", "main", "--force"])
        .assert()
        .failure()
        .stderr(predicate::str::contains(
            "refusing to remove the main worktree",
        ));
}

#[test]
fn refuses_current_worktree() {
    let t = TestRepo::new();
    t.commit("init");
    t.wd().args(["new", "feat/a"]).assert().success();
    t.wd_in(&t.root.join("repo.feat-a"))
        .args(["rm", "feat/a", "--force"])
        .assert()
        .failure()
        .stderr(predicate::str::contains(
            "refusing to remove the current worktree",
        ));
    assert!(t.root.join("repo.feat-a").exists());
}

#[test]
fn unknown_name_errors() {
    let t = TestRepo::new();
    t.commit("init");
    t.wd()
        .args(["rm", "nope"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("no worktree for nope"));
}

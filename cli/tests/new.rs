mod common;

use common::TestRepo;
use predicates::prelude::*;
use std::fs;

#[test]
fn creates_sibling_with_sanitized_name() {
    let t = TestRepo::new();
    t.write("a.txt", "hi");
    t.commit("init");
    t.wh()
        .args(["new", "feat/auth"])
        .assert()
        .success()
        .stdout(predicate::str::contains(
            "created worktree ../repo.feat-auth",
        ))
        .stdout(predicate::str::contains("→ ready feat/auth checked out"));
    let wt = t.root.join("repo.feat-auth");
    assert!(wt.is_dir());
    assert_eq!(
        t.git_in(&wt, &["rev-parse", "--abbrev-ref", "HEAD"]),
        "feat/auth"
    );
}

#[test]
fn reuses_existing_branch() {
    let t = TestRepo::new();
    t.write("a.txt", "1");
    t.commit("one");
    t.git(&["branch", "feat/x"]);
    t.write("a.txt", "2");
    t.commit("two");
    t.wh().args(["new", "feat/x"]).assert().success();
    let wt = t.root.join("repo.feat-x");
    let branch_sha = t.git(&["rev-parse", "feat/x"]);
    assert_eq!(t.git_in(&wt, &["rev-parse", "HEAD"]), branch_sha);
    assert_ne!(branch_sha, t.git(&["rev-parse", "main"]));
}

#[test]
fn from_ref_respected() {
    let t = TestRepo::new();
    t.commit("one");
    t.commit("two");
    let old = t.git(&["rev-parse", "main~1"]);
    t.wh()
        .args(["new", "feat/old", "--from", "main~1"])
        .assert()
        .success();
    assert_eq!(
        t.git_in(&t.root.join("repo.feat-old"), &["rev-parse", "HEAD"]),
        old
    );
}

#[test]
fn copies_env_files() {
    let t = TestRepo::new();
    t.write("a.txt", "hi");
    t.commit("init");
    // written after the commit, so untracked
    t.write(".env", "A=1");
    t.write(".env.local", "B=2");
    t.write(".envrc", "no");
    t.wh()
        .args(["new", "feat/auth"])
        .assert()
        .success()
        .stdout(predicate::str::contains("copied .env .env.local"));
    let wt = t.root.join("repo.feat-auth");
    assert!(wt.join(".env").exists());
    assert!(wt.join(".env.local").exists());
    assert!(!wt.join(".envrc").exists());
}

#[test]
fn no_env_no_copied_line() {
    let t = TestRepo::new();
    t.commit("init");
    t.wh()
        .args(["new", "feat/a"])
        .assert()
        .success()
        .stdout(predicate::str::contains("copied").not());
}

#[test]
fn tracked_env_file_not_clobbered() {
    let t = TestRepo::new();
    t.write(".env.example", "tracked");
    t.commit("init");
    t.write(".env", "A=1");
    t.wh()
        .args(["new", "feat/a"])
        .assert()
        .success()
        .stdout(predicate::str::contains("copied .env\n"));
    let wt = t.root.join("repo.feat-a");
    assert_eq!(
        fs::read_to_string(wt.join(".env.example")).unwrap(),
        "tracked"
    );
}

#[test]
fn existing_dir_errors() {
    let t = TestRepo::new();
    t.commit("init");
    fs::create_dir(t.root.join("repo.feat-auth")).unwrap();
    t.wh()
        .args(["new", "feat/auth"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("../repo.feat-auth already exists"));
}

#[test]
fn branch_checked_out_elsewhere() {
    let t = TestRepo::new();
    t.commit("init");
    t.git(&["worktree", "add", "-b", "feat/x", "../elsewhere"]);
    t.wh()
        .args(["new", "feat/x"])
        .assert()
        .failure()
        .stderr(predicate::str::contains(
            "feat/x already checked out at ../elsewhere",
        ));
}

#[test]
fn works_from_linked_worktree() {
    let t = TestRepo::new();
    t.commit("init");
    t.wh().args(["new", "feat/a"]).assert().success();
    t.wh_in(&t.root.join("repo.feat-a"))
        .args(["new", "feat/b"])
        .assert()
        .success()
        .stdout(predicate::str::contains("created worktree ../repo.feat-b"));
    assert!(t.root.join("repo.feat-b").is_dir());
}

#[cfg(unix)]
#[test]
fn unreadable_env_warns_but_succeeds() {
    use std::os::unix::fs::PermissionsExt;
    let t = TestRepo::new();
    t.commit("init");
    t.write(".env", "A=1");
    let env = t.repo.join(".env");
    fs::set_permissions(&env, fs::Permissions::from_mode(0o000)).unwrap();
    if fs::read(&env).is_ok() {
        return; // root reads it anyway: nothing to test
    }
    t.wh()
        .args(["new", "feat/a"])
        .assert()
        .success()
        .stdout(predicate::str::contains("→ ready feat/a checked out"))
        .stderr(predicate::str::contains("could not copy env files"));
    assert!(t.root.join("repo.feat-a").is_dir());
    fs::set_permissions(&env, fs::Permissions::from_mode(0o644)).unwrap();
}

mod common;

use common::TestRepo;
use predicates::prelude::*;

#[test]
fn unique_query_prints_path() {
    let t = TestRepo::new();
    t.commit("init");
    t.wd().args(["new", "feat/auth"]).assert().success();
    let wt = t.root.join("repo.feat-auth");
    t.wd()
        .args(["switch", "auth"])
        .assert()
        .success()
        .stdout(format!("{}\n", wt.display()))
        .stderr(predicate::str::contains("→ switched ../repo.feat-auth"));
}

#[test]
fn exact_match_beats_substring() {
    let t = TestRepo::new();
    t.commit("init");
    t.wd().args(["new", "maintenance"]).assert().success();
    t.wd()
        .args(["switch", "main"])
        .assert()
        .success()
        .stdout(format!("{}\n", t.repo.display()));
}

#[test]
fn ambiguous_query_lists_and_fails() {
    let t = TestRepo::new();
    t.commit("init");
    t.wd().args(["new", "feat/a"]).assert().success();
    t.wd().args(["new", "feat/b"]).assert().success();
    t.wd()
        .args(["switch", "feat"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("feat/a"))
        .stderr(predicate::str::contains("feat/b"))
        .stderr(predicate::str::contains("'feat' matches 2 worktrees"));
}

#[test]
fn no_match_fails() {
    let t = TestRepo::new();
    t.commit("init");
    t.wd()
        .args(["switch", "zzz"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("no worktree matches 'zzz'"));
}

#[test]
fn no_query_without_tty_fails() {
    let t = TestRepo::new();
    t.commit("init");
    t.wd()
        .arg("switch")
        .assert()
        .failure()
        .stderr(predicate::str::contains("pass a query"));
}

#[test]
fn init_zsh_and_bash_print_posix_wrapper() {
    let t = TestRepo::new();
    for shell in ["zsh", "bash"] {
        t.wd()
            .args(["init", shell])
            .assert()
            .success()
            .stdout(predicate::str::contains("wd() {"))
            .stdout(predicate::str::contains(r#"command wd "$@""#))
            .stdout(predicate::str::contains("cd \"$_wd_dir\""));
    }
}

#[test]
fn init_fish_prints_fish_wrapper() {
    let t = TestRepo::new();
    t.wd()
        .args(["init", "fish"])
        .assert()
        .success()
        .stdout(predicate::str::contains("function wd"))
        .stdout(predicate::str::contains("cd $_wd_dir"));
}

#[test]
fn init_unknown_shell_fails() {
    let t = TestRepo::new();
    t.wd()
        .args(["init", "powershell"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("unsupported shell 'powershell'"));
}

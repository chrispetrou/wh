mod common;

use common::TestRepo;
use predicates::prelude::*;

#[test]
fn unique_query_prints_path() {
    let t = TestRepo::new();
    t.commit("init");
    t.wh().args(["new", "feat/auth"]).assert().success();
    let wt = t.root.join("repo.feat-auth");
    t.wh()
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
    t.wh().args(["new", "maintenance"]).assert().success();
    t.wh()
        .args(["switch", "main"])
        .assert()
        .success()
        .stdout(format!("{}\n", t.repo.display()));
}

#[test]
fn ambiguous_query_lists_and_fails() {
    let t = TestRepo::new();
    t.commit("init");
    t.wh().args(["new", "feat/a"]).assert().success();
    t.wh().args(["new", "feat/b"]).assert().success();
    t.wh()
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
    t.wh()
        .args(["switch", "zzz"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("no worktree matches 'zzz'"));
}

#[test]
fn no_query_without_tty_fails() {
    let t = TestRepo::new();
    t.commit("init");
    t.wh()
        .arg("switch")
        .assert()
        .failure()
        .stderr(predicate::str::contains("pass a query"));
}

#[test]
fn init_zsh_and_bash_print_posix_wrapper() {
    let t = TestRepo::new();
    for shell in ["zsh", "bash"] {
        t.wh()
            .args(["init", shell])
            .assert()
            .success()
            .stdout(predicate::str::contains("wh() {"))
            .stdout(predicate::str::contains(r#"command wh "$@""#))
            .stdout(predicate::str::contains("cd \"$_wh_dir\""));
    }
}

#[test]
fn init_fish_prints_fish_wrapper() {
    let t = TestRepo::new();
    t.wh()
        .args(["init", "fish"])
        .assert()
        .success()
        .stdout(predicate::str::contains("function wh"))
        .stdout(predicate::str::contains("cd $_wh_dir"));
}

#[test]
fn init_unknown_shell_fails() {
    let t = TestRepo::new();
    t.wh()
        .args(["init", "powershell"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("unsupported shell 'powershell'"));
}

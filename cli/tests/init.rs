mod common;

use common::TestRepo;
use predicates::prelude::*;

fn wrapper(t: &TestRepo, shell: &str) -> String {
    let out = t.wh().args(["init", shell]).assert().success();
    String::from_utf8(out.get_output().stdout.clone()).unwrap()
}

#[test]
fn wrapper_steps_aside_in_a_non_interactive_shell() {
    let t = TestRepo::new();
    t.commit("init");
    t.wh().args(["new", "feat/a"]).assert().success();
    let wt = t.root.join("repo.feat-a");
    // a script or an agent's shell: the path reaches stdout and the
    // shell stays where it was
    let script = format!("{}\nwh switch feat/a\npwd", wrapper(&t, "bash"));
    t.sh(&script)
        .assert()
        .success()
        .stdout(format!("{}\n{}\n", wt.display(), t.repo.display()));
}

#[test]
fn wrapper_forwards_other_commands() {
    let t = TestRepo::new();
    t.commit("init");
    let script = format!("{}\nwh ls --json", wrapper(&t, "zsh"));
    t.sh(&script)
        .assert()
        .success()
        .stdout(predicate::str::starts_with("[{"));
}

#[test]
fn unknown_shell_is_refused() {
    let t = TestRepo::new();
    t.wh()
        .args(["init", "tcsh"])
        .assert()
        .failure()
        .stderr(predicate::str::contains(
            "unsupported shell 'tcsh' (zsh, bash, fish)",
        ));
}

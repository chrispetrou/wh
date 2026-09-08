mod common;

use common::{fake_server, ok, TestRepo, GROQ_ANSWER};
use predicates::prelude::*;

/// A file whose two lines came from two different commits.
fn blamed() -> TestRepo {
    let t = TestRepo::new();
    t.write("a.txt", "one\n");
    t.commit("first");
    t.write("a.txt", "one\ntwo\n");
    t.commit("second");
    t
}

#[test]
fn dry_run_shows_the_blaming_commit_only() {
    let t = blamed();
    t.wh()
        .args(["why", "a.txt:1", "--dry-run"])
        .assert()
        .success()
        .stdout(predicate::str::contains("commits: 1"))
        .stdout(predicate::str::contains("first"))
        .stdout(predicate::str::contains("diff --git a/a.txt"))
        // the line block is not in the payload, like describe's context
        .stdout(predicate::str::contains("the line in question").not());
}

#[test]
fn the_line_block_follows_the_payload() {
    let t = blamed();
    let (url, server) = fake_server(ok("text/event-stream"), GROQ_ANSWER);
    t.wh()
        .args(["why", "a.txt:2"])
        .env("WH_PROVIDER", "groq")
        .env("GROQ_API_KEY", "gsk_test")
        .env("WH_GROQ_URL", &url)
        .assert()
        .success();
    let request = server.join().unwrap();
    assert!(request.contains("the line in question, a.txt:2:"));
    // the [why] contract, not the review one
    assert!(request.contains("why a line of code exists"));
    assert!(!request.contains("quiet code reviewer"));
}

#[test]
fn a_span_reads_lines() {
    let t = blamed();
    let (url, server) = fake_server(ok("text/event-stream"), GROQ_ANSWER);
    t.wh()
        .args(["why", "a.txt:1-2"])
        .env("WH_PROVIDER", "groq")
        .env("GROQ_API_KEY", "gsk_test")
        .env("WH_GROQ_URL", &url)
        .assert()
        .success()
        .stderr(predicate::str::contains("a.txt:1-2"));
    let request = server.join().unwrap();
    assert!(request.contains("the lines in question, a.txt:1-2:"));
}

#[test]
fn the_status_line_names_the_blaming_commit() {
    let t = blamed();
    let (url, server) = fake_server(ok("text/event-stream"), GROQ_ANSWER);
    t.wh()
        .args(["why", "a.txt:1"])
        .env("WH_PROVIDER", "groq")
        .env("GROQ_API_KEY", "gsk_test")
        .env("WH_GROQ_URL", &url)
        .assert()
        .success()
        .stderr(predicate::str::contains(
            "reading a.txt:1 · last changed in",
        ));
    server.join().unwrap();
}

#[test]
fn an_uncommitted_line_says_so() {
    let t = blamed();
    t.write("a.txt", "one\ntwo\nthree\n");
    t.wh()
        .args(["why", "a.txt:3", "--dry-run"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("is not committed yet"))
        .stderr(predicate::str::contains("commit or stash it first"));
}

#[test]
fn a_bad_target_shows_the_shape() {
    let t = blamed();
    t.wh()
        .args(["why", "a.txt", "--dry-run"])
        .assert()
        .failure()
        .stderr(predicate::str::contains(
            "expected <path>:<line>, like src/main.rs:42",
        ));
}

#[test]
fn a_line_past_the_end_is_gits_own_words() {
    let t = blamed();
    t.wh()
        .args(["why", "a.txt:99", "--dry-run"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("has only 2 lines"));
}

#[test]
fn why_and_dry_run_conflict_with_chat() {
    let t = blamed();
    t.wh()
        .args(["why", "a.txt:1", "--chat", "--dry-run"])
        .assert()
        .code(2)
        .stderr(predicate::str::contains("cannot be used with"));
}

#[test]
fn a_renamed_file_still_finds_its_diff() {
    let t = TestRepo::new();
    t.write("old.txt", "hello\n");
    t.commit("add old.txt");
    t.git(&["mv", "old.txt", "new.txt"]);
    t.commit("rename");
    // blame follows the rename; `git show -- new.txt` would not
    t.wh()
        .args(["why", "new.txt:1", "--dry-run"])
        .assert()
        .success()
        .stdout(predicate::str::contains("files: 1"))
        .stdout(predicate::str::contains("diff --git a/old.txt"))
        .stdout(predicate::str::contains("files: 0").not());
}

#[test]
fn an_uncommitted_line_anywhere_in_a_span_says_so() {
    let t = blamed();
    t.write("a.txt", "one\ntwo\nthree\n");
    // line 1 is committed, line 3 is not: the span must still refuse
    t.wh()
        .args(["why", "a.txt:1-3", "--dry-run"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("is not committed yet"))
        .stderr(predicate::str::contains("more commit").not());
}

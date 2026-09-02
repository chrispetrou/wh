mod common;

use common::TestRepo;
use predicates::prelude::*;
use std::io::{Read, Write};
use std::net::TcpListener;

#[test]
fn dry_run_prints_payload() {
    let t = TestRepo::new();
    t.write("a.txt", "one\n");
    t.commit("first");
    t.write("a.txt", "one\ntwo\n");
    t.commit("second");
    t.wd()
        .args(["explain", "--dry-run"])
        .assert()
        .success()
        .stdout(predicate::str::contains("commits: 1"))
        .stdout(predicate::str::contains("- "))
        .stdout(predicate::str::contains("second"))
        .stdout(predicate::str::contains("files: 1 (+1 -0)"))
        .stdout(predicate::str::contains("diff --git a/a.txt b/a.txt"));
}

#[test]
fn dry_run_excludes_lockfiles() {
    let t = TestRepo::new();
    t.write("Cargo.lock", "v1\n");
    t.write("src/main.rs", "fn main() {}\n");
    t.commit("first");
    t.write("Cargo.lock", "v2\n");
    t.write("src/main.rs", "fn main() { run() }\n");
    t.commit("second");
    t.wd()
        .args(["explain", "--dry-run"])
        .assert()
        .success()
        .stdout(predicate::str::contains("excluded:"))
        .stdout(predicate::str::contains("- Cargo.lock (lockfile)"))
        .stdout(predicate::str::contains("diff --git a/src/main.rs"))
        .stdout(predicate::str::contains("diff --git a/Cargo.lock").not());
}

#[test]
fn bare_ref_means_ref_to_head() {
    let t = TestRepo::new();
    t.write("a.txt", "one\n");
    t.commit("first");
    t.write("a.txt", "two\n");
    t.commit("second");
    t.write("a.txt", "three\n");
    t.commit("third");
    t.wd()
        .args(["explain", "--dry-run", "main~2"])
        .assert()
        .success()
        .stdout(predicate::str::contains("commits: 2"));
}

#[test]
fn empty_range_errors() {
    let t = TestRepo::new();
    t.commit("first");
    t.commit("second");
    t.wd()
        .args(["explain", "--dry-run", "HEAD..HEAD"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("nothing to explain in HEAD..HEAD"));
}

/// What the fake provider answers with: status line, extra headers, body
/// type, and whether a `100 Continue` block goes first.
struct FakeReply {
    status: &'static str,
    headers: &'static [(&'static str, &'static str)],
    content_type: &'static str,
    interim: bool,
}

fn ok(content_type: &'static str) -> FakeReply {
    FakeReply {
        status: "200 OK",
        headers: &[],
        content_type,
        interim: false,
    }
}

fn failing(status: &'static str, headers: &'static [(&'static str, &'static str)]) -> FakeReply {
    FakeReply {
        status,
        headers,
        content_type: "application/json",
        interim: false,
    }
}

/// One-shot fake provider: accepts a single request, replies with the
/// given chunks (ndjson for ollama, sse for the openai-shaped ones).
fn fake_server(reply: FakeReply, chunks: &[&str]) -> (String, std::thread::JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let body: String = chunks.concat();
    let handle = std::thread::spawn(move || {
        let (mut sock, _) = listener.accept().unwrap();
        let mut req = Vec::new();
        let mut buf = [0u8; 4096];
        let request = loop {
            let n = sock.read(&mut buf).unwrap();
            req.extend_from_slice(&buf[..n]);
            let text = String::from_utf8_lossy(&req).into_owned();
            if let Some(head_end) = text.find("\r\n\r\n") {
                let content_length = text
                    .lines()
                    .find_map(|l| {
                        l.to_lowercase()
                            .strip_prefix("content-length:")
                            .map(|v| v.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                if req.len() >= head_end + 4 + content_length {
                    break text;
                }
            }
            if n == 0 {
                break text;
            }
        };
        let mut out = String::new();
        if reply.interim {
            out.push_str("HTTP/1.1 100 Continue\r\n\r\n");
        }
        out.push_str(&format!("HTTP/1.1 {}\r\n", reply.status));
        for (k, v) in reply.headers {
            out.push_str(&format!("{k}: {v}\r\n"));
        }
        out.push_str(&format!(
            "content-type: {}\r\nconnection: close\r\n\r\n{body}",
            reply.content_type
        ));
        sock.write_all(out.as_bytes()).unwrap();
        request
    });
    (url, handle)
}

fn two_commits() -> TestRepo {
    let t = TestRepo::new();
    t.write("a.txt", "one\n");
    t.commit("first");
    t.write("a.txt", "two\n");
    t.commit("second");
    t
}

const GROQ_ANSWER: &[&str] = &[
    "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"\"}}]}\n\n",
    "data: {\"choices\":[{\"delta\":{\"content\":\"summary\\nswapped one for two.\\n\"}}]}\n\n",
    "data: {\"choices\":[{\"delta\":{\"content\":\"\\nwatch out\\nnothing notable.\\n\"}}]}\n\n",
    "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"x_groq\":{\"usage\":{\"queue_time\":0.01,\"prompt_tokens\":9,\"completion_tokens\":4,\"total_tokens\":13}}}\n\n",
    "data: [DONE]\n\n",
];

#[test]
fn streams_from_fake_ollama() {
    let t = two_commits();
    let (url, server) = fake_server(ok("application/x-ndjson"), &[
        "{\"message\":{\"role\":\"assistant\",\"content\":\"summary\\nswapped one for two.\\n\"},\"done\":false}\n",
        "{\"message\":{\"role\":\"assistant\",\"content\":\"\\nwatch out\\nnothing notable.\\n\"},\"done\":false}\n",
        "{\"done\":true,\"prompt_eval_count\":11,\"eval_count\":6}\n",
    ]);
    t.wd()
        .env("WD_PROVIDER", "ollama")
        .env("WD_OLLAMA_URL", &url)
        .env("WD_MODEL", "test-model")
        .arg("explain")
        .assert()
        .success()
        .stdout(predicate::str::contains("summary\nswapped one for two."))
        .stdout(predicate::str::contains("watch out\nnothing notable."))
        // stdout is piped here, so the status lines go to stderr and the
        // answer stands alone
        .stdout(predicate::str::contains("reading").not())
        .stderr(predicate::str::contains(
            "reading 1 commit \u{b7} 1 file \u{b7} +1 \u{2212}1",
        ))
        .stderr(
            predicate::str::is_match(
                r"\u{b7} \d+\.\ds \u{b7} test-model \u{b7} 11 in \u{b7} 6 out",
            )
            .unwrap(),
        );
    let request = server.join().unwrap();
    assert!(request.contains("\"model\":\"test-model\""));
    assert!(request.contains("\"stream\":true"));
    assert!(
        request.contains("wd explain"),
        "system prompt should be sent"
    );
}

#[test]
fn changelog_flag_sends_the_release_notes_prompt() {
    let t = two_commits();
    let (url, server) = fake_server(ok("application/x-ndjson"), &[
        "{\"message\":{\"role\":\"assistant\",\"content\":\"changed\\ntwo replaces one.\\n\"},\"done\":false}\n",
        "{\"done\":true}\n",
    ]);
    t.wd()
        .env("WD_PROVIDER", "ollama")
        .env("WD_OLLAMA_URL", &url)
        .env("WD_MODEL", "test-model")
        .args(["explain", "--changelog"])
        .assert()
        .success()
        .stdout(predicate::str::contains("changed\ntwo replaces one."))
        // no usage in the done frame: the closing line has no in/out
        .stderr(predicate::str::is_match(r"\u{b7} \d+\.\ds \u{b7} test-model\n").unwrap())
        .stderr(predicate::str::contains(" in ").not());
    let request = server.join().unwrap();
    assert!(
        request.contains("release notes"),
        "changelog system prompt should be sent"
    );
    assert!(
        !request.contains("watch out"),
        "review prompt must not be sent"
    );
}

/// main with one commit, feat branched off it with a.txt, then a commit
/// on main (b.txt) that a merge-base diff must not see; ends on feat
fn forked() -> TestRepo {
    let t = TestRepo::new();
    t.commit("root");
    t.git(&["checkout", "-b", "feat"]);
    t.write("a.txt", "one\n");
    t.commit("feature work");
    t.git(&["checkout", "main"]);
    t.write("b.txt", "base moved on\n");
    t.commit("main moved on");
    t.git(&["checkout", "feat"]);
    t
}

#[test]
fn describe_defaults_to_the_default_branch_with_merge_base() {
    let t = forked();
    t.wd()
        .args(["explain", "--describe", "--dry-run"])
        .assert()
        .success()
        .stdout(predicate::str::contains("commits: 1"))
        .stdout(predicate::str::contains("feature work"))
        .stdout(predicate::str::contains("diff --git a/a.txt"))
        .stdout(predicate::str::contains("b.txt").not())
        .stdout(predicate::str::contains("main moved on").not());
}

#[test]
fn three_dot_range_logs_only_the_head_side() {
    let t = forked();
    t.wd()
        .args(["explain", "--dry-run", "main...feat"])
        .assert()
        .success()
        .stdout(predicate::str::contains("commits: 1"))
        .stdout(predicate::str::contains("main moved on").not())
        .stdout(predicate::str::contains("b.txt").not());
}

#[test]
fn describe_flag_sends_the_pr_prompt_and_branch_context() {
    let t = forked();
    let (url, server) = fake_server(ok("application/x-ndjson"), &[
        "{\"message\":{\"role\":\"assistant\",\"content\":\"title\\nadd a.txt\\n\"},\"done\":false}\n",
        "{\"message\":{\"role\":\"assistant\",\"content\":\"\\ndescription\\nthe feature.\\n\"},\"done\":false}\n",
        "{\"done\":true}\n",
    ]);
    t.wd()
        .env("WD_PROVIDER", "ollama")
        .env("WD_OLLAMA_URL", &url)
        .env("WD_MODEL", "test-model")
        .args(["explain", "--describe"])
        .assert()
        .success()
        .stdout(predicate::str::contains("title\nadd a.txt"))
        .stdout(predicate::str::contains("description\nthe feature."))
        .stdout(predicate::str::contains("reading").not())
        .stderr(predicate::str::contains("reading 1 commit"));
    let request = server.join().unwrap();
    assert!(
        request.contains("pull request"),
        "describe system prompt should be sent"
    );
    assert!(
        request.contains("context:\\nbranch feat into main"),
        "branch context should follow the payload: {request}"
    );
    assert!(
        !request.contains("watch out"),
        "review prompt must not be sent"
    );
}

#[test]
fn describe_and_changelog_conflict() {
    let t = two_commits();
    t.wd()
        .args(["explain", "--describe", "--changelog"])
        .assert()
        .code(2)
        .stderr(predicate::str::contains("cannot be used with"));
}

#[test]
fn describe_without_a_default_branch_says_so() {
    let t = two_commits();
    t.git(&["branch", "-m", "main", "trunk"]);
    t.wd()
        .args(["explain", "--describe", "--dry-run"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("cannot determine default branch"));
}

#[test]
fn provider_error_body_is_surfaced() {
    let t = two_commits();
    let (url, _server) = fake_server(
        ok("application/x-ndjson"),
        &["{\"error\":\"model not found\"}\n"],
    );
    t.wd()
        .env("WD_PROVIDER", "ollama")
        .env("WD_OLLAMA_URL", &url)
        .arg("explain")
        .assert()
        .failure()
        .stderr(predicate::str::contains(
            "error: provider has no model llama3.2",
        ));
}

#[test]
fn streams_from_fake_groq_sse() {
    let t = two_commits();
    let (url, server) = fake_server(ok("text/event-stream"), GROQ_ANSWER);
    // no WD_PROVIDER: exercises auto-detect, so the developer's own paid
    // keys must not be allowed to outrank the groq key
    t.wd()
        .env_remove("ANTHROPIC_API_KEY")
        .env_remove("OPENAI_API_KEY")
        .env("GROQ_API_KEY", "gsk_test")
        .env("WD_GROQ_URL", &url)
        .arg("explain")
        .assert()
        .success()
        .stdout(predicate::str::contains("summary\nswapped one for two."))
        .stdout(predicate::str::contains("watch out\nnothing notable."))
        .stderr(predicate::str::contains(
            "\u{b7} openai/gpt-oss-120b \u{b7} 9 in \u{b7} 4 out",
        ));
    let request = server.join().unwrap();
    assert!(
        request.starts_with("POST /v1/chat/completions "),
        "{request}"
    );
    assert!(request.contains("Authorization: Bearer gsk_test"));
    assert!(request.contains("\"model\":\"openai/gpt-oss-120b\""));
    assert!(request.contains("\"role\":\"system\""));
    assert!(
        request.contains("\"stream_options\":{\"include_usage\":true}"),
        "usage must be asked for"
    );
}

#[test]
fn a_rejected_key_names_its_variable() {
    let t = two_commits();
    let (url, _server) = fake_server(
        failing("401 Unauthorized", &[]),
        &["{\"error\":{\"message\":\"Invalid API Key\",\"type\":\"invalid_request_error\",\"code\":\"invalid_api_key\"}}"],
    );
    t.wd()
        .env("WD_PROVIDER", "groq")
        .env("GROQ_API_KEY", "gsk_bad")
        .env("WD_GROQ_URL", &url)
        .arg("explain")
        .assert()
        .failure()
        .stderr(predicate::str::contains(
            "error: provider rejected the key\nset GROQ_API_KEY to a valid key",
        ))
        .stderr(predicate::str::contains("Invalid API Key").not());
}

#[test]
fn a_rate_limit_says_how_long_from_retry_after() {
    let t = two_commits();
    let (url, _server) = fake_server(
        failing("429 Too Many Requests", &[("retry-after", "12")]),
        &["{\"error\":{\"message\":\"Rate limit reached\",\"type\":\"tokens\"}}"],
    );
    t.wd()
        .env("WD_PROVIDER", "groq")
        .env("GROQ_API_KEY", "gsk_test")
        .env("WD_GROQ_URL", &url)
        .arg("explain")
        .assert()
        .failure()
        .stderr(predicate::str::contains(
            "error: provider rate limit, try again in 12s",
        ));
}

#[test]
fn an_empty_balance_says_where_to_top_up() {
    let t = two_commits();
    let (url, _server) = fake_server(
        failing("402 Payment Required", &[]),
        &["{\"type\":\"error\",\"error\":{\"type\":\"billing_error\",\"message\":\"Your credit balance is too low to access the Anthropic API.\"}}"],
    );
    t.wd()
        .env("WD_PROVIDER", "anthropic")
        .env("ANTHROPIC_API_KEY", "sk-ant-test")
        .env("WD_ANTHROPIC_URL", &url)
        .arg("explain")
        .assert()
        .failure()
        .stderr(predicate::str::contains(
            "error: your anthropic key is out of credit\ntop up at platform.claude.com/settings/billing, or use another key",
        ));
}

#[test]
fn an_overloaded_provider_is_named_as_such() {
    let t = two_commits();
    let (url, _server) = fake_server(
        failing("529 Overloaded", &[]),
        &["{\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}"],
    );
    t.wd()
        .env("WD_PROVIDER", "anthropic")
        .env("ANTHROPIC_API_KEY", "sk-ant-test")
        .env("WD_ANTHROPIC_URL", &url)
        .arg("explain")
        .assert()
        .failure()
        .stderr(predicate::str::contains(
            "error: provider is overloaded, try again in a moment",
        ));
}

#[test]
fn an_interim_100_is_skipped_for_the_reply() {
    let t = two_commits();
    let (url, _server) = fake_server(
        FakeReply {
            interim: true,
            ..ok("text/event-stream")
        },
        GROQ_ANSWER,
    );
    t.wd()
        .env("WD_PROVIDER", "groq")
        .env("GROQ_API_KEY", "gsk_test")
        .env("WD_GROQ_URL", &url)
        .arg("explain")
        .assert()
        .success()
        .stdout(predicate::str::contains("summary\nswapped one for two."));
}

#[test]
fn anthropic_usage_and_a_late_error_frame() {
    let t = two_commits();
    let (url, server) = fake_server(ok("text/event-stream"), &[
        "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":25,\"cache_creation_input_tokens\":3,\"cache_read_input_tokens\":100,\"output_tokens\":1}}}\n\n",
        "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"summary\\nswapped one for two.\\n\"}}\n\n",
        "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":null},\"usage\":{\"output_tokens\":7}}\n\n",
        "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":15}}\n\n",
        "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
    ]);
    t.wd()
        .env("WD_PROVIDER", "anthropic")
        .env("ANTHROPIC_API_KEY", "sk-ant-test")
        .env("WD_ANTHROPIC_URL", &url)
        .arg("explain")
        .assert()
        .success()
        .stdout(predicate::str::contains("summary\nswapped one for two."))
        // cache tokens count as input; the last output count wins
        .stderr(predicate::str::contains(
            "\u{b7} claude-opus-5 \u{b7} 128 in \u{b7} 15 out",
        ));
    let request = server.join().unwrap();
    assert!(request.starts_with("POST /v1/messages "), "{request}");
    assert!(request.contains("x-api-key: sk-ant-test"));

    // the answer that was streamed stays on stdout; the error that cut it
    // short goes to stderr and the exit code says so
    let t = two_commits();
    let (url, _server) = fake_server(ok("text/event-stream"), &[
        "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"summary\\nhalf an answer\"}}\n\n",
        "event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}\n\n",
    ]);
    t.wd()
        .env("WD_PROVIDER", "anthropic")
        .env("ANTHROPIC_API_KEY", "sk-ant-test")
        .env("WD_ANTHROPIC_URL", &url)
        .arg("explain")
        .assert()
        .failure()
        .stdout(predicate::str::contains("summary\nhalf an answer"))
        .stderr(predicate::str::contains(
            "error: provider is overloaded, try again in a moment",
        ));
}

#[test]
fn low_headroom_is_a_warning() {
    let t = two_commits();
    let (url, _server) = fake_server(
        FakeReply {
            headers: &[
                ("x-ratelimit-remaining-tokens", "500"),
                ("x-ratelimit-limit-tokens", "100000"),
                ("x-ratelimit-reset-tokens", "42s"),
            ],
            ..ok("text/event-stream")
        },
        GROQ_ANSWER,
    );
    t.wd()
        .env("WD_PROVIDER", "groq")
        .env("GROQ_API_KEY", "gsk_test")
        .env("WD_GROQ_URL", &url)
        .arg("explain")
        .assert()
        .success()
        .stderr(predicate::str::contains(
            "low on groq tokens: 500 of 100k left, resets in 42s",
        ));
}

#[test]
fn an_unreachable_host_is_named() {
    let t = two_commits();
    // nothing listens here
    t.wd()
        .env("WD_PROVIDER", "groq")
        .env("GROQ_API_KEY", "gsk_test")
        .env("WD_GROQ_URL", "http://127.0.0.1:9")
        .arg("explain")
        .assert()
        .failure()
        .stderr(predicate::str::contains(
            "error: could not reach 127.0.0.1:9",
        ));
}

#[test]
fn rejects_unknown_provider() {
    let t = TestRepo::new();
    t.write("a.txt", "one\n");
    t.commit("first");
    t.write("a.txt", "two\n");
    t.commit("second");
    t.wd()
        .env("WD_PROVIDER", "nope")
        .arg("explain")
        .assert()
        .failure()
        .stderr(predicate::str::contains("unknown WD_PROVIDER 'nope'"));
}

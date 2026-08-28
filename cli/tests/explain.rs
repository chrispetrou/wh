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

/// One-shot fake provider: accepts a single request, replies with the
/// given chunks (ndjson for ollama, sse for the openai-shaped ones).
fn fake_server(content_type: &str, chunks: &[&str]) -> (String, std::thread::JoinHandle<String>) {
    let content_type = content_type.to_string();
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
        sock.write_all(
            format!(
                "HTTP/1.1 200 OK\r\ncontent-type: {content_type}\r\nconnection: close\r\n\r\n{body}"
            )
            .as_bytes(),
        )
        .unwrap();
        request
    });
    (url, handle)
}

#[test]
fn streams_from_fake_ollama() {
    let t = TestRepo::new();
    t.write("a.txt", "one\n");
    t.commit("first");
    t.write("a.txt", "two\n");
    t.commit("second");
    let (url, server) = fake_server("application/x-ndjson", &[
        "{\"message\":{\"role\":\"assistant\",\"content\":\"summary\\nswapped one for two.\\n\"},\"done\":false}\n",
        "{\"message\":{\"role\":\"assistant\",\"content\":\"\\nwatch out\\nnothing notable.\\n\"},\"done\":false}\n",
        "{\"done\":true}\n",
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
        .stdout(predicate::str::contains(
            "reading 1 commit \u{b7} 1 file \u{b7} +1 \u{2212}1",
        ));
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
    let t = TestRepo::new();
    t.write("a.txt", "one\n");
    t.commit("first");
    t.write("a.txt", "two\n");
    t.commit("second");
    let (url, server) = fake_server("application/x-ndjson", &[
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
        .stdout(predicate::str::contains("changed\ntwo replaces one."));
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

#[test]
fn provider_error_body_is_surfaced() {
    let t = TestRepo::new();
    t.write("a.txt", "one\n");
    t.commit("first");
    t.write("a.txt", "two\n");
    t.commit("second");
    let (url, _server) = fake_server(
        "application/x-ndjson",
        &["{\"error\":\"model not found\"}\n"],
    );
    t.wd()
        .env("WD_PROVIDER", "ollama")
        .env("WD_OLLAMA_URL", &url)
        .arg("explain")
        .assert()
        .failure()
        .stderr(predicate::str::contains("model not found"));
}

#[test]
fn streams_from_fake_groq_sse() {
    let t = TestRepo::new();
    t.write("a.txt", "one\n");
    t.commit("first");
    t.write("a.txt", "two\n");
    t.commit("second");
    let (url, server) = fake_server(
        "text/event-stream",
        &[
            "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"summary\\nswapped one for two.\\n\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"\\nwatch out\\nnothing notable.\\n\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"x_groq\":{\"usage\":{\"total_tokens\":9}}}\n\n",
            "data: [DONE]\n\n",
        ],
    );
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
        .stdout(predicate::str::contains("watch out\nnothing notable."));
    let request = server.join().unwrap();
    assert!(
        request.starts_with("POST /v1/chat/completions "),
        "{request}"
    );
    assert!(request.contains("Authorization: Bearer gsk_test"));
    assert!(request.contains("\"model\":\"llama-3.3-70b-versatile\""));
    assert!(request.contains("\"role\":\"system\""));
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
        .stderr(predicate::str::contains("anthropic, openai, groq, ollama"));
}

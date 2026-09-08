mod common;

use common::{failing, fake_server, ok, TestRepo};
use predicates::prelude::*;

const OPENAI_BODY: &str = r#"{"object":"list","data":[{"id":"gpt-5.6-terra"},{"id":"text-embedding-3-small"},{"id":"whisper-1"},{"id":"gpt-5.6-sol"}]}"#;

#[test]
fn lists_the_providers_models() {
    let t = TestRepo::new();
    let (url, server) = fake_server(ok("application/json"), &[OPENAI_BODY]);
    t.wh()
        .arg("models")
        .env("WH_PROVIDER", "openai")
        .env("OPENAI_API_KEY", "sk-test")
        .env("WH_OPENAI_URL", &url)
        .assert()
        .success()
        .stdout(predicate::str::contains("gpt-5.6-terra"))
        .stdout(predicate::str::contains("gpt-5.6-sol"))
        // a catalog is not a model list
        .stdout(predicate::str::contains("embedding").not())
        .stdout(predicate::str::contains("whisper").not())
        .stderr(predicate::str::contains("openai · 2 models"));
    server.join().unwrap();
}

#[test]
fn reads_the_ollama_shape_and_needs_no_key() {
    let t = TestRepo::new();
    let body = r#"{"models":[{"name":"llama3.2:latest"},{"name":"nomic-embed-text:latest"}]}"#;
    let (url, server) = fake_server(ok("application/json"), &[body]);
    t.wh()
        .arg("models")
        .env("WH_PROVIDER", "ollama")
        .env("WH_OLLAMA_URL", &url)
        .assert()
        .success()
        .stdout(predicate::str::contains("llama3.2:latest"))
        .stdout(predicate::str::contains("nomic-embed").not())
        // the tag and the bare default name are the same model
        .stderr(predicate::str::contains("no longer lists").not());
    server.join().unwrap();
}

#[test]
fn a_retired_default_is_named() {
    let t = TestRepo::new();
    let (url, server) = fake_server(
        ok("application/json"),
        &[r#"{"data":[{"id":"gpt-9-neo"}]}"#],
    );
    t.wh()
        .arg("models")
        .env("WH_PROVIDER", "openai")
        .env("OPENAI_API_KEY", "sk-test")
        .env("WH_OPENAI_URL", &url)
        .assert()
        .success()
        .stdout(predicate::str::contains("gpt-9-neo"))
        .stderr(predicate::str::contains(
            "openai no longer lists gpt-5.6-terra",
        ));
    server.join().unwrap();
}

#[test]
fn a_gateway_without_the_endpoint_says_so() {
    let t = TestRepo::new();
    let (url, server) = fake_server(failing("404 Not Found", &[]), &[r#"{"error":"nope"}"#]);
    t.wh()
        .arg("models")
        .env("WH_PROVIDER", "openai")
        .env("OPENAI_API_KEY", "sk-test")
        .env("WH_OPENAI_URL", &url)
        .assert()
        .failure()
        // never "provider has no model <model>": the path is missing,
        // not the model
        .stderr(predicate::str::contains("provider has no models endpoint"))
        .stderr(predicate::str::contains("has no model ").not());
    server.join().unwrap();
}

#[test]
fn a_rejected_key_keeps_the_shared_wording() {
    let t = TestRepo::new();
    let (url, server) = fake_server(
        failing("401 Unauthorized", &[]),
        &[r#"{"error":{"message":"bad key"}}"#],
    );
    t.wh()
        .arg("models")
        .env("WH_PROVIDER", "openai")
        .env("OPENAI_API_KEY", "sk-test")
        .env("WH_OPENAI_URL", &url)
        .assert()
        .failure()
        .stderr(predicate::str::contains("provider rejected the key"));
    server.join().unwrap();
}

#[test]
fn an_empty_catalog_says_so() {
    let t = TestRepo::new();
    let (url, server) = fake_server(ok("application/json"), &[r#"{"data":[]}"#]);
    t.wh()
        .arg("models")
        .env("WH_PROVIDER", "openai")
        .env("OPENAI_API_KEY", "sk-test")
        .env("WH_OPENAI_URL", &url)
        .assert()
        .failure()
        .stderr(predicate::str::contains("provider returned no models"));
    server.join().unwrap();
}

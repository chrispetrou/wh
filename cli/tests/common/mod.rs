#![allow(dead_code)]

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use tempfile::TempDir;

/// A throwaway git repo at `<tmp>/repo`, fully isolated from the developer's
/// git config. Sibling worktrees land inside the tempdir.
pub struct TestRepo {
    _tmp: TempDir,
    pub root: PathBuf,
    pub repo: PathBuf,
}

impl TestRepo {
    pub fn new() -> Self {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let repo = root.join("repo");
        fs::create_dir(&repo).unwrap();
        let t = TestRepo {
            _tmp: tmp,
            root,
            repo,
        };
        t.git(&["init", "-b", "main"]);
        t.configure_user(&t.repo);
        t
    }

    pub fn configure_user(&self, dir: &Path) {
        self.git_in(dir, &["config", "user.name", "test"]);
        self.git_in(dir, &["config", "user.email", "test@example.com"]);
        self.git_in(dir, &["config", "commit.gpgsign", "false"]);
    }

    pub fn write(&self, rel: &str, contents: &str) {
        let p = self.repo.join(rel);
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(p, contents).unwrap();
    }

    pub fn commit(&self, msg: &str) {
        self.git(&["add", "-A"]);
        self.git(&["commit", "--allow-empty", "-m", msg]);
    }

    pub fn git(&self, args: &[&str]) -> String {
        self.git_in(&self.repo, args)
    }

    pub fn git_in(&self, dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("HOME", &self.root)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim_end().to_string()
    }

    /// The wh binary, run from the main repo.
    pub fn wh(&self) -> assert_cmd::Command {
        self.wh_in(&self.repo)
    }

    /// The wh binary, run from an arbitrary directory (e.g. a linked worktree).
    pub fn wh_in(&self, dir: &Path) -> assert_cmd::Command {
        let mut c = assert_cmd::Command::cargo_bin("wh").unwrap();
        c.current_dir(dir)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("HOME", &self.root)
            .env("NO_COLOR", "1");
        c
    }

    /// A non-interactive `sh -c <script>` in the main repo, with the wh
    /// binary first on PATH and the same isolation as `wh()`: for testing
    /// what `wh init` prints as it would run in a script or an agent.
    pub fn sh(&self, script: &str) -> assert_cmd::Command {
        let bin = Path::new(env!("CARGO_BIN_EXE_wh")).parent().unwrap();
        let path = format!(
            "{}:{}",
            bin.display(),
            std::env::var("PATH").unwrap_or_default()
        );
        let mut c = assert_cmd::Command::new("sh");
        c.arg("-c")
            .arg(script)
            .current_dir(&self.repo)
            .env("PATH", path)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("HOME", &self.root)
            .env("NO_COLOR", "1");
        c
    }
}

use std::io::{Read, Write};
use std::net::TcpListener;

/// What the fake provider answers with: status line, extra headers, body
/// type, and whether a `100 Continue` block goes first.
pub struct FakeReply {
    pub status: &'static str,
    pub headers: &'static [(&'static str, &'static str)],
    pub content_type: &'static str,
    pub interim: bool,
}

pub fn ok(content_type: &'static str) -> FakeReply {
    FakeReply {
        status: "200 OK",
        headers: &[],
        content_type,
        interim: false,
    }
}

pub fn failing(
    status: &'static str,
    headers: &'static [(&'static str, &'static str)],
) -> FakeReply {
    FakeReply {
        status,
        headers,
        content_type: "application/json",
        interim: false,
    }
}

/// One-shot fake provider: accepts a single request, replies with the
/// given chunks (ndjson for ollama, sse for the openai-shaped ones).
pub fn fake_server(reply: FakeReply, chunks: &[&str]) -> (String, std::thread::JoinHandle<String>) {
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

pub fn two_commits() -> TestRepo {
    let t = TestRepo::new();
    t.write("a.txt", "one\n");
    t.commit("first");
    t.write("a.txt", "two\n");
    t.commit("second");
    t
}

pub const GROQ_ANSWER: &[&str] = &[
    "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"\"}}]}\n\n",
    "data: {\"choices\":[{\"delta\":{\"content\":\"summary\\nswapped one for two.\\n\"}}]}\n\n",
    "data: {\"choices\":[{\"delta\":{\"content\":\"\\nwatch out\\nnothing notable.\\n\"}}]}\n\n",
    "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"x_groq\":{\"usage\":{\"queue_time\":0.01,\"prompt_tokens\":9,\"completion_tokens\":4,\"total_tokens\":13}}}\n\n",
    "data: [DONE]\n\n",
];

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
}

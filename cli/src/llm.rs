//! Provider plumbing for wd explain. HTTP goes through the system curl
//! (same philosophy as shelling out to git): no TLS or JSON dependencies,
//! and the API key travels via curl's config stdin, never argv.

use crate::WdError;
use std::env;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};

pub enum Provider {
    Anthropic { key: String },
    OpenAi { key: String },
    Groq { key: String, url: String },
    Ollama { url: String },
}

/// Provider choice: WD_PROVIDER wins, else the first key found (paid
/// keys before the free groq tier, so nobody is silently downgraded),
/// else a local ollama. `get` abstracts env lookup so this is testable.
pub fn choose(get: &dyn Fn(&str) -> Option<String>) -> Result<Provider, WdError> {
    let ollama_url =
        || get("WD_OLLAMA_URL").unwrap_or_else(|| "http://localhost:11434".to_string());
    let groq_url =
        || get("WD_GROQ_URL").unwrap_or_else(|| "https://api.groq.com/openai".to_string());
    match get("WD_PROVIDER").as_deref() {
        Some("anthropic") => match get("ANTHROPIC_API_KEY") {
            Some(key) => Ok(Provider::Anthropic { key }),
            None => Err(WdError::Msg("ANTHROPIC_API_KEY is not set".into())),
        },
        Some("openai") => match get("OPENAI_API_KEY") {
            Some(key) => Ok(Provider::OpenAi { key }),
            None => Err(WdError::Msg("OPENAI_API_KEY is not set".into())),
        },
        Some("groq") => match get("GROQ_API_KEY") {
            Some(key) => Ok(Provider::Groq {
                key,
                url: groq_url(),
            }),
            None => Err(WdError::Msg("GROQ_API_KEY is not set".into())),
        },
        Some("ollama") => Ok(Provider::Ollama { url: ollama_url() }),
        Some(other) => Err(WdError::Msg(format!(
            "unknown WD_PROVIDER '{other}' (anthropic, openai, groq, ollama)"
        ))),
        None => {
            if let Some(key) = get("ANTHROPIC_API_KEY") {
                Ok(Provider::Anthropic { key })
            } else if let Some(key) = get("OPENAI_API_KEY") {
                Ok(Provider::OpenAi { key })
            } else if let Some(key) = get("GROQ_API_KEY") {
                Ok(Provider::Groq {
                    key,
                    url: groq_url(),
                })
            } else {
                Ok(Provider::Ollama { url: ollama_url() })
            }
        }
    }
}

pub fn model_for(provider: &Provider, get: &dyn Fn(&str) -> Option<String>) -> String {
    if let Some(m) = get("WD_MODEL") {
        return m;
    }
    match provider {
        Provider::Anthropic { .. } => "claude-opus-5".to_string(),
        Provider::OpenAi { .. } => "gpt-5-mini".to_string(),
        Provider::Groq { .. } => "llama-3.3-70b-versatile".to_string(),
        Provider::Ollama { .. } => "llama3.2".to_string(),
    }
}

/// Urls come from the environment and land inside curl's config file as
/// `url = "..."`, where a quote or newline could inject directives.
fn valid_url(url: &str) -> bool {
    !url.is_empty() && !url.contains(['"', '\n', '\r'])
}

/// (system, user) parts of shared/prompts/explain.md, split on the
/// [section] marker lines. {{payload}} substitution happens here. In
/// changelog mode the [changelog] section is the system prompt.
pub fn prompt(payload: &str, changelog: bool) -> (String, String) {
    let template = include_str!("../../shared/prompts/explain.md");
    let mut system = String::new();
    let mut user = String::new();
    let mut target: Option<&mut String> = None;
    let system_marker = if changelog { "[changelog]" } else { "[system]" };
    for line in template.lines() {
        // any [section] line switches sections; unknown ones are skipped
        if line.starts_with('[') && line.ends_with(']') {
            target = if line == system_marker {
                Some(&mut system)
            } else if line == "[user]" {
                Some(&mut user)
            } else {
                None
            };
        } else if let Some(t) = target.as_deref_mut() {
            t.push_str(line);
            t.push('\n');
        }
    }
    (
        system.trim().to_string(),
        user.trim().replace("{{payload}}", payload),
    )
}

pub fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

/// Value of `"key":"..."` in a raw JSON line, unescaped. Scanning raw
/// bytes is sound because a quote inside a JSON string is always \",
/// so the pattern `"key":"` cannot occur inside a string value.
pub fn extract_string_field(line: &str, key: &str) -> Option<String> {
    let pat = format!("\"{key}\":\"");
    let start = line.find(&pat)? + pat.len();
    let bytes = line.as_bytes();
    let mut out = String::new();
    let mut i = start;
    while i < bytes.len() {
        let c = bytes[i];
        if c == b'"' {
            return Some(out);
        }
        if c != b'\\' {
            let ch_start = i;
            let mut end = i + 1;
            while end < bytes.len() && (bytes[end] & 0xC0) == 0x80 {
                end += 1;
            }
            out.push_str(&line[ch_start..end]);
            i = end;
            continue;
        }
        i += 1;
        match bytes.get(i)? {
            b'"' => out.push('"'),
            b'\\' => out.push('\\'),
            b'/' => out.push('/'),
            b'n' => out.push('\n'),
            b'r' => out.push('\r'),
            b't' => out.push('\t'),
            b'b' => out.push('\u{8}'),
            b'f' => out.push('\u{c}'),
            b'u' => {
                let hex = line.get(i + 1..i + 5)?;
                let mut cp = u32::from_str_radix(hex, 16).ok()?;
                i += 4;
                if (0xD800..0xDC00).contains(&cp) && line.get(i + 1..i + 3) == Some("\\u") {
                    let lo_hex = line.get(i + 3..i + 7)?;
                    if let Ok(lo) = u32::from_str_radix(lo_hex, 16) {
                        if (0xDC00..0xE000).contains(&lo) {
                            cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                            i += 6;
                        }
                    }
                }
                out.push(char::from_u32(cp).unwrap_or('\u{FFFD}'));
            }
            _ => return None,
        }
        i += 1;
    }
    None
}

struct TempBody(PathBuf);

impl Drop for TempBody {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn write_body(body: &str) -> Result<TempBody, WdError> {
    use std::os::unix::fs::OpenOptionsExt;
    let path = env::temp_dir().join(format!("wd-explain-{}.json", std::process::id()));
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&path)?;
    f.write_all(body.as_bytes())?;
    Ok(TempBody(path))
}

fn messages_json(system: &str, user: &str) -> String {
    format!(
        r#"[{{"role":"system","content":"{}"}},{{"role":"user","content":"{}"}}]"#,
        json_escape(system),
        json_escape(user)
    )
}

/// Stream the model's text, invoking `on_text` per chunk.
pub fn stream(
    provider: &Provider,
    model: &str,
    system: &str,
    user: &str,
    on_text: &mut dyn FnMut(&str),
) -> Result<(), WdError> {
    let (url, headers, body, text_key, delta_filter): (
        String,
        Vec<String>,
        String,
        &str,
        Option<&str>,
    ) = match provider {
        Provider::Anthropic { key } => (
            "https://api.anthropic.com/v1/messages".to_string(),
            vec![
                format!("x-api-key: {key}"),
                "anthropic-version: 2023-06-01".to_string(),
            ],
            format!(
                r#"{{"model":"{}","max_tokens":4096,"stream":true,"system":"{}","messages":[{{"role":"user","content":"{}"}}]}}"#,
                json_escape(model),
                json_escape(system),
                json_escape(user)
            ),
            "text",
            Some("content_block_delta"),
        ),
        Provider::OpenAi { key } => (
            "https://api.openai.com/v1/chat/completions".to_string(),
            vec![format!("Authorization: Bearer {key}")],
            format!(
                r#"{{"model":"{}","stream":true,"messages":{}}}"#,
                json_escape(model),
                messages_json(system, user)
            ),
            "content",
            None,
        ),
        Provider::Groq { key, url } => (
            format!("{}/v1/chat/completions", url.trim_end_matches('/')),
            vec![format!("Authorization: Bearer {key}")],
            format!(
                r#"{{"model":"{}","stream":true,"messages":{}}}"#,
                json_escape(model),
                messages_json(system, user)
            ),
            "content",
            None,
        ),
        Provider::Ollama { url } => (
            format!("{}/api/chat", url.trim_end_matches('/')),
            vec![],
            format!(
                r#"{{"model":"{}","stream":true,"messages":{}}}"#,
                json_escape(model),
                messages_json(system, user)
            ),
            "content",
            None,
        ),
    };

    if !valid_url(&url) {
        return Err(WdError::Msg("invalid provider url".into()));
    }
    let body_file = write_body(&body)?;
    let mut config = String::from("silent\nshow-error\nno-buffer\n");
    config.push_str(&format!("url = \"{url}\"\n"));
    config.push_str("header = \"content-type: application/json\"\n");
    for h in &headers {
        config.push_str(&format!("header = \"{h}\"\n"));
    }
    config.push_str(&format!("data = \"@{}\"\n", body_file.0.display()));

    let mut child = Command::new("curl")
        .arg("--config")
        .arg("-")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| WdError::Msg("curl not found".into()))?;
    child
        .stdin
        .take()
        .expect("piped stdin")
        .write_all(config.as_bytes())?;

    let stdout = child.stdout.take().expect("piped stdout");
    let mut got_text = false;
    let mut raw_tail = String::new();
    for line in BufReader::new(stdout).lines() {
        let line = line?;
        let json = line.strip_prefix("data: ").unwrap_or(&line);
        if json.is_empty() || json == "[DONE]" {
            continue;
        }
        if raw_tail.len() < 600 {
            raw_tail.push_str(json);
            raw_tail.push('\n');
        }
        if let Some(f) = delta_filter {
            if !json.contains(f) {
                continue;
            }
        }
        if let Some(text) = extract_string_field(json, text_key) {
            if !text.is_empty() {
                got_text = true;
                on_text(&text);
            }
        }
    }

    let status = child.wait()?;
    if !status.success() {
        let mut err = String::new();
        if let Some(mut e) = child.stderr.take() {
            let _ = e.read_to_string(&mut err);
        }
        return Err(WdError::Msg(format!(
            "request failed: {}",
            err.trim().lines().last().unwrap_or("curl error")
        )));
    }
    if !got_text {
        let tail = raw_tail.trim();
        return Err(WdError::Msg(if tail.is_empty() {
            "provider returned no text".to_string()
        } else {
            format!("provider error: {}", &tail[..tail.len().min(400)])
        }));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env_of<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |k| {
            pairs
                .iter()
                .find(|(key, _)| *key == k)
                .map(|(_, v)| v.to_string())
        }
    }

    #[test]
    fn chooses_provider_by_key_then_ollama() {
        let e = env_of(&[("ANTHROPIC_API_KEY", "a"), ("OPENAI_API_KEY", "b")]);
        assert!(matches!(choose(&e).unwrap(), Provider::Anthropic { .. }));
        let e = env_of(&[("OPENAI_API_KEY", "b"), ("GROQ_API_KEY", "g")]);
        assert!(matches!(choose(&e).unwrap(), Provider::OpenAi { .. }));
        let e = env_of(&[("GROQ_API_KEY", "g")]);
        match choose(&e).unwrap() {
            Provider::Groq { key, url } => {
                assert_eq!(key, "g");
                assert_eq!(url, "https://api.groq.com/openai");
            }
            _ => panic!("expected groq"),
        }
        let e = env_of(&[("GROQ_API_KEY", "g"), ("WD_GROQ_URL", "http://x")]);
        match choose(&e).unwrap() {
            Provider::Groq { url, .. } => assert_eq!(url, "http://x"),
            _ => panic!("expected groq"),
        }
        let e = env_of(&[]);
        match choose(&e).unwrap() {
            Provider::Ollama { url } => assert_eq!(url, "http://localhost:11434"),
            _ => panic!("expected ollama"),
        }
    }

    #[test]
    fn explicit_provider_wins_and_needs_its_key() {
        let e = env_of(&[("WD_PROVIDER", "ollama"), ("ANTHROPIC_API_KEY", "a")]);
        assert!(matches!(choose(&e).unwrap(), Provider::Ollama { .. }));
        let e = env_of(&[
            ("WD_PROVIDER", "groq"),
            ("GROQ_API_KEY", "g"),
            ("ANTHROPIC_API_KEY", "a"),
        ]);
        assert!(matches!(choose(&e).unwrap(), Provider::Groq { .. }));
        let e = env_of(&[("WD_PROVIDER", "openai")]);
        assert!(choose(&e).is_err());
        let e = env_of(&[("WD_PROVIDER", "groq")]);
        assert!(choose(&e).is_err());
        let e = env_of(&[("WD_PROVIDER", "nope")]);
        assert!(choose(&e).is_err());
    }

    #[test]
    fn model_override_and_defaults() {
        let e = env_of(&[("WD_MODEL", "custom")]);
        let p = Provider::Ollama { url: "x".into() };
        assert_eq!(model_for(&p, &e), "custom");
        let e = env_of(&[]);
        assert_eq!(
            model_for(&Provider::Anthropic { key: "k".into() }, &e),
            "claude-opus-5"
        );
        assert_eq!(
            model_for(
                &Provider::Groq {
                    key: "k".into(),
                    url: "u".into()
                },
                &e
            ),
            "llama-3.3-70b-versatile"
        );
    }

    #[test]
    fn rejects_urls_that_break_curl_config() {
        assert!(valid_url("https://api.groq.com/openai"));
        assert!(valid_url("http://127.0.0.1:1234"));
        assert!(!valid_url(""));
        assert!(!valid_url("http://x\"\noutput = /tmp/pwn"));
        assert!(!valid_url("http://x\r"));
    }

    #[test]
    fn escapes_json() {
        assert_eq!(json_escape("a\"b\\c\nd\te"), "a\\\"b\\\\c\\nd\\te");
        assert_eq!(json_escape("\u{1}"), "\\u0001");
        assert_eq!(json_escape("héllo"), "héllo");
    }

    #[test]
    fn extracts_string_fields() {
        assert_eq!(
            extract_string_field(r#"{"delta":{"text":"hi"}}"#, "text"),
            Some("hi".to_string())
        );
        assert_eq!(
            extract_string_field(r#"{"text":"a\"b\\c\nd"}"#, "text"),
            Some("a\"b\\c\nd".to_string())
        );
        assert_eq!(
            extract_string_field(r#"{"text":"A😀"}"#, "text"),
            Some("A\u{1F600}".to_string())
        );
        assert_eq!(extract_string_field(r#"{"other":"x"}"#, "text"), None);
        // unicode content passes through untouched
        assert_eq!(
            extract_string_field(r#"{"content":"héllo"}"#, "content"),
            Some("héllo".to_string())
        );
    }

    #[test]
    fn splits_prompt_template() {
        let (system, user) = prompt("PAYLOAD", false);
        assert!(system.contains("summary"));
        assert!(system.contains("watch out"));
        assert!(!system.contains("{{payload}}"));
        assert_eq!(user, "PAYLOAD");
    }

    #[test]
    fn changelog_mode_swaps_the_system_prompt() {
        let (system, user) = prompt("PAYLOAD", true);
        for label in ["added", "changed", "fixed", "removed"] {
            assert!(system.contains(&format!("\n{label}\n")), "{label}");
        }
        assert!(!system.contains("watch out"));
        assert_eq!(user, "PAYLOAD");
    }
}

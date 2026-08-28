//! Provider plumbing for wd explain. HTTP goes through the system curl
//! (same philosophy as shelling out to git): no TLS or JSON dependencies,
//! and the API key travels via curl's config stdin, never argv.

use crate::usage::Usage;
use crate::WdError;
use std::env;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};

pub enum Provider {
    Anthropic { key: String, url: String },
    OpenAi { key: String, url: String },
    Groq { key: String, url: String },
    Ollama { url: String },
}

impl Provider {
    pub fn name(&self) -> &'static str {
        match self {
            Provider::Anthropic { .. } => "anthropic",
            Provider::OpenAi { .. } => "openai",
            Provider::Groq { .. } => "groq",
            Provider::Ollama { .. } => "ollama",
        }
    }

    /// The variable the key comes from; ollama has none.
    pub fn key_var(&self) -> Option<&'static str> {
        match self {
            Provider::Anthropic { .. } => Some("ANTHROPIC_API_KEY"),
            Provider::OpenAi { .. } => Some("OPENAI_API_KEY"),
            Provider::Groq { .. } => Some("GROQ_API_KEY"),
            Provider::Ollama { .. } => None,
        }
    }

    fn base_url(&self) -> &str {
        match self {
            Provider::Anthropic { url, .. }
            | Provider::OpenAi { url, .. }
            | Provider::Groq { url, .. }
            | Provider::Ollama { url } => url,
        }
    }

    /// api.groq.com, or 127.0.0.1:1234: what "could not reach" names.
    pub fn host(&self) -> String {
        let u = self.base_url();
        let rest = u.split_once("://").map(|(_, r)| r).unwrap_or(u);
        rest.split('/').next().unwrap_or(rest).to_string()
    }

    /// Where the money is; None for ollama.
    fn billing_url(&self) -> Option<&'static str> {
        match self {
            Provider::Anthropic { .. } => Some("platform.claude.com/settings/billing"),
            Provider::OpenAi { .. } => Some("platform.openai.com/settings/organization/billing"),
            Provider::Groq { .. } => Some("console.groq.com/settings/billing"),
            Provider::Ollama { .. } => None,
        }
    }

    fn limits_url(&self) -> Option<&'static str> {
        match self {
            Provider::Anthropic { .. } => Some("platform.claude.com/settings/limits"),
            Provider::OpenAi { .. } => Some("platform.openai.com/settings/organization/limits"),
            Provider::Groq { .. } => Some("console.groq.com/settings/limits"),
            Provider::Ollama { .. } => None,
        }
    }
}

/// Provider choice: WD_PROVIDER wins, else the first key found (paid
/// keys before the free groq tier, so nobody is silently downgraded),
/// else a local ollama. `get` abstracts env lookup so this is testable.
pub fn choose(get: &dyn Fn(&str) -> Option<String>) -> Result<Provider, WdError> {
    let url_or = |var: &str, default: &str| get(var).unwrap_or_else(|| default.to_string());
    let anthropic = |key: String| Provider::Anthropic {
        key,
        url: url_or("WD_ANTHROPIC_URL", "https://api.anthropic.com"),
    };
    let openai = |key: String| Provider::OpenAi {
        key,
        url: url_or("WD_OPENAI_URL", "https://api.openai.com"),
    };
    let groq = |key: String| Provider::Groq {
        key,
        url: url_or("WD_GROQ_URL", "https://api.groq.com/openai"),
    };
    let ollama = || Provider::Ollama {
        url: url_or("WD_OLLAMA_URL", "http://localhost:11434"),
    };
    match get("WD_PROVIDER").as_deref() {
        Some("anthropic") => match get("ANTHROPIC_API_KEY") {
            Some(key) => Ok(anthropic(key)),
            None => Err(WdError::Msg("ANTHROPIC_API_KEY is not set".into())),
        },
        Some("openai") => match get("OPENAI_API_KEY") {
            Some(key) => Ok(openai(key)),
            None => Err(WdError::Msg("OPENAI_API_KEY is not set".into())),
        },
        Some("groq") => match get("GROQ_API_KEY") {
            Some(key) => Ok(groq(key)),
            None => Err(WdError::Msg("GROQ_API_KEY is not set".into())),
        },
        Some("ollama") => Ok(ollama()),
        Some(other) => Err(WdError::Msg(format!(
            "unknown WD_PROVIDER '{other}' (anthropic, openai, groq, ollama)"
        ))),
        None => {
            if let Some(key) = get("ANTHROPIC_API_KEY") {
                Ok(anthropic(key))
            } else if let Some(key) = get("OPENAI_API_KEY") {
                Ok(openai(key))
            } else if let Some(key) = get("GROQ_API_KEY") {
                Ok(groq(key))
            } else {
                Ok(ollama())
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
/// `url = "..."`, where a quote or newline could inject directives. Only
/// http(s) has the status line the reply parser expects.
fn valid_url(url: &str) -> bool {
    (url.starts_with("http://") || url.starts_with("https://")) && !url.contains(['"', '\n', '\r'])
}

/// Which section of the template frames the payload: the review shape
/// (summary, watch out), release notes (added, changed, fixed, removed),
/// or a pull request draft (title, description, testing).
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Mode {
    Explain,
    Changelog,
    Describe,
}

impl Mode {
    fn marker(self) -> &'static str {
        match self {
            Mode::Explain => "[system]",
            Mode::Changelog => "[changelog]",
            Mode::Describe => "[describe]",
        }
    }
}

/// (system, user) parts of shared/prompts/explain.md, split on the
/// [section] marker lines. {{payload}} substitution happens here. The
/// mode picks which section is the system prompt.
pub fn prompt(payload: &str, mode: Mode) -> (String, String) {
    let template = include_str!("../../shared/prompts/explain.md");
    let mut system = String::new();
    let mut user = String::new();
    let mut target: Option<&mut String> = None;
    let system_marker = mode.marker();
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

/// The status line and headers curl prints ahead of the body (`include`).
pub struct Head {
    pub status: u16,
    headers: Vec<(String, String)>,
}

impl Head {
    #[cfg(test)]
    pub fn new(status: u16, headers: Vec<(String, String)>) -> Self {
        Head { status, headers }
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

/// Reads one header block: `HTTP/1.1 429 Too Many Requests` or `HTTP/2
/// 429`, header lines, a blank line. Interim 1xx blocks (100 continue,
/// 103 early hints) are skipped for the real one.
fn read_head<I: Iterator<Item = std::io::Result<String>>>(lines: &mut I) -> Result<Head, WdError> {
    loop {
        let first = loop {
            match lines.next() {
                Some(l) => {
                    let l = l?;
                    let l = l.trim_end_matches('\r');
                    if !l.is_empty() {
                        break l.to_string();
                    }
                }
                None => return Err(WdError::Msg("provider sent no reply".into())),
            }
        };
        let mut parts = first.split_whitespace();
        let status = match (parts.next(), parts.next()) {
            (Some(v), Some(code)) if v.starts_with("HTTP/") => code.parse::<u16>().ok(),
            _ => None,
        };
        let status = status.ok_or_else(|| WdError::Msg("provider sent no http status".into()))?;
        let mut headers = Vec::new();
        for l in lines.by_ref() {
            let l = l?;
            let l = l.trim_end_matches('\r');
            if l.is_empty() {
                break;
            }
            if let Some((k, v)) = l.split_once(':') {
                headers.push((k.trim().to_ascii_lowercase(), v.trim().to_string()));
            }
        }
        if (100..200).contains(&status) {
            continue;
        }
        return Ok(Head { status, headers });
    }
}

/// What a finished call leaves behind: the tokens it cost when the
/// provider said, and the reply headers (rate-limit headroom).
pub struct Reply {
    pub usage: Option<Usage>,
    pub head: Head,
}

/// Stream the model's text, invoking `on_text` per chunk.
pub fn stream(
    provider: &Provider,
    model: &str,
    system: &str,
    user: &str,
    on_text: &mut dyn FnMut(&str),
) -> Result<Reply, WdError> {
    let base = provider.base_url().trim_end_matches('/');
    let (url, headers, body, text_key, delta_filter): (
        String,
        Vec<String>,
        String,
        &str,
        Option<&str>,
    ) = match provider {
        Provider::Anthropic { key, .. } => (
            format!("{base}/v1/messages"),
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
        Provider::OpenAi { key, .. } | Provider::Groq { key, .. } => (
            format!("{base}/v1/chat/completions"),
            vec![format!("Authorization: Bearer {key}")],
            format!(
                r#"{{"model":"{}","stream":true,"stream_options":{{"include_usage":true}},"messages":{}}}"#,
                json_escape(model),
                messages_json(system, user)
            ),
            "content",
            None,
        ),
        Provider::Ollama { .. } => (
            format!("{base}/api/chat"),
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
    // include: the status line and headers come first on stdout, which is
    // how a 401 is told from an answer. no Expect: no 100-continue block
    // to skip for large bodies; suppress-connect-headers: none for a
    // proxy's CONNECT either
    let mut config = String::from(
        "silent\nshow-error\nno-buffer\ninclude\nsuppress-connect-headers\nheader = \"Expect:\"\n",
    );
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
    let mut lines = BufReader::new(stdout).lines();
    let head = match read_head(&mut lines) {
        Ok(h) => h,
        Err(e) => {
            // nothing came back: curl's exit code says why
            let status = child.wait()?;
            if !status.success() {
                return Err(curl_failure(&mut child, status.code(), provider, false));
            }
            return Err(e);
        }
    };

    if head.status >= 400 {
        let mut body = String::new();
        for line in lines.by_ref() {
            body.push_str(&line?);
            body.push('\n');
            if body.len() > 4000 {
                break;
            }
        }
        let _ = child.wait();
        return Err(WdError::Msg(provider_failure(
            Some(head.status),
            Some(&head),
            body.trim(),
            model,
            provider,
        )));
    }

    let mut got_text = false;
    let mut raw_tail = String::new();
    let mut stream_error: Option<String> = None;
    let mut usage = Usage::default();
    let mut saw_usage = false;
    for line in lines {
        let line = line?;
        let json = line.strip_prefix("data: ").unwrap_or(&line);
        if json.is_empty() || json == "[DONE]" {
            continue;
        }
        if raw_tail.len() < 600 {
            raw_tail.push_str(json);
            raw_tail.push('\n');
        }
        if note_usage(provider, json, &mut usage) {
            saw_usage = true;
        }
        if stream_error.is_none() && is_error_frame(provider, json) {
            stream_error = Some(json.to_string());
            continue;
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
        return Err(curl_failure(&mut child, status.code(), provider, got_text));
    }
    if let Some(body) = stream_error {
        return Err(WdError::Msg(provider_failure(
            None,
            Some(&head),
            &body,
            model,
            provider,
        )));
    }
    if !got_text {
        let tail = raw_tail.trim();
        return Err(WdError::Msg(if tail.is_empty() {
            "provider returned no text".to_string()
        } else {
            provider_failure(None, Some(&head), tail, model, provider)
        }));
    }
    Ok(Reply {
        usage: saw_usage.then_some(usage),
        head,
    })
}

/// Token counts from the frames that carry them (shared/prompts/provider.md,
/// "usage"). Returns whether this frame had any.
fn note_usage(provider: &Provider, json: &str, usage: &mut Usage) -> bool {
    match provider {
        Provider::Anthropic { .. } => {
            if json.contains("\"message_start\"") {
                usage.input = extract_number_field(json, "input_tokens").unwrap_or(0)
                    + extract_number_field(json, "cache_creation_input_tokens").unwrap_or(0)
                    + extract_number_field(json, "cache_read_input_tokens").unwrap_or(0);
                return true;
            }
            if json.contains("\"message_delta\"") {
                if let Some(out) = extract_number_field(json, "output_tokens") {
                    usage.output = out; // cumulative: the last one wins
                    return true;
                }
            }
            false
        }
        Provider::Ollama { .. } => {
            if !json.contains("\"done\":true") {
                return false;
            }
            let p = extract_number_field(json, "prompt_eval_count");
            let e = extract_number_field(json, "eval_count");
            if p.is_none() && e.is_none() {
                return false;
            }
            usage.input = p.unwrap_or(0);
            usage.output = e.unwrap_or(0);
            true
        }
        _ => {
            let p = extract_number_field(json, "prompt_tokens");
            let c = extract_number_field(json, "completion_tokens");
            if p.is_none() && c.is_none() {
                return false;
            }
            usage.input = p.unwrap_or(usage.input);
            usage.output = c.unwrap_or(usage.output);
            true
        }
    }
}

/// An error the provider sends on a 200 stream: anthropic's `type:error`
/// event, or an `{"error":...}` envelope where a chunk should be.
fn is_error_frame(provider: &Provider, json: &str) -> bool {
    match provider {
        Provider::Anthropic { .. } => json.starts_with("{\"type\":\"error\""),
        _ => {
            json.contains("\"error\":")
                && !json.contains("\"choices\"")
                && !json.contains("\"message\":{")
        }
    }
}

/// curl exited non-zero: name the host for the connection failures,
/// otherwise its own last line.
fn curl_failure(
    child: &mut Child,
    code: Option<i32>,
    provider: &Provider,
    got_text: bool,
) -> WdError {
    let mut err = String::new();
    if let Some(mut e) = child.stderr.take() {
        let _ = e.read_to_string(&mut err);
    }
    let last = err.trim().lines().last().unwrap_or("curl error").trim();
    // "curl: (6) Could not resolve host: api.groq.com" -> the part after
    let detail = last
        .strip_prefix("curl: (")
        .and_then(|r| r.split_once(") "))
        .map(|(_, d)| d)
        .unwrap_or(last);
    let detail = lowercase_first(detail);
    let host = provider.host();
    match code {
        Some(18) | Some(56) if got_text => WdError::Msg(format!("lost the connection to {host}")),
        Some(6) | Some(7) | Some(28) | Some(35) | Some(52) | Some(56) if !got_text => {
            WdError::Msg(format!("could not reach {host}\n{detail}"))
        }
        _ => WdError::Msg(format!("request failed: {detail}")),
    }
}

fn lowercase_first(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_lowercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

/// A failed reply in our words, per shared/prompts/provider.md: status
/// first, then the body. The hint, when there is one, is a second line.
/// `status` is None for an error that came mid-stream.
pub fn provider_failure(
    status: Option<u16>,
    head: Option<&Head>,
    body: &str,
    model: &str,
    provider: &Provider,
) -> String {
    let message = extract_string_field(body, "message")
        .or_else(|| extract_string_field(body, "error"))
        .unwrap_or_else(|| body.split_whitespace().collect::<Vec<_>>().join(" "));
    let message = truncate_chars(&message, 300);
    let lower = message.to_lowercase();
    let has_code = |c: &str| body.contains(&format!("\"{c}\""));
    let name = provider.name();
    let status = status.unwrap_or(0);

    if status == 401 || status == 403 {
        return match provider.key_var() {
            Some(var) => format!("provider rejected the key\nset {var} to a valid key"),
            None => "provider rejected the key".to_string(),
        };
    }
    if status == 402
        || [
            "billing_error",
            "insufficient_quota",
            "credit_balance_exhausted",
        ]
        .iter()
        .any(|c| has_code(c))
        || lower.contains("credit balance")
    {
        return match provider.billing_url() {
            Some(url) => {
                format!("your {name} key is out of credit\ntop up at {url}, or use another key")
            }
            None => format!("your {name} key is out of credit"),
        };
    }
    if [
        "enforced_spend_limit_reached",
        "organization_spend_limit_exceeded",
        "project_spend_limit_exceeded",
        "organization_usage_limit_exceeded",
    ]
    .iter()
    .any(|c| has_code(c))
        || lower.contains("specified api usage limits")
        || lower.contains("spend limit")
    {
        return match provider.limits_url() {
            Some(url) => format!("your {name} key hit its spend limit\nraise it at {url}"),
            None => format!("your {name} key hit its spend limit"),
        };
    }
    if status == 429 && (lower.contains("used ") || lower.contains("try again in")) {
        let wait = crate::usage::wait_from(head, &message);
        let daily = lower.contains("per day")
            || lower
                .split(|c: char| !c.is_alphanumeric())
                .any(|w| w == "tpd" || w == "rpd");
        if daily {
            return match wait {
                Some(s) => format!(
                    "provider daily limit reached, resets in {}",
                    crate::usage::fmt_wait(s)
                ),
                None => "provider daily limit reached, resets tomorrow".to_string(),
            };
        }
        return rate_limit_line(wait);
    }
    let too_large = [
        "request_too_large",
        "too large",
        "too long",
        "context length",
        "maximum context",
        "too many tokens",
        "context_length_exceeded",
    ]
    .iter()
    .any(|s| lower.contains(s));
    if too_large {
        // "Limit 8000, Requested 17842" (groq), "context length is 8192
        // tokens ... requested 17842 tokens" (openai), "213000 tokens >
        // 200000 maximum" (anthropic)
        let counts = number_after(&message, "Limit ")
            .zip(number_after(&message, "Requested "))
            .or_else(|| {
                number_after(&message, "context length is ")
                    .zip(number_after(&message, "requested "))
            })
            .or_else(|| {
                number_after(&message, " tokens > ").zip(number_before(&message, " tokens > "))
            });
        let size = match counts {
            Some((limit, requested)) => format!(": {requested} tokens, limit {limit}"),
            None => String::new(),
        };
        return format!(
            "the diff is too big for {model}{size}\ntry fewer commits, a narrower range, or WD_MODEL with a larger context"
        );
    }
    if status == 429 {
        return rate_limit_line(crate::usage::wait_from(head, &message));
    }
    if status == 404
        || lower.contains("unknown model")
        || lower.contains("does not exist")
        || (lower.contains("model") && (lower.contains("not found") || lower.contains("not exist")))
    {
        return format!("provider has no model {model}");
    }
    if status >= 500 || has_code("overloaded_error") || lower.contains("overloaded") {
        return "provider is overloaded, try again in a moment".to_string();
    }
    format!("provider error: {message}")
}

fn rate_limit_line(wait: Option<u64>) -> String {
    match wait {
        Some(s) => format!(
            "provider rate limit, try again in {}",
            crate::usage::fmt_wait(s)
        ),
        None => "provider rate limit, try again in a moment".to_string(),
    }
}

/// The first `n` chars, never a byte slice (a multibyte message must
/// not abort the process).
fn truncate_chars(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// The integer right after `key` in `s`, if any.
fn number_after(s: &str, key: &str) -> Option<u64> {
    let rest = &s[s.find(key)? + key.len()..];
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}

/// The integer right before `key` in `s`, if any.
fn number_before(s: &str, key: &str) -> Option<u64> {
    let head = &s[..s.find(key)?];
    let digits: String = head
        .chars()
        .rev()
        .take_while(|c| c.is_ascii_digit())
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    digits.parse().ok()
}

/// Value of `"key":<digits>` in a raw JSON line. The leading quote keeps
/// `"input_tokens":` from matching `cache_read_input_tokens`.
pub fn extract_number_field(line: &str, key: &str) -> Option<u64> {
    let pat = format!("\"{key}\":");
    let rest = &line[line.find(&pat)? + pat.len()..];
    let digits: String = rest
        .trim_start()
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    digits.parse().ok()
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
            model_for(
                &Provider::Anthropic {
                    key: "k".into(),
                    url: "u".into()
                },
                &e
            ),
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
        assert!(!valid_url("file:///etc/passwd"));
        assert!(!valid_url("api.groq.com"));
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
        let (system, user) = prompt("PAYLOAD", Mode::Explain);
        assert!(system.contains("summary"));
        assert!(system.contains("watch out"));
        assert!(!system.contains("{{payload}}"));
        assert_eq!(user, "PAYLOAD");
    }

    fn groq() -> Provider {
        Provider::Groq {
            key: "k".into(),
            url: "https://api.groq.com/openai".into(),
        }
    }

    fn anthropic() -> Provider {
        Provider::Anthropic {
            key: "k".into(),
            url: "https://api.anthropic.com".into(),
        }
    }

    fn head(status: u16, pairs: &[(&str, &str)]) -> Head {
        Head::new(
            status,
            pairs
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
        )
    }

    #[test]
    fn provider_failures_are_in_our_words() {
        let groq_big = r#"{"error":{"message":"Request too large for model `openai/gpt-oss-120b` in organization `org_x` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 17842, please reduce your message size and try again.","type":"tokens"}}"#;
        let msg = provider_failure(Some(413), None, groq_big, "openai/gpt-oss-120b", &groq());
        assert!(msg
            .starts_with("the diff is too big for openai/gpt-oss-120b: 17842 tokens, limit 8000"));
        assert!(!msg.contains("org_x"));
        assert!(msg.contains("try fewer commits"));
        let openai_big = r#"{"error":{"message":"This model's maximum context length is 8192 tokens. However, you requested 17842 tokens (17842 in the messages, 0 in the completion). Please reduce the length."}}"#;
        assert!(
            provider_failure(Some(400), None, openai_big, "gpt-5-mini", &groq())
                .starts_with("the diff is too big for gpt-5-mini: 17842 tokens, limit 8192")
        );
        let anthropic_big =
            r#"{"error":{"message":"prompt is too long: 213000 tokens > 200000 maximum"}}"#;
        assert!(provider_failure(
            Some(400),
            None,
            anthropic_big,
            "claude-opus-5",
            &anthropic()
        )
        .starts_with("the diff is too big for claude-opus-5: 213000 tokens, limit 200000"));
        assert_eq!(
            provider_failure(None, None, r#"{"error":"model not found"}"#, "m", &groq()),
            "provider has no model m"
        );
        assert_eq!(
            provider_failure(Some(400), None, "something odd", "m", &groq()),
            "provider error: something odd"
        );
        // a 300-char cut never splits a multibyte char (release aborts on panic)
        let long = format!(r#"{{"error":{{"message":"{}"}}}}"#, "é".repeat(400));
        assert_eq!(
            provider_failure(Some(400), None, &long, "m", &groq()),
            format!("provider error: {}", "é".repeat(300))
        );
    }

    #[test]
    fn keys_credit_and_spend_limits_say_the_way_out() {
        assert_eq!(
            provider_failure(
                Some(401),
                None,
                r#"{"error":{"message":"Invalid API Key"}}"#,
                "m",
                &groq()
            ),
            "provider rejected the key\nset GROQ_API_KEY to a valid key"
        );
        assert_eq!(
            provider_failure(
                Some(403),
                None,
                "{}",
                "m",
                &Provider::Ollama {
                    url: "http://x".into()
                }
            ),
            "provider rejected the key"
        );
        let billing = r#"{"type":"error","error":{"type":"billing_error","message":"Your credit balance is too low to access the Anthropic API."}}"#;
        assert_eq!(
            provider_failure(Some(402), None, billing, "m", &anthropic()),
            "your anthropic key is out of credit\ntop up at platform.claude.com/settings/billing, or use another key"
        );
        let quota = r#"{"error":{"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota","code":"insufficient_quota"}}"#;
        let openai = Provider::OpenAi {
            key: "k".into(),
            url: "https://api.openai.com".into(),
        };
        assert_eq!(
            provider_failure(Some(429), None, quota, "m", &openai),
            "your openai key is out of credit\ntop up at platform.openai.com/settings/organization/billing, or use another key"
        );
        let spend = r#"{"type":"error","error":{"type":"rate_limit_error","message":"You have reached your API usage limits: your organization has crossed its monthly API usage threshold.","details":{"error_code":"enforced_spend_limit_reached"}}}"#;
        assert_eq!(
            provider_failure(Some(429), None, spend, "m", &anthropic()),
            "your anthropic key hit its spend limit\nraise it at platform.claude.com/settings/limits"
        );
        let own = r#"{"error":{"type":"invalid_request_error","message":"You have reached your specified API usage limits. Access resumes on 2026-09-01."}}"#;
        assert!(provider_failure(Some(400), None, own, "m", &anthropic())
            .starts_with("your anthropic key hit its spend limit"));
    }

    #[test]
    fn rate_limits_say_how_long_and_daily_ones_say_so() {
        let tpm = r#"{"error":{"message":"Rate limit reached for model `llama-3.3-70b-versatile` in organization `org_x` service tier `on_demand` on tokens per minute (TPM): Limit 6000, Used 5000, Requested 1500. Please try again in 5.2s. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing","type":"tokens"}}"#;
        assert_eq!(
            provider_failure(Some(429), None, tpm, "m", &groq()),
            "provider rate limit, try again in 6s"
        );
        let tpd = r#"{"error":{"message":"Rate limit reached for model `llama-3.3-70b-versatile` on tokens per day (TPD): Limit 100000, Used 99000, Requested 5000. Please try again in 1h23m.","type":"tokens"}}"#;
        assert_eq!(
            provider_failure(Some(429), None, tpd, "m", &groq()),
            "provider daily limit reached, resets in 1h 23m"
        );
        let rpd = r#"{"error":{"message":"Rate limit reached on requests per day (RPD): Limit 1000, Used 1000, Requested 1"}}"#;
        assert_eq!(
            provider_failure(Some(429), None, rpd, "m", &groq()),
            "provider daily limit reached, resets tomorrow"
        );
        let plain = r#"{"error":{"message":"Rate limit reached"}}"#;
        assert_eq!(
            provider_failure(Some(429), None, plain, "m", &groq()),
            "provider rate limit, try again in a moment"
        );
        assert_eq!(
            provider_failure(
                Some(429),
                Some(&head(429, &[("retry-after", "12")])),
                plain,
                "m",
                &groq()
            ),
            "provider rate limit, try again in 12s"
        );
        assert_eq!(
            provider_failure(
                Some(429),
                Some(&head(429, &[("x-ratelimit-reset-tokens", "2m59.56s")])),
                plain,
                "m",
                &groq()
            ),
            "provider rate limit, try again in 3m"
        );
    }

    #[test]
    fn server_failures_are_overloaded() {
        for status in [500u16, 502, 503, 504, 529] {
            assert_eq!(
                provider_failure(Some(status), None, "<html>bad gateway</html>", "m", &groq()),
                "provider is overloaded, try again in a moment",
                "{status}"
            );
        }
        // an error frame after text carries no status
        let frame =
            r#"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#;
        assert_eq!(
            provider_failure(None, None, frame, "m", &anthropic()),
            "provider is overloaded, try again in a moment"
        );
    }

    #[test]
    fn reads_the_head_curl_prints() {
        fn lines(s: &str) -> Vec<std::io::Result<String>> {
            s.split('\n').map(|l| Ok(l.to_string())).collect()
        }
        let h = read_head(&mut lines("HTTP/1.1 429 Too Many Requests\r\nRetry-After: 12\r\nContent-Type: application/json\r\n\r\n{\"error\":1}").into_iter()).unwrap();
        assert_eq!(h.status, 429);
        assert_eq!(h.header("retry-after"), Some("12"));
        assert_eq!(h.header("RETRY-AFTER"), Some("12"));
        let h = read_head(
            &mut lines("HTTP/2 200\r\nx-ratelimit-remaining-tokens: 500\r\n\r\n").into_iter(),
        )
        .unwrap();
        assert_eq!(h.status, 200);
        assert_eq!(h.header("x-ratelimit-remaining-tokens"), Some("500"));
        // an interim block is skipped for the real one
        let h = read_head(
            &mut lines("HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 401 Unauthorized\r\n\r\n")
                .into_iter(),
        )
        .unwrap();
        assert_eq!(h.status, 401);
        assert!(read_head(&mut lines("").into_iter()).is_err());
        assert!(read_head(&mut lines("{\"not\":\"http\"}").into_iter()).is_err());
    }

    #[test]
    fn extracts_number_fields() {
        let start = r#"{"type":"message_start","message":{"usage":{"input_tokens":25,"cache_creation_input_tokens":3,"cache_read_input_tokens":100,"output_tokens":1}}}"#;
        assert_eq!(extract_number_field(start, "input_tokens"), Some(25));
        assert_eq!(
            extract_number_field(start, "cache_read_input_tokens"),
            Some(100)
        );
        assert_eq!(extract_number_field(start, "output_tokens"), Some(1));
        let usage = r#"{"usage":{"prompt_tokens":9,"completion_tokens":4,"prompt_tokens_details":{"cached_tokens":0}}}"#;
        assert_eq!(extract_number_field(usage, "prompt_tokens"), Some(9));
        assert_eq!(extract_number_field(usage, "completion_tokens"), Some(4));
        assert_eq!(extract_number_field(usage, "total_tokens"), None);
        assert_eq!(extract_number_field(r#"{"n": 42}"#, "n"), Some(42));
    }

    #[test]
    fn notes_usage_per_provider() {
        let mut u = Usage::default();
        let a = anthropic();
        assert!(note_usage(
            &a,
            r#"{"type":"message_start","message":{"usage":{"input_tokens":25,"cache_creation_input_tokens":3,"cache_read_input_tokens":100,"output_tokens":1}}}"#,
            &mut u
        ));
        assert!(note_usage(
            &a,
            r#"{"type":"message_delta","usage":{"output_tokens":7}}"#,
            &mut u
        ));
        assert!(note_usage(
            &a,
            r#"{"type":"message_delta","usage":{"output_tokens":15}}"#,
            &mut u
        ));
        assert!(!note_usage(
            &a,
            r#"{"type":"content_block_delta","delta":{"text":"hi"}}"#,
            &mut u
        ));
        assert_eq!(
            u,
            Usage {
                input: 128,
                output: 15
            }
        );

        let mut u = Usage::default();
        let g = groq();
        assert!(!note_usage(
            &g,
            r#"{"choices":[{"delta":{"content":"hi"}}]}"#,
            &mut u
        ));
        assert!(note_usage(
            &g,
            r#"{"choices":[],"x_groq":{"usage":{"prompt_tokens":9,"completion_tokens":4}}}"#,
            &mut u
        ));
        assert_eq!(
            u,
            Usage {
                input: 9,
                output: 4
            }
        );

        let mut u = Usage::default();
        let o = Provider::Ollama {
            url: "http://x".into(),
        };
        assert!(!note_usage(
            &o,
            r#"{"message":{"content":"hi"},"done":false}"#,
            &mut u
        ));
        assert!(note_usage(
            &o,
            r#"{"done":true,"prompt_eval_count":11,"eval_count":6}"#,
            &mut u
        ));
        assert_eq!(
            u,
            Usage {
                input: 11,
                output: 6
            }
        );
    }

    #[test]
    fn tells_error_frames_from_chunks() {
        let g = groq();
        assert!(is_error_frame(&g, r#"{"error":{"message":"x"}}"#));
        assert!(is_error_frame(&g, r#"{"error":"model not found"}"#));
        assert!(!is_error_frame(
            &g,
            r#"{"choices":[{"delta":{"content":"error: none"}}]}"#
        ));
        let o = Provider::Ollama {
            url: "http://x".into(),
        };
        assert!(!is_error_frame(
            &o,
            r#"{"message":{"content":"\"error\": yes"},"done":false}"#
        ));
        let a = anthropic();
        assert!(is_error_frame(
            &a,
            r#"{"type":"error","error":{"type":"overloaded_error"}}"#
        ));
        assert!(!is_error_frame(
            &a,
            r#"{"type":"content_block_delta","delta":{"text":"\"error\":"}}"#
        ));
    }

    #[test]
    fn hosts_come_from_the_base_url() {
        assert_eq!(groq().host(), "api.groq.com");
        assert_eq!(
            Provider::Ollama {
                url: "http://127.0.0.1:1234/".into()
            }
            .host(),
            "127.0.0.1:1234"
        );
    }

    #[test]
    fn changelog_mode_swaps_the_system_prompt() {
        let (system, user) = prompt("PAYLOAD", Mode::Changelog);
        for label in ["added", "changed", "fixed", "removed"] {
            assert!(system.contains(&format!("\n{label}\n")), "{label}");
        }
        assert!(!system.contains("watch out"));
        assert_eq!(user, "PAYLOAD");
    }

    #[test]
    fn describe_mode_swaps_the_system_prompt() {
        let (system, user) = prompt("PAYLOAD", Mode::Describe);
        for label in ["title", "description", "testing"] {
            assert!(system.contains(&format!("\n{label}\n")), "{label}");
        }
        assert!(system.contains("pull request"));
        assert!(!system.contains("watch out"));
        assert!(!system.contains("release notes"));
        assert_eq!(user, "PAYLOAD");
    }
}

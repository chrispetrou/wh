//! Token and wait formatting, headroom headers; mirrors
//! web/lib/explain/usage.ts. The rules are in shared/prompts/provider.md;
//! integer arithmetic so both sides round ties the same way.

use crate::llm::Head;

/// Tokens one answer cost, as the provider reported them.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Usage {
    pub input: u64,
    pub output: u64,
}

/// 842, 1k, 1.3k, 12.4k, 999.9k, 1m, 1.2m
pub fn fmt_tokens(n: u64) -> String {
    if n < 1000 {
        return n.to_string();
    }
    let (unit, suffix) = if n < 999_950 {
        (1000u64, "k")
    } else {
        (1_000_000u64, "m")
    };
    let tenths = (n * 10 + unit / 2) / unit;
    let whole = tenths / 10;
    let frac = tenths % 10;
    if frac == 0 {
        format!("{whole}{suffix}")
    } else {
        format!("{whole}.{frac}{suffix}")
    }
}

/// 12s, 3m, 1h 20m, 2h
pub fn fmt_wait(seconds: u64) -> String {
    if seconds < 60 {
        return format!("{seconds}s");
    }
    if seconds < 3600 {
        return format!("{}m", seconds.div_ceil(60));
    }
    let h = seconds / 3600;
    let m = (seconds - h * 3600).div_ceil(60);
    if m == 60 {
        format!("{}h", h + 1)
    } else if m == 0 {
        format!("{h}h")
    } else {
        format!("{h}h {m}m")
    }
}

/// "6m0s", "2m59.56s", "7.66s", "1h23m" -> whole seconds, rounded up.
pub fn parse_duration(s: &str) -> Option<u64> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    let mut total = 0.0f64;
    let mut num = String::new();
    let mut parts = 0;
    for c in s.chars() {
        match c {
            '0'..='9' | '.' => num.push(c),
            'h' | 'm' | 's' => {
                let v: f64 = num.parse().ok()?;
                num.clear();
                total += match c {
                    'h' => v * 3600.0,
                    'm' => v * 60.0,
                    _ => v,
                };
                parts += 1;
            }
            _ => return None,
        }
    }
    if parts == 0 || !num.is_empty() {
        return None;
    }
    Some(total.ceil() as u64)
}

/// Seconds until the next try, from the headers then the message; None
/// when nothing says. See "waits" in shared/prompts/provider.md.
pub fn wait_from(head: Option<&Head>, message: &str) -> Option<u64> {
    if let Some(h) = head {
        if let Some(v) = h.header("retry-after") {
            if let Ok(n) = v.trim().parse::<u64>() {
                return Some(n);
            }
        }
        for name in [
            "x-ratelimit-reset-tokens",
            "x-ratelimit-reset-requests",
            "anthropic-ratelimit-tokens-reset",
            "anthropic-ratelimit-requests-reset",
        ] {
            if let Some(d) = h.header(name).and_then(parse_duration) {
                return Some(d);
            }
        }
    }
    let lower = message.to_lowercase();
    let at = lower.find("try again in ")? + "try again in ".len();
    let span: String = lower[at..]
        .chars()
        .take_while(|c| c.is_ascii_digit() || matches!(c, '.' | 'h' | 'm' | 's'))
        .collect();
    parse_duration(span.trim_end_matches('.'))
}

/// What the last answer said was left on the key, when the provider
/// reports it; tokens per minute, requests per day for groq.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Headroom {
    pub tokens: Option<(u64, u64)>,
    pub requests: Option<(u64, u64)>,
    pub reset: Option<u64>,
}

fn pair(head: &Head, left: &str, limit: &str) -> Option<(u64, u64)> {
    let l: u64 = head.header(left)?.trim().parse().ok()?;
    let m: u64 = head.header(limit)?.trim().parse().ok()?;
    if m == 0 {
        return None;
    }
    Some((l, m))
}

pub fn headroom(head: &Head, anthropic: bool) -> Option<Headroom> {
    let h = if anthropic {
        Headroom {
            tokens: pair(
                head,
                "anthropic-ratelimit-tokens-remaining",
                "anthropic-ratelimit-tokens-limit",
            ),
            requests: pair(
                head,
                "anthropic-ratelimit-requests-remaining",
                "anthropic-ratelimit-requests-limit",
            ),
            reset: None,
        }
    } else {
        Headroom {
            tokens: pair(
                head,
                "x-ratelimit-remaining-tokens",
                "x-ratelimit-limit-tokens",
            ),
            requests: pair(
                head,
                "x-ratelimit-remaining-requests",
                "x-ratelimit-limit-requests",
            ),
            reset: None,
        }
    };
    if h.tokens.is_none() && h.requests.is_none() {
        return None;
    }
    Some(Headroom {
        reset: wait_from(Some(head), ""),
        ..h
    })
}

/// The amber line when a limit is nearly used up.
pub fn low_line(provider: &str, h: &Headroom) -> Option<String> {
    for (what, v) in [("tokens", h.tokens), ("requests", h.requests)] {
        if let Some((left, limit)) = v {
            if left < limit / 10 {
                let reset = h
                    .reset
                    .map(|s| format!(", resets in {}", fmt_wait(s)))
                    .unwrap_or_default();
                return Some(format!(
                    "low on {provider} {what}: {} of {} left{reset}",
                    fmt_tokens(left),
                    fmt_tokens(limit)
                ));
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_tokens_like_the_spec_table() {
        for (n, s) in [
            (0, "0"),
            (842, "842"),
            (999, "999"),
            (1000, "1k"),
            (1250, "1.3k"),
            (12400, "12.4k"),
            (999_949, "999.9k"),
            (999_950, "1m"),
            (1_234_567, "1.2m"),
            (84_300, "84.3k"),
        ] {
            assert_eq!(fmt_tokens(n), s, "{n}");
        }
    }

    #[test]
    fn formats_waits() {
        assert_eq!(fmt_wait(0), "0s");
        assert_eq!(fmt_wait(59), "59s");
        assert_eq!(fmt_wait(60), "1m");
        assert_eq!(fmt_wait(121), "3m");
        assert_eq!(fmt_wait(3600), "1h");
        assert_eq!(fmt_wait(4800), "1h 20m");
        assert_eq!(fmt_wait(7199), "2h");
        assert_eq!(fmt_wait(7200), "2h");
    }

    #[test]
    fn parses_reset_durations() {
        assert_eq!(parse_duration("6m0s"), Some(360));
        assert_eq!(parse_duration("2m59.56s"), Some(180));
        assert_eq!(parse_duration("7.66s"), Some(8));
        assert_eq!(parse_duration("1h23m"), Some(4980));
        assert_eq!(parse_duration("12s"), Some(12));
        assert_eq!(parse_duration(""), None);
        assert_eq!(parse_duration("soon"), None);
        assert_eq!(parse_duration("2026-01-01T00:00:00Z"), None);
        assert_eq!(parse_duration("5"), None);
    }

    fn head(pairs: &[(&str, &str)]) -> Head {
        Head::new(
            429,
            pairs
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
        )
    }

    #[test]
    fn waits_come_from_headers_then_the_message() {
        assert_eq!(
            wait_from(Some(&head(&[("retry-after", "12")])), "try again in 5s"),
            Some(12)
        );
        assert_eq!(
            wait_from(Some(&head(&[("x-ratelimit-reset-tokens", "2m59.56s")])), ""),
            Some(180)
        );
        assert_eq!(wait_from(None, "Please try again in 5.2s."), Some(6));
        assert_eq!(wait_from(None, "try again in 1h23m"), Some(4980));
        assert_eq!(wait_from(None, "Rate limit reached"), None);
        // an http-date is unknown here (the web computes the delta)
        assert_eq!(
            wait_from(
                Some(&head(&[("retry-after", "Wed, 21 Oct 2026 07:28:00 GMT")])),
                ""
            ),
            None
        );
    }

    #[test]
    fn headroom_needs_both_sides_and_warns_under_a_tenth() {
        assert_eq!(
            headroom(&head(&[("x-ratelimit-remaining-tokens", "500")]), false),
            None
        );
        let h = headroom(
            &head(&[
                ("x-ratelimit-remaining-tokens", "500"),
                ("x-ratelimit-limit-tokens", "100000"),
                ("x-ratelimit-reset-tokens", "42s"),
            ]),
            false,
        )
        .unwrap();
        assert_eq!(h.tokens, Some((500, 100000)));
        assert_eq!(h.reset, Some(42));
        assert_eq!(
            low_line("groq", &h).unwrap(),
            "low on groq tokens: 500 of 100k left, resets in 42s"
        );
        let a = headroom(
            &head(&[
                ("anthropic-ratelimit-requests-remaining", "3"),
                ("anthropic-ratelimit-requests-limit", "60"),
            ]),
            true,
        )
        .unwrap();
        assert_eq!(
            low_line("anthropic", &a).unwrap(),
            "low on anthropic requests: 3 of 60 left"
        );
        let fine = Headroom {
            tokens: Some((50_000, 100_000)),
            ..Default::default()
        };
        assert_eq!(low_line("groq", &fine), None);
    }
}

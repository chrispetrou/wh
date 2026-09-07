//! The model half of `wh explain` and `wh why`: provider choice, the
//! streamed answer, the closing line, and the follow-up loop.

use crate::{llm, output, usage, WhError};
use std::env;
use std::io::{BufRead, IsTerminal, Write};
use std::time::Instant;

/// The section labels of the output contracts (review, changelog,
/// describe, why).
const LABELS: [&str; 10] = [
    "summary",
    "watch out",
    "added",
    "changed",
    "fixed",
    "removed",
    "title",
    "description",
    "testing",
    "why",
];

/// A stray paste cannot bloat one request, and the conversation cannot
/// grow without end; the web holds the same two caps client side.
const MAX_QUESTION: usize = 4000;
const MAX_TURNS: usize = 26;

/// Streams one answer, then keeps asking when `chat` is set. `tail` is
/// appended to the user turn after the payload (describe's context
/// block, why's line block), never inside it, so `--dry-run` stays the
/// spec payload byte for byte.
pub fn answer(payload: &str, mode: llm::Mode, tail: &str, chat: bool) -> Result<(), WhError> {
    let getenv = |k: &str| env::var(k).ok();
    let provider = llm::choose(&getenv)?;
    let model = llm::model_for(&provider, &getenv);
    let (system, mut user) = llm::prompt(payload, mode);
    user.push_str(tail);

    let mut turns = vec![llm::Turn::user(user)];
    let text = ask(&provider, &model, &system, &turns)?;
    if !chat {
        return Ok(());
    }
    turns.push(llm::Turn::assistant(text));
    follow_up(&provider, &model, &mut turns)
}

/// One call: the streamed answer, then the closing line and any headroom
/// warning. Returns the text, which becomes the next assistant turn.
fn ask(
    provider: &llm::Provider,
    model: &str,
    system: &str,
    turns: &[llm::Turn],
) -> Result<String, WhError> {
    let mut printer = LinePrinter::new(output::color());
    let mut text = String::new();
    let started = Instant::now();
    let res = llm::stream(provider, model, system, turns, &mut |chunk| {
        text.push_str(chunk);
        printer.push(chunk);
    });
    // whatever arrived is shown before an error is
    printer.finish();
    let reply = res?;

    // the closing line: elapsed, model, and the tokens when the provider
    // said (shared/prompts/provider.md, "lines")
    let mut closing = format!("· {:.1}s · {model}", started.elapsed().as_secs_f64());
    if let Some(u) = reply.usage {
        closing.push_str(&format!(
            " · {} in · {} out",
            usage::fmt_tokens(u.input),
            usage::fmt_tokens(u.output)
        ));
    }
    output::status(&closing);
    let anthropic = matches!(provider, llm::Provider::Anthropic { .. });
    if let Some(h) = usage::headroom(&reply.head, anthropic) {
        if let Some(line) = usage::low_line(provider.name(), &h) {
            output::warn(&line);
        }
    }
    Ok(text)
}

/// What one line of input means. Kept io-free so it can be tested: the
/// loop around it needs a terminal on both ends.
#[derive(PartialEq, Debug)]
enum Step {
    Ask(String),
    Done,
    TooLong,
    Full,
}

fn read_step(line: Option<&str>, turns: usize) -> Step {
    let Some(l) = line else { return Step::Done };
    let q = l.trim();
    if q.is_empty() {
        return Step::Done;
    }
    if q.len() > MAX_QUESTION {
        return Step::TooLong;
    }
    if turns >= MAX_TURNS {
        return Step::Full;
    }
    Step::Ask(q.to_string())
}

/// Follow-up questions about the same diff, grounded by the [followup]
/// section of the shared template. A pipe is a machine: with stdin or
/// stdout not a terminal this is the one-shot answer and nothing else.
fn follow_up(
    provider: &llm::Provider,
    model: &str,
    turns: &mut Vec<llm::Turn>,
) -> Result<(), WhError> {
    if !std::io::stdin().is_terminal() || !std::io::stdout().is_terminal() {
        return Ok(());
    }
    let system = llm::prompt("", llm::Mode::Followup).0;
    let stdin = std::io::stdin();
    let mut line = String::new();
    loop {
        print!("{} ", output::muted("?"));
        let _ = std::io::stdout().flush();
        line.clear();
        let n = stdin.lock().read_line(&mut line)?;
        match read_step(if n == 0 { None } else { Some(&line) }, turns.len()) {
            Step::Done => {
                // ctrl-d leaves the cursor after the prompt
                if n == 0 {
                    println!();
                }
                return Ok(());
            }
            Step::TooLong => {
                output::warn(&format!(
                    "question is too long ({MAX_QUESTION} characters max)"
                ));
            }
            Step::Full => {
                output::info("conversation is full, run wh explain again to start over");
                return Ok(());
            }
            Step::Ask(q) => {
                turns.push(llm::Turn::user(q));
                let text = ask(provider, model, &system, turns)?;
                turns.push(llm::Turn::assistant(text));
            }
        }
    }
}

/// Streams chunks to stdout line by line, painting the contract's section
/// labels amber like the landing demo.
struct LinePrinter {
    buf: String,
    colored: bool,
}

impl LinePrinter {
    fn new(colored: bool) -> Self {
        LinePrinter {
            buf: String::new(),
            colored,
        }
    }

    fn push(&mut self, chunk: &str) {
        for c in chunk.chars() {
            if c == '\n' {
                let line = std::mem::take(&mut self.buf);
                println!("{}", self.paint(&line));
            } else {
                self.buf.push(c);
            }
        }
    }

    fn paint(&self, line: &str) -> String {
        if self.colored && LABELS.contains(&line.trim_end()) {
            format!("\x1b[33m{line}\x1b[0m")
        } else {
            line.to_string()
        }
    }

    fn finish(&mut self) {
        if !self.buf.is_empty() {
            let line = std::mem::take(&mut self.buf);
            println!("{}", self.paint(&line));
        }
        let _ = std::io::stdout().flush();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_step_ends_on_eof_and_an_empty_line() {
        assert_eq!(read_step(None, 2), Step::Done);
        assert_eq!(read_step(Some("\n"), 2), Step::Done);
        assert_eq!(read_step(Some("   \n"), 2), Step::Done);
    }

    #[test]
    fn read_step_trims_and_caps() {
        assert_eq!(
            read_step(Some("  why is that risky?\n"), 2),
            Step::Ask("why is that risky?".to_string())
        );
        let long = "x".repeat(MAX_QUESTION + 1);
        assert_eq!(read_step(Some(&long), 2), Step::TooLong);
        assert_eq!(read_step(Some("still here?\n"), MAX_TURNS), Step::Full);
    }
}

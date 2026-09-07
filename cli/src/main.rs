mod cli;
mod commands;
mod envfiles;
mod git;
mod llm;
mod naming;
mod output;
mod preprocess;
mod usage;

use clap::Parser;
use std::fmt;

#[derive(Debug)]
pub enum WhError {
    NotARepo,
    Git { stderr: String },
    Msg(String),
    Io(std::io::Error),
}

impl fmt::Display for WhError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            WhError::NotARepo => write!(f, "not a git repository"),
            WhError::Git { stderr } => {
                let line = stderr.lines().next().unwrap_or("git failed");
                write!(f, "{}", line.strip_prefix("fatal: ").unwrap_or(line))
            }
            WhError::Msg(m) => write!(f, "{m}"),
            WhError::Io(e) => write!(f, "{e}"),
        }
    }
}

impl From<std::io::Error> for WhError {
    fn from(e: std::io::Error) -> Self {
        WhError::Io(e)
    }
}

fn main() {
    let args = cli::Cli::parse();
    let res = match &args.cmd {
        cli::Cmd::New { branch, from } => commands::new::run(branch, from.as_deref()),
        cli::Cmd::Ls => commands::ls::run(),
        cli::Cmd::Switch { query } => commands::switch::run(query.as_deref()),
        cli::Cmd::Init { shell } => commands::init::run(shell),
        cli::Cmd::Explain {
            range,
            dry_run,
            changelog,
            describe,
            uncommitted,
            chat,
            paths,
        } => {
            let mode = if *describe {
                llm::Mode::Describe
            } else if *changelog {
                llm::Mode::Changelog
            } else {
                llm::Mode::Explain
            };
            commands::explain::run(range.as_deref(), *dry_run, mode, *uncommitted, *chat, paths)
        }
        cli::Cmd::Why {
            target,
            dry_run,
            chat,
        } => commands::why::run(target, *dry_run, *chat),
        cli::Cmd::Rm {
            name,
            dry_run,
            yes,
            force,
        } => commands::rm::run(name.as_deref(), *dry_run, *yes, *force),
    };
    if let Err(e) = res {
        output::error(&e.to_string());
        std::process::exit(1);
    }
}

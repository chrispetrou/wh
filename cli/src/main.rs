mod cli;
mod commands;
mod envfiles;
mod git;
mod llm;
mod naming;
mod output;
mod preprocess;

use clap::Parser;
use std::fmt;

#[derive(Debug)]
pub enum WdError {
    NotARepo,
    Git { stderr: String },
    Msg(String),
    Io(std::io::Error),
}

impl fmt::Display for WdError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            WdError::NotARepo => write!(f, "not a git repository"),
            WdError::Git { stderr } => {
                let line = stderr.lines().next().unwrap_or("git failed");
                write!(f, "{}", line.strip_prefix("fatal: ").unwrap_or(line))
            }
            WdError::Msg(m) => write!(f, "{m}"),
            WdError::Io(e) => write!(f, "{e}"),
        }
    }
}

impl From<std::io::Error> for WdError {
    fn from(e: std::io::Error) -> Self {
        WdError::Io(e)
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
        } => commands::explain::run(range.as_deref(), *dry_run, *changelog),
        cli::Cmd::Rm {
            name,
            dry_run,
            yes,
            force,
        } => commands::rm::run(name.as_deref(), *dry_run, *yes, *force),
    };
    if let Err(e) = res {
        eprintln!("{e}");
        std::process::exit(1);
    }
}

use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(
    name = "wh",
    version,
    about = "tiny git companion",
    disable_help_subcommand = true,
    max_term_width = 80
)]
pub struct Cli {
    #[command(subcommand)]
    pub cmd: Cmd,
}

#[derive(Subcommand)]
pub enum Cmd {
    /// create a worktree for <branch> in a sibling dir
    New {
        /// branch to check out (created from HEAD if missing)
        branch: String,
        /// ref to branch from when creating (default: HEAD)
        #[arg(long, value_name = "ref")]
        from: Option<String>,
    },
    /// list worktrees with status
    Ls,
    /// pick a worktree and print its path (cd via the shell wrapper)
    Switch {
        /// filter; a unique match prints straight away, no picker
        query: Option<String>,
    },
    /// print the shell wrapper that makes `wh switch` cd for you
    Init {
        /// zsh, bash, or fish
        shell: String,
    },
    /// explain a diff range in plain english (byo llm key, or local ollama)
    #[command(after_help = "\
keys via env: ANTHROPIC_API_KEY, OPENAI_API_KEY, or GROQ_API_KEY (free tier
at console.groq.com). none set: local ollama. WH_PROVIDER forces one,
WH_MODEL overrides the model.")]
    Explain {
        /// range like main..dev or HEAD~3.. (default HEAD~1..; with
        /// --describe, the default branch...HEAD); a bare ref means
        /// <ref>..HEAD
        range: Option<String>,
        /// print the preprocessed payload instead of querying the model
        #[arg(long)]
        dry_run: bool,
        /// release notes (added, changed, fixed, removed) instead of a review
        #[arg(long)]
        changelog: bool,
        /// a pull request title and description to paste, instead of a
        /// review
        #[arg(long, conflicts_with = "changelog")]
        describe: bool,
        /// staged and unstaged work instead of a range (git diff HEAD)
        #[arg(long, conflicts_with = "range")]
        uncommitted: bool,
        /// keep asking follow-up questions after the answer
        #[arg(long, conflicts_with = "dry_run")]
        chat: bool,
        /// limit to these paths (a git pathspec, after --)
        #[arg(last = true, value_name = "pathspec")]
        paths: Vec<String>,
    },
    /// explain why a line of code exists (git blame, then the commit
    /// that last touched it)
    Why {
        /// path:line, or path:first-last
        target: String,
        /// print the preprocessed payload instead of querying the model
        #[arg(long)]
        dry_run: bool,
        /// keep asking follow-up questions after the answer
        #[arg(long, conflicts_with = "dry_run")]
        chat: bool,
    },
    /// list the models the provider offers
    #[command(after_help = "\
the same key and base url wh explain uses (WH_PROVIDER picks the provider,
WH_MODEL the model). ids on stdout, so `wh models | grep` works.")]
    Models,
    /// remove worktrees whose branches are merged
    Rm {
        /// branch or directory of a specific worktree to remove
        name: Option<String>,
        /// show what would be removed without removing
        #[arg(long)]
        dry_run: bool,
        /// skip the confirmation prompt
        #[arg(long)]
        yes: bool,
        /// remove even if dirty or unmerged
        #[arg(long, requires = "name")]
        force: bool,
    },
}

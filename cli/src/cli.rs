use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(
    name = "wd",
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

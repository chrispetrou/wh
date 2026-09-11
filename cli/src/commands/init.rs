use crate::WhError;

// only an interactive shell cds: a script, or an agent's shell that
// sourced the rc file, gets the path on stdout like the bare binary
const POSIX_WRAPPER: &str = r#"# wh shell integration: add to your rc file
#   eval "$(wh init zsh)"
wh() {
  case "$1:$-" in
    switch:*i*)
      local _wh_dir
      _wh_dir="$(command wh "$@")" && cd "$_wh_dir"
      ;;
    *)
      command wh "$@"
      ;;
  esac
}
"#;

const FISH_WRAPPER: &str = r#"# wh shell integration: add to your config.fish
#   wh init fish | source
function wh
    if status is-interactive; and test (count $argv) -ge 1; and test "$argv[1]" = switch
        set -l _wh_dir (command wh $argv)
        and cd $_wh_dir
    else
        command wh $argv
    end
end
"#;

pub fn run(shell: &str) -> Result<(), WhError> {
    match shell {
        "zsh" | "bash" => print!("{POSIX_WRAPPER}"),
        "fish" => print!("{FISH_WRAPPER}"),
        _ => {
            return Err(WhError::Msg(format!(
                "unsupported shell '{shell}' (zsh, bash, fish)"
            )))
        }
    }
    Ok(())
}

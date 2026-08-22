use crate::WdError;

const POSIX_WRAPPER: &str = r#"# wd shell integration: add to your rc file
#   eval "$(wd init zsh)"
wd() {
  if [ "$1" = "switch" ]; then
    local _wd_dir
    _wd_dir="$(command wd "$@")" && cd "$_wd_dir"
  else
    command wd "$@"
  fi
}
"#;

const FISH_WRAPPER: &str = r#"# wd shell integration: add to your config.fish
#   wd init fish | source
function wd
    if test (count $argv) -ge 1; and test "$argv[1]" = switch
        set -l _wd_dir (command wd $argv)
        and cd $_wd_dir
    else
        command wd $argv
    end
end
"#;

pub fn run(shell: &str) -> Result<(), WdError> {
    match shell {
        "zsh" | "bash" => print!("{POSIX_WRAPPER}"),
        "fish" => print!("{FISH_WRAPPER}"),
        _ => {
            return Err(WdError::Msg(format!(
                "unsupported shell '{shell}' (zsh, bash, fish)"
            )))
        }
    }
    Ok(())
}

use crate::WhError;

const POSIX_WRAPPER: &str = r#"# wh shell integration: add to your rc file
#   eval "$(wh init zsh)"
wh() {
  if [ "$1" = "switch" ]; then
    local _wh_dir
    _wh_dir="$(command wh "$@")" && cd "$_wh_dir"
  else
    command wh "$@"
  fi
}
"#;

const FISH_WRAPPER: &str = r#"# wh shell integration: add to your config.fish
#   wh init fish | source
function wh
    if test (count $argv) -ge 1; and test "$argv[1]" = switch
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

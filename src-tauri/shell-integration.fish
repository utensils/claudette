# Claudette shell integration for fish
# This script enables command tracking and exit code reporting.

function __claudette_prompt_start --on-event fish_prompt
    printf '\033]133;A\007'
end

# Emit B, explicit command text via E, and C in preexec
# Fish provides the command in $argv
function __claudette_preexec --on-event fish_preexec
    printf '\033]133;B\007'
    # URL-encode command to handle special characters using fish built-in
    set cmd (string join ' ' $argv)
    set cmd_encoded (string escape --style=url -- $cmd)
    if test -n "$cmd_encoded"
        printf '\033]133;E;%s\007' "$cmd_encoded"
    end
    printf '\033]133;C\007'
end

function __claudette_postexec --on-event fish_postexec
    printf '\033]133;D;%s\007' $status
end

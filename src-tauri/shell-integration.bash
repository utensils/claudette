#!/bin/bash
# Claudette shell integration for bash
# This script enables command tracking and exit code reporting.

_claudette_command_finished() {
    local exit_code=$?
    printf '\033]133;D;%s\007' "$exit_code"
    return $exit_code
}

# Hook into bash prompt system
if [[ -z "$PROMPT_COMMAND" ]]; then
    PROMPT_COMMAND="_claudette_command_finished"
else
    PROMPT_COMMAND="${PROMPT_COMMAND%;}; _claudette_command_finished"
fi

# Emit A (prompt start) at the beginning of the prompt
PS1='\[\033]133;A\007\]'"${PS1}"

# PS0 is executed after command line is read, before execution
# Bash doesn't let us emit B before user input, so we use an extended
# format: OSC 133;E;command to send the command text explicitly
# We also emit B and C for compatibility
_claudette_ps0() {
    # URL-encode the command to avoid issues with special characters
    local cmd_encoded=$(printf '%s' "$BASH_COMMAND" | jq -sRr @uri 2>/dev/null || echo "")
    printf '\033]133;B\007'
    if [[ -n "$cmd_encoded" ]]; then
        printf '\033]133;E;%s\007' "$cmd_encoded"
    fi
    printf '\033]133;C\007'
}
PS0='$(_claudette_ps0)'

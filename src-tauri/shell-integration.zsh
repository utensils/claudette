# Claudette shell integration for zsh
# This script enables command tracking and exit code reporting.

_claudette_precmd() {
    local exit_code=$?
    printf '\033]133;D;%s\007' "$exit_code"
    printf '\033]133;A\007'  # Prompt starts
    return $exit_code
}

_claudette_preexec() {
    printf '\033]133;C\007'  # Command output starts
}

# Add hooks
autoload -Uz add-zsh-hook
add-zsh-hook precmd _claudette_precmd
add-zsh-hook preexec _claudette_preexec

# Embed B marker (command start) at the END of the prompt
# Use %{...%} to mark as non-printing for correct width calculation
PS1="${PS1}"'%{$(printf "\033]133;B\007")%}'

-- env-nix-devshell plugin for Claudette.
--
-- Activates a Nix devshell for users who keep their toolchain in a
-- `flake.nix` (or legacy `shell.nix`).
--
-- Detection is a pure function of what's on disk: if `flake.nix` or
-- `shell.nix` exists, we detect. We deliberately do NOT back off when
-- `.envrc` is present — instead, precedence handles the overlap:
-- `env-direnv` outranks `env-nix-devshell`, so when an `.envrc` does
-- `use flake` and both plugins export, direnv's values win on key
-- collisions at merge time. Users who want only one can toggle the
-- other off in the Environment settings panel.
--
-- Export happens in two steps:
--
--   1. `nix print-dev-env --json` emits
--      `{ variables: { NAME: { type, value } } }`. We keep only
--      `exported`/`var`-typed string values — array and associative
--      types (Bash-specific) don't round-trip to a child process env.
--      A denylist drops nix-build sandbox / bash-internal vars
--      (HOME=/homeless-shelter, SHELL=/sbin/nologin,
--      TMPDIR=/private/tmp/nix-build-…, etc.) that `print-dev-env`
--      emits before the stdenv setup hook fills them in — propagating
--      them would clobber the caller's real env (notably HOME, which
--      `claude` needs to find `~/.claude/.credentials.json`).
--
--   2. `PATH` is on that denylist too, but for a different reason:
--      `--json` reports it as the build-sandbox placeholder
--      `/path-not-set`. The *real* devshell PATH is assembled by
--      stdenv's setup hook at runtime, which `--json` never runs. So
--      after step 1 we enter the devshell for real — `nix develop
--      --command sh -c 'printf %s "$PATH"'` — and capture the
--      fully-assembled PATH. The probe inherits Claudette's enriched
--      PATH, so the devshell's tool dirs come back already prepended
--      to the host PATH (a merge, not a replacement); `cargo`, `node`,
--      project binaries, etc. then resolve in both terminals and agent
--      commands. See issue #915.
--
-- If the step-2 probe fails we keep the step-1 vars and just omit
-- PATH (logged as a warning) rather than failing the whole provider —
-- the build/compile vars are still worth contributing on their own.

local M = {}

-- Vars that `nix print-dev-env` populates with sandbox / bash-builtin
-- defaults. Keeping them would clobber the caller's real env. Mirrors
-- nix-direnv's hidden_vars list. `PATH` is here because its `--json`
-- value is the `/path-not-set` placeholder; the real PATH is recovered
-- separately via `devshell_path` below.
local SANDBOX_VARS = {
    BASH = true,
    BASHOPTS = true,
    HOME = true,
    HOSTTYPE = true,
    IFS = true,
    LINENO = true,
    MACHTYPE = true,
    NIX_BUILD_CORES = true,
    NIX_BUILD_TOP = true,
    NIX_ENFORCE_PURITY = true,
    NIX_LOG_FD = true,
    NIX_STORE = true,
    OLDPWD = true,
    OPTERR = true,
    OSTYPE = true,
    PATH = true,
    PPID = true,
    PS1 = true,
    PS2 = true,
    PS3 = true,
    PS4 = true,
    PWD = true,
    SHELL = true,
    SHELLOPTS = true,
    SHLVL = true,
    TEMP = true,
    TEMPDIR = true,
    TERM = true,
    TMP = true,
    TMPDIR = true,
    -- Derivation attrs leaked through `nix print-dev-env` as vars.
    builder = true,
    dontAddDisableDepTrack = true,
    name = true,
    out = true,
    outputs = true,
    shellHook = true,
    stdenv = true,
    system = true,
}

local function join(dir, name)
    return dir .. "/" .. name
end

-- The env-provider dispatcher historically injects `args.worktree`
-- into every call. Other callers (e.g. `claudette plugin invoke`)
-- don't, so prefer the always-populated `host.workspace()` and only
-- fall back to `args.worktree` for backwards compat.
local function worktree_of(args)
    return (args and args.worktree) or host.workspace().worktree_path
end

function M.detect(args)
    local wt = worktree_of(args)
    return host.file_exists(join(wt, "flake.nix"))
        or host.file_exists(join(wt, "shell.nix"))
end

-- Probe the devshell's fully-assembled PATH by entering it for real.
--
-- `nix print-dev-env --json` can't give us this (see the module
-- comment): it reports PATH as `/path-not-set`. `nix develop --command`
-- sources the dev environment — running the stdenv setup hook that
-- assembles PATH — then runs our probe inside it.
--
-- `installable_args` selects the same devshell `print-dev-env` used:
-- `{}` for an auto-discovered flake.nix, `{ "-f", "<shell.nix>" }` for
-- a legacy shell.nix.
--
-- Returns the PATH string on success, or nil if the probe failed — the
-- caller keeps the rest of the devshell env and just skips PATH.
local function devshell_path(installable_args)
    local probe = { "develop" }
    for _, arg in ipairs(installable_args) do
        table.insert(probe, arg)
    end
    -- `--command` consumes the rest as the command to run inside the
    -- devshell. `printf %s` prints $PATH verbatim with no trailing
    -- newline and no format-string surprises (PATH is the data arg,
    -- not the format); `sh` always resolves because every devshell
    -- ships a shell.
    table.insert(probe, "--command")
    table.insert(probe, "sh")
    table.insert(probe, "-c")
    table.insert(probe, [[printf %s "$PATH"]])

    -- pcall: a probe timeout (or any other `host.exec` error) must
    -- degrade to "no PATH", never abort the whole export.
    local ok, result = pcall(host.exec, "nix", probe)
    if not ok then
        host.log("warn", "nix develop PATH probe errored: " .. tostring(result))
        return nil
    end
    if result.code ~= 0 then
        host.log("warn", "nix develop PATH probe exited with code "
            .. tostring(result.code) .. ": "
            .. (result.stderr or result.stdout or "no output"))
        return nil
    end

    -- Split on ':' and drop empty segments plus any lingering
    -- `/path-not-set` placeholder. A real `nix develop` shell assembles
    -- a usable PATH, but a degenerate devShell with no PATH-contributing
    -- inputs could leave the placeholder behind — never propagate it.
    local dirs = {}
    for segment in tostring(result.stdout or ""):gmatch("[^:]+") do
        if segment ~= "/path-not-set" then
            table.insert(dirs, segment)
        end
    end
    if #dirs == 0 then
        host.log("warn", "nix develop PATH probe returned an empty PATH")
        return nil
    end
    return table.concat(dirs, ":")
end

function M.export(args)
    -- `nix print-dev-env --json` auto-discovers only flake.nix. For
    -- legacy `shell.nix`-only repos we must pass `-f shell.nix`
    -- explicitly; otherwise nix errors with "could not find a
    -- flake.nix" even though detect said the repo was eligible.
    -- `installable_args` captures that selection so the `nix develop`
    -- PATH probe (devshell_path) targets the exact same devshell.
    local wt = worktree_of(args)
    local flake_path = join(wt, "flake.nix")
    local shell_path = join(wt, "shell.nix")
    -- `-L` (`--print-build-logs`) routes per-derivation build output
    -- to stderr so a cold flake's 30-90s evaluation isn't a silent
    -- void in the EnvProvisioningConsole. Streaming forwards each
    -- line to the panel as it's emitted; the eventual JSON env stays
    -- on stdout (and inside `result.stdout`) for parsing below.
    local installable_args
    local result
    if host.file_exists(flake_path) then
        installable_args = {}
        result = host.exec_streaming("nix", { "print-dev-env", "--json", "-L" })
    elseif host.file_exists(shell_path) then
        installable_args = { "-f", shell_path }
        result = host.exec_streaming("nix", { "print-dev-env", "--json", "-L", "-f", shell_path })
    else
        error("nix print-dev-env failed: neither flake.nix nor shell.nix present at export time")
    end

    if result.code ~= 0 then
        error("nix print-dev-env failed: " .. (result.stderr or result.stdout or "unknown error"))
    end

    local parsed = host.json_decode(result.stdout)

    local env_map = {}
    if parsed.variables then
        for name, info in pairs(parsed.variables) do
            -- Only scalar strings — skip Bash arrays and associatives,
            -- which can't be represented as plain env vars anyway.
            -- Also skip nix-build sandbox / bash-builtin defaults
            -- (see SANDBOX_VARS) whose placeholder values would break
            -- subprocesses. PATH is on that denylist; its real value
            -- is recovered by `devshell_path` below.
            if type(info) == "table"
                and type(info.value) == "string"
                and (info.type == "exported" or info.type == "var")
                and not SANDBOX_VARS[name]
            then
                env_map[name] = info.value
            end
        end
    end

    -- Recover the real, fully-assembled devshell PATH. On probe failure
    -- we leave PATH unset rather than abort — the compile/build vars
    -- above are still worth contributing.
    local path = devshell_path(installable_args)
    if path then
        env_map["PATH"] = path
    end

    local watched = {}
    for _, name in ipairs({ "flake.nix", "flake.lock", "shell.nix" }) do
        local candidate = join(wt, name)
        if host.file_exists(candidate) then
            table.insert(watched, candidate)
        end
    end

    return {
        env = env_map,
        watched = watched,
    }
end

return M

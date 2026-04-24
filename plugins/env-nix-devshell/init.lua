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
-- Export: runs `nix print-dev-env --json` which emits
-- `{ variables: { NAME: { type, value } } }`. We keep only
-- `exported`/`var`-typed string values — array and associative types
-- (Bash-specific) don't round-trip cleanly to a child process env.

local M = {}

local function join(dir, name)
    return dir .. "/" .. name
end

function M.detect(args)
    return host.file_exists(join(args.worktree, "flake.nix"))
        or host.file_exists(join(args.worktree, "shell.nix"))
end

function M.export(args)
    local result = host.exec("nix", { "print-dev-env", "--json" })
    if result.code ~= 0 then
        error("nix print-dev-env failed: " .. (result.stderr or result.stdout or "unknown error"))
    end

    local parsed = host.json_decode(result.stdout)

    local env_map = {}
    if parsed.variables then
        for name, info in pairs(parsed.variables) do
            -- Only scalar strings — skip Bash arrays and associatives,
            -- which can't be represented as plain env vars anyway.
            if type(info) == "table"
                and type(info.value) == "string"
                and (info.type == "exported" or info.type == "var")
            then
                env_map[name] = info.value
            end
        end
    end

    local watched = {}
    for _, name in ipairs({ "flake.nix", "flake.lock", "shell.nix" }) do
        local path = join(args.worktree, name)
        if host.file_exists(path) then
            table.insert(watched, path)
        end
    end

    return {
        env = env_map,
        watched = watched,
    }
end

return M

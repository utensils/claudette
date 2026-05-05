-- env-mise plugin for Claudette.
--
-- Detects any of `mise.toml`, `.mise.toml`, `.tool-versions` in the
-- worktree root. On export, runs `mise env --json` which returns a flat
-- `{VAR: "value"}` map (including the merged PATH).

local M = {}

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

-- Config files in order of mise's own precedence.
local CONFIG_FILES = { "mise.toml", ".mise.toml", ".tool-versions" }

function M.detect(args)
    local wt = worktree_of(args)
    for _, name in ipairs(CONFIG_FILES) do
        if host.file_exists(join(wt, name)) then
            return true
        end
    end
    return false
end

function M.export(args)
    local result = host.exec("mise", { "env", "--json" })

    -- Auto-trust opt-in: when mise reports config files as not trusted
    -- and the user has enabled auto_trust, run `mise trust` once and
    -- retry. Single retry avoids an infinite loop if trust fails for
    -- another reason.
    if result.code ~= 0
        and host.config("auto_trust") == true
        and (result.stderr or ""):match("not trusted") then
        host.exec("mise", { "trust" })
        result = host.exec("mise", { "env", "--json" })
    end

    if result.code ~= 0 then
        -- Common causes: config not trusted (run `mise trust`) or
        -- malformed TOML. Surface stderr verbatim.
        error("mise env failed: " .. (result.stderr or result.stdout or "unknown error"))
    end

    local env_map = host.json_decode(result.stdout)

    -- Watch all known config files — mise may use whichever is present.
    local watched = {}
    local wt = worktree_of(args)
    for _, name in ipairs(CONFIG_FILES) do
        local path = join(wt, name)
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

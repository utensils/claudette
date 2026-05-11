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

    -- Per-repo trust: when mise reports config files as not trusted
    -- and the user has authorized mise for this repository (via the
    -- one-time per-repo trust prompt), run `mise trust` and retry.
    -- Single retry avoids an infinite loop if trust fails for another
    -- reason.
    if result.code ~= 0
        and host.config("repo_trust") == "allow"
        and (result.stderr or ""):match("not trusted") then
        host.exec("mise", { "trust" })
        result = host.exec("mise", { "env", "--json" })
    end

    if result.code ~= 0 then
        -- Common causes: config not trusted (run `mise trust`) or
        -- malformed TOML.
        --
        -- For the trust case, mise's stderr is the verbose three-line
        -- form: "error parsing config file: <path>" / "Config files in
        -- <path> are not trusted." / "Run with --verbose…". The middle
        -- line is the only one the user / UI cares about — pull just
        -- that line up so the Lua `error()` doesn't blast all three
        -- through the Luau call-frame wrapper. Rust's
        -- `clean_trust_error_excerpt` still handles unknown variants
        -- and third-party env-providers, but the bundled plugins
        -- shouldn't depend on that to look presentable.
        local stderr = result.stderr or result.stdout or "unknown error"
        local trust_line = stderr:match(
            "Config files in [^\n]+ are not trusted[^\n]*"
        )
        if trust_line then
            error(trust_line)
        else
            error(stderr)
        end
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

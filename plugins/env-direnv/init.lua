-- env-direnv plugin for Claudette.
--
-- Activates direnv-managed environment for workspace subprocesses.
-- Detects when a `.envrc` file exists in the worktree root. On export,
-- runs `direnv export json` (which returns `{VAR: "value" | null}`) and
-- forwards that straight to the dispatcher.
--
-- The returned watch list includes `.envrc` plus every path direnv
-- itself tracks via `DIRENV_WATCHES` (decoded from the exported env).
-- That covers user-level `watch_file` directives and nested files that
-- `.envrc` sources — editing `secret.env` under `dotenv secret.env`
-- invalidates the cache just like editing `.envrc` itself.

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

function M.detect(args)
    return host.file_exists(join(worktree_of(args), ".envrc"))
end

function M.export(args)
    local result = host.exec("direnv", { "export", "json" })

    -- If the .envrc is blocked and the user has previously trusted
    -- direnv for this repository (via the per-repo trust prompt), run
    -- `direnv allow` once and retry. direnv hashes the .envrc path so
    -- each worktree is approved independently; the repo-scoped trust
    -- decision means Claudette automates that per-worktree approval
    -- on the user's behalf, but ONLY for repos they explicitly
    -- authorized. Retry once to avoid infinite loops if `allow`
    -- fails to unblock for some reason.
    if result.code ~= 0
        and host.config("repo_trust") == "allow"
        and (result.stderr or ""):match("is blocked") then
        host.exec("direnv", { "allow" })
        result = host.exec("direnv", { "export", "json" })
    end

    if result.code ~= 0 then
        -- Non-zero exit from `direnv export json` usually means the
        -- `.envrc` hasn't been allowed yet. Propagate the stderr so the
        -- UI can surface a "run direnv allow" hint.
        error("direnv export failed: " .. (result.stderr or result.stdout or "unknown error"))
    end

    -- Empty stdout = no vars to export (e.g. `.envrc` exists but is
    -- empty, or direnv is silently allowing without any exports).
    local env_map = {}
    if result.stdout and #result.stdout > 0 then
        env_map = host.json_decode(result.stdout)
    end

    -- Seed with `.envrc` unconditionally — it's always a watch target.
    -- Then merge in whatever direnv itself tracks via `DIRENV_WATCHES`
    -- (user `watch_file` directives, files sourced by `dotenv ...`,
    -- direnv's own allow/deny cache entries whose mtime flips when the
    -- user runs `direnv allow`/`deny`). Dedupe so `.envrc` isn't listed
    -- twice when direnv includes it too.
    local watched = {}
    local seen = {}
    local function add(path)
        if path and not seen[path] then
            seen[path] = true
            table.insert(watched, path)
        end
    end
    add(join(worktree_of(args), ".envrc"))
    local direnv_watches = env_map["DIRENV_WATCHES"]
    if type(direnv_watches) == "string" and #direnv_watches > 0 then
        for _, path in ipairs(host.direnv_decode_watches(direnv_watches)) do
            add(path)
        end
    end

    return {
        env = env_map,
        watched = watched,
    }
end

return M

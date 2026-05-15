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
    local envrc_path = join(worktree_of(args), ".envrc")
    -- Streaming so direnv's own informative stderr (e.g.
    -- `direnv: loading .envrc`, `direnv: using flake`, the `+VAR -VAR`
    -- diff) flows into the EnvProvisioningConsole as it happens. The
    -- captured stdout/stderr in `result` is identical to what
    -- `host.exec` would have returned.
    local result = host.exec_streaming("direnv", { "export", "json" })

    -- If the .envrc is blocked, auto-allow only when this exact file
    -- content has already been approved for the repo. This preserves
    -- the convenience of future worktrees with identical .envrc
    -- content while still forcing a fresh review when the .envrc
    -- changes. Retry once to avoid infinite loops if `allow` fails to
    -- unblock for some reason.
    if result.code ~= 0 and (result.stderr or ""):match("is blocked") then
        local approved = host.config("approved_envrc_sha256s")
        local current = host.sha256_file(envrc_path)
        local allowed = false
        if type(approved) == "table" then
            for _, digest in ipairs(approved) do
                if digest == current then
                    allowed = true
                    break
                end
            end
        end
        if allowed then
            host.exec_streaming("direnv", { "allow" })
            result = host.exec_streaming("direnv", { "export", "json" })
        end
    end

    if result.code ~= 0 then
        -- Non-zero exit from `direnv export json` usually means the
        -- `.envrc` hasn't been allowed yet. For the trust case,
        -- direnv's stderr is typically the single line
        --   "direnv: error <path> is blocked. Run `direnv allow` ..."
        -- preceded by setup chatter (loading messages, watch logs).
        -- Surface just that one canonical line so the upstream display
        -- (toast or trust modal) doesn't have to parse around the
        -- noise. Rust's `clean_trust_error_excerpt` still handles
        -- third-party plugins; this is a Claudette-bundled-plugin
        -- presentation tightening.
        local stderr = result.stderr or result.stdout or "unknown error"
        local blocked_line = stderr:match("direnv: error [^\n]+ is blocked[^\n]*")
        if blocked_line then
            error(blocked_line)
        else
            error(stderr)
        end
    end

    -- Empty stdout = no vars to export (e.g. `.envrc` exists but is
    -- empty, or direnv is silently allowing without any exports).
    local raw_env = {}
    if result.stdout and #result.stdout > 0 then
        raw_env = host.json_decode(result.stdout)
    end

    -- Seed with `.envrc` unconditionally — it's always a watch target.
    -- Then merge in whatever direnv itself tracks via `DIRENV_WATCHES`
    -- (user `watch_file` directives, files sourced by `dotenv ...`).
    -- Dedupe so `.envrc` isn't listed twice when direnv includes it too.
    --
    -- We deliberately DROP direnv's own per-`.envrc` allow/deny stamps
    -- (the `<data_dir>/direnv/allow/<sha>` / `<data_dir>/direnv/deny/<sha>`
    -- files) from the watch list, even though direnv reports them in
    -- `DIRENV_WATCHES` for its shell-hook's "re-evaluate on permission
    -- change" semantics. The host watcher (`src/env_provider/watcher.rs`)
    -- subscribes AFTER `cache.put` stores the entry, and on macOS
    -- FSEvents reliably delivers the write event from the `direnv allow`
    -- call we just made (when an approved `.envrc` digest retries a
    -- blocked export above) shortly after — which fires `on_change` and
    -- evicts the cache entry we just populated. Net effect was a 5s
    -- cold export on every workspace switch even when the underlying
    -- `.envrc` / `flake.lock` hadn't changed. The "Reload env" UI action
    -- and our own per-repo trust state cover the rare case where the
    -- user revokes direnv permission manually; we don't need to react
    -- to the stamp file's mtime to stay correct.
    -- Stamps live at `<direnv_data_dir>/allow/<sha>` or
    -- `<direnv_data_dir>/deny/<sha>`. The basename is a SHA256 hash of
    -- the `.envrc` path (64 hex chars in current direnv; we accept any
    -- run of 32+ lowercase hex chars to stay tolerant if direnv ever
    -- truncates or upgrades the hash). The two-part check — adjacent
    -- `direnv/allow|deny/` segments AND a hex-hash basename — keeps
    -- the filter scoped to direnv's own data dir even when a user has
    -- a worktree path that contains the substring `/direnv/allow/`
    -- (e.g. working on direnv itself, or a `watch_file` target that
    -- lives under such a directory). Without the basename check, a
    -- legitimate `<repo>/direnv/allow/.envrc` would be silently
    -- dropped from `watched`, leaving the EnvCache unable to notice
    -- .envrc edits until the user hit Reload — a worse failure mode
    -- than the cache thrash this filter exists to prevent.
    local function is_direnv_stamp(path)
        if type(path) ~= "string" then return false end
        local under_stamp_dir = path:find("/direnv/allow/", 1, true) ~= nil
            or path:find("/direnv/deny/", 1, true) ~= nil
        if not under_stamp_dir then return false end
        local basename = path:match("([^/]+)$")
        if not basename then return false end
        -- 32+ lowercase hex characters, nothing else. Tight enough to
        -- exclude human-readable filenames; loose enough to survive a
        -- hash-format change in direnv.
        return basename:match("^[0-9a-f]+$") ~= nil and #basename >= 32
    end
    local watched = {}
    local seen = {}
    local function add(path)
        if path and not seen[path] and not is_direnv_stamp(path) then
            seen[path] = true
            table.insert(watched, path)
        end
    end
    add(envrc_path)
    local direnv_watches = raw_env["DIRENV_WATCHES"]
    if type(direnv_watches) == "string" and #direnv_watches > 0 then
        for _, path in ipairs(host.direnv_decode_watches(direnv_watches)) do
            add(path)
        end
    end

    -- Strip direnv's internal markers (DIRENV_DIR, DIRENV_FILE,
    -- DIRENV_DIFF, DIRENV_WATCHES, etc.) before returning. These keys
    -- are how direnv's shell hook (`eval "$(direnv hook zsh)"`) decides
    -- "this directory is already loaded, skip re-export" — so leaking
    -- them into a PTY env makes the user's interactive shell short-
    -- circuit its first-prompt evaluation and never load the .envrc's
    -- shell-side artifacts (numtide/devshell's `menu` command,
    -- functions defined in the .envrc, etc.). The shell hook will
    -- emit these markers itself the first time it runs against a
    -- clean environment. They are also useless to the agent
    -- subprocess, which doesn't run a direnv hook.
    --
    -- Worse: when `direnv export json` fails to load the .envrc body
    -- (e.g. `use flake` couldn't find `nix` because Claudette was
    -- launched from Finder with launchd's stripped PATH and the env-
    -- provider host_exec couldn't recover it), direnv STILL emits the
    -- four markers as a "you tried to load" memo. Without this strip
    -- step, that failure surfaces as a silently broken interactive
    -- shell — env-provider returns "ok", PTY starts, direnv hook
    -- short-circuits on the markers, no real env ever loads.
    local env = {}
    for k, v in pairs(raw_env) do
        if not string.match(k, "^DIRENV_") then
            env[k] = v
        end
    end

    return {
        env = env,
        watched = watched,
    }
end

return M

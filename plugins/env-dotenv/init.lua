-- env-dotenv plugin for Claudette.
--
-- The no-external-dependency fallback: parses `.env` in-process using
-- `host.read_file` and a small KEY=VALUE parser. Useful for projects
-- that don't adopt direnv or mise but still keep secrets / config in a
-- `.env` file (e.g. Next.js, Django, Docker Compose conventions).
--
-- v1 scope:
-- - blank lines and lines starting with `#` are ignored
-- - optional `export` prefix is stripped (bash-compatible syntax)
-- - values wrapped in `"..."` or `'...'` are unquoted
-- - inline `  # comment` on an unquoted value is stripped
-- - NO interpolation: `${FOO}` / `$FOO` are passed through literally
-- - NO multi-line values (values that span physical lines)
--
-- Deliberately lowest precedence in the dispatcher: if you have direnv
-- or mise configured, those wrap your `.env` anyway.

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

local function trim(s)
    return (s:gsub("^%s+", ""):gsub("%s+$", ""))
end

-- Parse dotenv-style content. Returns a flat `{KEY: "value"}` table.
-- Exposed at module level so it can be unit-tested via the host API.
function M._parse(text)
    local env = {}
    for line in text:gmatch("[^\r\n]+") do
        local t = trim(line)
        if t ~= "" and not t:match("^#") then
            -- Strip optional `export` prefix
            local content = t:gsub("^export%s+", "")
            local key, value = content:match("^([A-Za-z_][A-Za-z0-9_]*)%s*=%s*(.*)$")
            if key then
                -- Quoted values: return contents verbatim (no comment stripping).
                local dquoted = value:match('^"(.-)"$')
                local squoted = value:match("^'(.-)'$")
                local stripped
                if dquoted then
                    stripped = dquoted
                elseif squoted then
                    stripped = squoted
                else
                    -- Unquoted: strip trailing inline comment (whitespace + `#`).
                    stripped = value:match("^(.-)%s+#") or value
                    stripped = trim(stripped)
                end
                env[key] = stripped
            end
        end
    end
    return env
end

function M.detect(args)
    return host.file_exists(join(worktree_of(args), ".env"))
end

function M.export(args)
    local path = join(worktree_of(args), ".env")
    local contents = host.read_file(path)
    local env = M._parse(contents)
    -- env-dotenv is in-process (no subprocess to stream), so it
    -- would otherwise render as an empty section in the
    -- EnvProvisioningConsole even when it found and parsed real
    -- vars. Emit one synthesized line so the user gets a clear "yes,
    -- this provider contributed" heartbeat regardless of how fast
    -- the parse was.
    local count = 0
    for _ in pairs(env) do count = count + 1 end
    if host.console ~= nil then
        host.console("stdout", "parsed " .. tostring(count) .. " var(s) from .env")
    end
    return {
        env = env,
        watched = { path },
    }
end

return M

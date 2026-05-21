local M = {}

local function glab(args)
    local result = host.exec("glab", args)
    if result.code ~= 0 then
        error("glab failed: " .. result.stderr)
    end
    return host.json_decode(result.stdout)
end

function M.list_pull_requests(args)
    -- Two call-sites: per-branch sidebar lookup (args.branch) and the
    -- repo-wide project-view aggregation (args.scope). Match the
    -- semantics of the GitHub plugin so the Rust side sees one shape.
    local limit = tostring(args.limit or 30)
    local glab_args = {
        "mr", "list",
        "--output-format", "json",
        "--per-page", limit,
    }
    if args.branch then
        -- All-state for the badge: a merged/closed MR on a branch
        -- should still resolve.
        table.insert(glab_args, "--all")
        table.insert(glab_args, "--source-branch")
        table.insert(glab_args, args.branch)
    elseif args.scope == "mine" then
        table.insert(glab_args, "--opened")
        table.insert(glab_args, "--mine")
    elseif args.scope == "review_requested" then
        table.insert(glab_args, "--opened")
        table.insert(glab_args, "--reviewer")
        table.insert(glab_args, "@me")
    else
        -- Default scope = "open".
        table.insert(glab_args, "--opened")
    end
    local data = glab(glab_args)
    local prs = {}
    for _, item in ipairs(data) do
        table.insert(prs, {
            number = item.iid,
            title = item.title,
            state = item.state == "opened" and "open" or item.state,
            url = item.web_url,
            author = item.author.username,
            branch = item.source_branch,
            base = item.target_branch,
            draft = item.draft or false,
        })
    end
    return prs
end

function M.list_issues(args)
    local limit = tostring(args.limit or 25)
    local state = args.state or "open"
    local glab_args = {
        "issue", "list",
        "--per-page", limit,
        "--output-format", "json",
    }
    if state == "open" then
        table.insert(glab_args, "--opened")
    elseif state == "closed" then
        table.insert(glab_args, "--closed")
    else
        table.insert(glab_args, "--all")
    end
    -- Mirror the GitHub plugin's three Issues-tab scopes:
    --   "mine"     → glab's `--mine` flag (authored by current user)
    --   "assigned" → `--assignee @me`
    --   anything else → no extra filter ("Open")
    if args.scope == "mine" then
        table.insert(glab_args, "--mine")
    elseif args.scope == "assigned" then
        table.insert(glab_args, "--assignee")
        table.insert(glab_args, "@me")
    end
    local ok, data = pcall(glab, glab_args)
    if not ok then
        error(data)
    end
    local issues = {}
    for _, item in ipairs(data) do
        local labels = {}
        -- glab returns labels as either an array of strings or an array of
        -- objects depending on version; normalize both shapes.
        for _, lbl in ipairs(item.labels or {}) do
            if type(lbl) == "table" then
                table.insert(labels, {
                    name = lbl.name or "",
                    color = (lbl.color and string.gsub(lbl.color, "^#", "")) or "",
                })
            else
                table.insert(labels, { name = tostring(lbl), color = "" })
            end
        end
        local author = nil
        if item.author and item.author.username then
            author = item.author.username
        end
        local state_norm = item.state or "open"
        if state_norm == "opened" then state_norm = "open" end
        local issue = {
            number = item.iid,
            title = item.title,
            url = item.web_url,
            state = state_norm,
            author = author,
            comment_count = item.user_notes_count or 0,
            created_at = item.created_at or "",
            updated_at = item.updated_at or "",
        }
        -- See scm-github/init.lua: empty Lua tables serialize as JSON
        -- `{}`, which fails Rust's Vec<IssueLabel> deserialization.
        -- Omit the key when empty and let serde's default kick in.
        if #labels > 0 then
            issue.labels = labels
        end
        table.insert(issues, issue)
    end
    return issues
end

function M.get_pull_request(args)
    local data = glab({
        "mr", "view", tostring(args.number),
        "--output-format", "json",
    })
    return {
        number = data.iid,
        title = data.title,
        state = data.state == "opened" and "open" or data.state,
        url = data.web_url,
        author = data.author.username,
        branch = data.source_branch,
        base = data.target_branch,
        draft = data.draft or false,
    }
end

-- Normalize glab's MR JSON shape to our canonical PullRequest fields.
local function normalize_mr(data)
    return {
        number = data.iid,
        title = data.title,
        state = data.state == "opened" and "open" or data.state,
        url = data.web_url,
        author = (data.author and data.author.username) or "",
        branch = data.source_branch or "",
        base = data.target_branch or "",
        draft = data.draft or false,
    }
end

function M.create_pull_request(args)
    local glab_args = {
        "mr", "create",
        "--title", args.title,
        "--description", args.body,
        "--source-branch", args.branch,
        "--target-branch", args.base,
        "--output-format", "json",
    }
    if args.draft then
        table.insert(glab_args, "--draft")
    end
    return normalize_mr(glab(glab_args))
end

function M.merge_pull_request(args)
    local data = glab({
        "mr", "merge", tostring(args.number),
        "--output-format", "json",
    })
    return normalize_mr(data)
end

-- Normalize GitLab job status to canonical CiCheckStatus values.
-- GitLab returns: created, pending, running, success, failed, canceled,
-- skipped, manual. Map them onto the five canonical CiCheckStatus
-- variants Rust consumes:
--   success                 → "success"
--   failed                  → "failure"
--   canceled                → "cancelled"  (note GitLab's "canceled" — single l)
--   skipped, manual         → "skipped"   (didn't run by design / awaiting manual trigger)
--   created, pending, running → "pending" (in-flight or queued)
-- "manual" is grouped with "skipped" because to the user a job that
-- requires manual triggering and hasn't been triggered behaves
-- identically to a skipped job — it isn't running, it isn't failing,
-- and it carries no signal until someone acts. Without this, both
-- "skipped" and "manual" fell through to "pending" and the UI rendered
-- merged-PR jobs as "Running".
local function normalize_job_status(status)
    local s = string.lower(status or "")
    if s == "success" then return "success" end
    if s == "failed" then return "failure" end
    if s == "canceled" then return "cancelled" end
    if s == "skipped" or s == "manual" then return "skipped" end
    return "pending"
end

function M.ci_status(args)
    local ok, data = pcall(glab, {
        "ci", "status",
        "--branch", args.branch,
        "--output-format", "json",
    })
    if not ok then
        host.log("warn", "ci_status failed for branch " .. tostring(args.branch) .. ": " .. tostring(data))
        return {}
    end
    local checks = {}
    for _, job in ipairs(data.jobs or {}) do
        table.insert(checks, {
            name = job.name,
            status = normalize_job_status(job.status),
            url = job.web_url,
        })
    end
    return checks
end

local MAX_LOG_CHARS = 4000

function M.ci_failure_logs(args)
    local ok, data = pcall(glab, {
        "ci", "status",
        "--branch", args.branch,
        "--output-format", "json",
    })
    if not ok then
        return {}
    end

    local wanted = {}
    for _, name in ipairs(args.failed_checks or {}) do
        wanted[name] = true
    end
    local has_wanted = next(wanted) ~= nil

    local logs = {}
    for _, job in ipairs(data.jobs or {}) do
        if string.lower(job.status or "") == "failed"
            and ((not has_wanted) or wanted[job.name])
        then
            local trace = host.exec("glab", {
                "ci", "trace", tostring(job.id),
                "--branch", args.branch,
            })
            if trace.code ~= 0 then
                host.log("warn", "ci_failure_logs failed for GitLab job "
                    .. tostring(job.id) .. ": " .. tostring(trace.stderr or ""))
            else
                local log_text = trace.stdout or ""
                if #log_text > MAX_LOG_CHARS then
                    log_text = string.sub(log_text, -MAX_LOG_CHARS)
                end
                if #log_text > 0 then
                    table.insert(logs, {
                        check_name = job.name,
                        log = log_text,
                        url = job.web_url,
                    })
                end
            end
        end
    end
    return logs
end

return M

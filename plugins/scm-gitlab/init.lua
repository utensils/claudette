local M = {}

local function glab(args)
    local result = host.exec("glab", args)
    if result.code ~= 0 then
        error("glab failed: " .. result.stderr)
    end
    return host.json_decode(result.stdout)
end

function M.list_pull_requests(args)
    local glab_args = {
        "mr", "list",
        "--state", "all",
        "--output-format", "json",
    }
    if args.branch then
        table.insert(glab_args, "--source-branch")
        table.insert(glab_args, args.branch)
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
-- GitLab returns: created, pending, running, success, failed, canceled, skipped, manual.
local function normalize_job_status(status)
    local s = string.lower(status or "")
    if s == "success" then return "success" end
    if s == "failed" then return "failure" end
    if s == "canceled" then return "cancelled" end
    return "pending"
end

function M.ci_status(args)
    local ok, data = pcall(glab, {
        "ci", "status",
        "--branch", args.branch,
        "--output-format", "json",
    })
    if not ok then
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

return M

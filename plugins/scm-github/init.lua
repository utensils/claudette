local M = {}

local function gh(args)
    local result = host.exec("gh", args)
    if result.code ~= 0 then
        error("gh failed: " .. result.stderr)
    end
    return host.json_decode(result.stdout)
end

function M.list_pull_requests(args)
    local gh_args = {
        "pr", "list",
        "--state", "all",
        "--json", "number,title,state,url,author,headRefName,baseRefName,isDraft,statusCheckRollup",
        "--limit", "30",
    }
    if args.branch then
        table.insert(gh_args, "--head")
        table.insert(gh_args, args.branch)
    end
    local data = gh(gh_args)
    local prs = {}
    for _, item in ipairs(data) do
        local ci = nil
        if item.statusCheckRollup and #item.statusCheckRollup > 0 then
            local all_pass = true
            local any_fail = false
            for _, check in ipairs(item.statusCheckRollup) do
                if check.conclusion == "FAILURE" then any_fail = true end
                if check.conclusion ~= "SUCCESS" then all_pass = false end
            end
            if any_fail then ci = "failure"
            elseif all_pass then ci = "success"
            else ci = "pending" end
        end
        table.insert(prs, {
            number = item.number,
            title = item.title,
            state = item.isDraft and "draft" or string.lower(item.state),
            url = item.url,
            author = item.author.login,
            branch = item.headRefName,
            base = item.baseRefName,
            draft = item.isDraft,
            ci_status = ci,
        })
    end
    return prs
end

function M.get_pull_request(args)
    local data = gh({
        "pr", "view", tostring(args.number),
        "--json", "number,title,state,url,author,headRefName,baseRefName,isDraft,statusCheckRollup",
    })
    local ci = nil
    if data.statusCheckRollup and #data.statusCheckRollup > 0 then
        local all_pass = true
        local any_fail = false
        for _, check in ipairs(data.statusCheckRollup) do
            if check.conclusion == "FAILURE" then any_fail = true end
            if check.conclusion ~= "SUCCESS" then all_pass = false end
        end
        if any_fail then ci = "failure"
        elseif all_pass then ci = "success"
        else ci = "pending" end
    end
    return {
        number = data.number,
        title = data.title,
        state = data.isDraft and "draft" or string.lower(data.state),
        url = data.url,
        author = data.author.login,
        branch = data.headRefName,
        base = data.baseRefName,
        draft = data.isDraft,
        ci_status = ci,
    }
end

function M.create_pull_request(args)
    local gh_args = {
        "pr", "create",
        "--title", args.title,
        "--body", args.body,
        "--base", args.base,
        "--json", "number,title,state,url,headRefName,baseRefName",
    }
    if args.draft then
        table.insert(gh_args, "--draft")
    end
    local data = gh(gh_args)
    return {
        number = data.number,
        title = data.title,
        state = args.draft and "draft" or "open",
        url = data.url,
        author = "",
        branch = data.headRefName,
        base = data.baseRefName,
        draft = args.draft or false,
    }
end

function M.merge_pull_request(args)
    local data = gh({
        "pr", "merge", tostring(args.number),
        "--merge",
        "--json", "number,title,state,url",
    })
    return {
        number = data.number,
        title = data.title,
        state = "merged",
        url = data.url,
        author = "",
        branch = "",
        base = "",
        draft = false,
    }
end

-- Normalize GitHub check state to canonical CiCheckStatus values.
-- gh returns: SUCCESS, FAILURE, PENDING, CANCELLED, ERROR, EXPECTED, STALE, etc.
local function normalize_check_status(state)
    local s = string.upper(state or "")
    if s == "SUCCESS" then return "success" end
    if s == "FAILURE" or s == "ERROR" then return "failure" end
    if s == "CANCELLED" or s == "CANCELED" then return "cancelled" end
    return "pending"
end

function M.ci_status(args)
    local ok, data = pcall(gh, {
        "pr", "checks", args.branch,
        "--json", "name,state,detailsUrl,startedAt",
    })
    if not ok then
        return {}
    end
    local checks = {}
    for _, item in ipairs(data) do
        table.insert(checks, {
            name = item.name,
            status = normalize_check_status(item.state),
            url = item.detailsUrl,
            started_at = item.startedAt,
        })
    end
    return checks
end

return M

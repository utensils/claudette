local M = {}

local function glab(args)
    local result = host.exec("glab", args)
    if result.code ~= 0 then
        error("glab failed: " .. result.stderr)
    end
    return host.json_decode(result.stdout)
end

function M.list_pull_requests(args)
    local data = glab({
        "mr", "list",
        "--output-format", "json",
    })
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
    return glab(glab_args)
end

function M.merge_pull_request(args)
    return glab({
        "mr", "merge", tostring(args.number),
        "--output-format", "json",
    })
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
            status = string.lower(job.status),
            url = job.web_url,
        })
    end
    return checks
end

return M

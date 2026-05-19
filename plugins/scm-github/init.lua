local M = {}

local function gh(args)
    local result = host.exec("gh", args)
    if result.code ~= 0 then
        error("gh failed: " .. result.stderr)
    end
    return host.json_decode(result.stdout)
end

function M.list_pull_requests(args)
    -- Two call-sites:
    --   1. per-workspace branch lookup (args.branch set) — feeds the
    --      sidebar PR badge. Keep the existing --state all behaviour so
    --      a merged/closed PR on a branch still resolves.
    --   2. project-view aggregation (args.scope set, no branch) —
    --      always open PRs, filtered by scope.
    local limit = tostring(args.limit or 30)
    local gh_args = {
        "pr", "list",
        "--json", "number,title,state,url,author,headRefName,baseRefName,isDraft,statusCheckRollup",
        "--limit", limit,
    }
    if args.branch then
        table.insert(gh_args, "--state")
        table.insert(gh_args, "all")
        table.insert(gh_args, "--head")
        table.insert(gh_args, args.branch)
    elseif args.scope == "mine" then
        table.insert(gh_args, "--state")
        table.insert(gh_args, "open")
        table.insert(gh_args, "--author")
        table.insert(gh_args, "@me")
    elseif args.scope == "review_requested" then
        -- `gh pr list --search` overrides --state, so embed the filter.
        table.insert(gh_args, "--search")
        table.insert(gh_args, "is:open is:pr review-requested:@me")
    else
        -- Default scope = "open" (also matches a missing scope arg).
        table.insert(gh_args, "--state")
        table.insert(gh_args, "open")
    end
    local data = gh(gh_args)
    local prs = {}
    for _, item in ipairs(data) do
        local ci = nil
        if item.statusCheckRollup and #item.statusCheckRollup > 0 then
            -- "SKIPPED" / "NEUTRAL" conclusions don't break "all pass":
            -- they're informational (workflow `if:` was false, action
            -- early-returned). Without this, a merged PR whose only
            -- non-success check was SKIPPED rolled up to "pending" and
            -- the PR card showed a phantom Running spinner.
            local all_pass = true
            local any_fail = false
            for _, check in ipairs(item.statusCheckRollup) do
                if check.conclusion == "FAILURE" then any_fail = true end
                if check.conclusion ~= "SUCCESS"
                    and check.conclusion ~= "SKIPPED"
                    and check.conclusion ~= "NEUTRAL"
                then
                    all_pass = false
                end
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

function M.list_issues(args)
    -- `gh issue list` excludes pull requests (unlike the REST /issues
    -- endpoint), so no extra filtering is needed. State defaults to
    -- open; callers can override via args.state.
    local limit = tostring(args.limit or 25)
    local state = args.state or "open"
    local gh_args = {
        "issue", "list",
        "--state", state,
        "--limit", limit,
        "--json", "number,title,url,state,author,labels,comments,createdAt,updatedAt",
    }
    local ok, data = pcall(gh, gh_args)
    if not ok then
        error(data)
    end
    local issues = {}
    for _, item in ipairs(data) do
        local labels = {}
        for _, lbl in ipairs(item.labels or {}) do
            table.insert(labels, {
                name = lbl.name,
                color = lbl.color or "",
            })
        end
        local author = nil
        if item.author and item.author.login then
            author = item.author.login
        end
        -- `gh issue list --json comments` returns the comments array
        -- itself, not a count. Use the array length so we send Rust a
        -- u32 (passing a table here makes the Issue fail to deserialize
        -- on the Rust side and silently drops every row).
        local comment_count = 0
        if type(item.comments) == "table" then
            comment_count = #item.comments
        elseif type(item.comments) == "number" then
            comment_count = item.comments
        end
        local issue = {
            number = item.number,
            title = item.title,
            url = item.url,
            state = string.lower(item.state or "open"),
            author = author,
            comment_count = comment_count,
            created_at = item.createdAt or "",
            updated_at = item.updatedAt or "",
        }
        -- mlua serializes empty Lua tables as JSON `{}` not `[]`, which
        -- fails Rust's Vec<IssueLabel> deserialization and silently
        -- drops the entire issue. Only attach `labels` when we have at
        -- least one entry; missing key + serde default = empty vec.
        if #labels > 0 then
            issue.labels = labels
        end
        table.insert(issues, issue)
    end
    return issues
end

function M.get_pull_request(args)
    local data = gh({
        "pr", "view", tostring(args.number),
        "--json", "number,title,state,url,author,headRefName,baseRefName,isDraft,statusCheckRollup",
    })
    local ci = nil
    if data.statusCheckRollup and #data.statusCheckRollup > 0 then
        -- Mirrors the rollup in M.list_pull_requests above; see the
        -- comment there for why SKIPPED/NEUTRAL conclusions don't break
        -- "all pass".
        local all_pass = true
        local any_fail = false
        for _, check in ipairs(data.statusCheckRollup) do
            if check.conclusion == "FAILURE" then any_fail = true end
            if check.conclusion ~= "SUCCESS"
                and check.conclusion ~= "SKIPPED"
                and check.conclusion ~= "NEUTRAL"
            then
                all_pass = false
            end
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
-- gh's `pr checks` reports check-run conclusions; values seen in the
-- wild include SUCCESS, FAILURE, PENDING, CANCELLED, ERROR, EXPECTED,
-- STALE, SKIPPED, NEUTRAL, ACTION_REQUIRED, TIMED_OUT.
--
-- Mapping onto Rust's CiCheckStatus enum:
--   SUCCESS                          → "success"
--   FAILURE / ERROR / TIMED_OUT      → "failure"
--   CANCELLED                        → "cancelled"
--   SKIPPED / NEUTRAL                → "skipped"  (didn't actually run / no-op result)
--   PENDING / EXPECTED / STALE / etc → "pending" (in-flight or queued)
--
-- NEUTRAL is grouped with SKIPPED because GitHub uses it for actions
-- that ran but produced no signal (e.g. a workflow that early-returns
-- on a path filter mismatch); to the reviewer that's "didn't run", not
-- "passed". Previously both SKIPPED and NEUTRAL fell through to
-- "pending", so merged PRs displayed phantom "Running" checks.
local function normalize_check_status(state)
    local s = string.upper(state or "")
    if s == "SUCCESS" then return "success" end
    if s == "FAILURE" or s == "ERROR" or s == "TIMED_OUT" then return "failure" end
    if s == "CANCELLED" or s == "CANCELED" then return "cancelled" end
    if s == "SKIPPED" or s == "NEUTRAL" then return "skipped" end
    return "pending"
end

function M.ci_status(args)
    local ok, data = pcall(gh, {
        "pr", "checks", args.branch,
        "--json", "name,state,link,startedAt",
    })
    if not ok then
        host.log("warn", "ci_status failed for branch " .. tostring(args.branch) .. ": " .. tostring(data))
        return {}
    end
    local checks = {}
    for _, item in ipairs(data) do
        table.insert(checks, {
            name = item.name,
            status = normalize_check_status(item.state),
            url = item.link,
            started_at = item.startedAt,
        })
    end
    return checks
end

local MAX_LOG_CHARS = 4000
-- Hard cap on how many failing runs we fetch logs for in one poll
-- tick. Each `gh run view --log-failed` is a sequential network call,
-- and the SCM polling semaphore caps workspace concurrency but not
-- per-workspace fan-out. 3 is enough for typical CI fan-out without
-- stretching a single poll into minutes.
local MAX_FAILED_RUNS = 3

local function fetch_run_log(run, logs)
    local result = host.exec("gh", {
        "run", "view", tostring(run.databaseId), "--log-failed",
    })
    if result.code ~= 0 then
        host.log("warn", "ci_failure_logs failed for GitHub run "
            .. tostring(run.databaseId) .. ": " .. tostring(result.stderr or ""))
        return
    end
    local log_text = result.stdout or ""
    if #log_text > MAX_LOG_CHARS then
        -- Take tail: CI errors are at the end of the log.
        log_text = string.sub(log_text, -MAX_LOG_CHARS)
    end
    if #log_text > 0 then
        table.insert(logs, {
            check_name = run.name,
            log = log_text,
            url = run.url,
        })
    end
end

function M.ci_failure_logs(args)
    local ok, runs = pcall(gh, {
        "run", "list",
        "--branch", args.branch,
        "--status", "failure",
        "--json", "databaseId,name,url",
        "--limit", "10",
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
    for _, run in ipairs(runs) do
        if #logs >= MAX_FAILED_RUNS then break end
        if (not has_wanted) or wanted[run.name] then
            fetch_run_log(run, logs)
        end
    end

    -- Fallback: `gh pr checks` returns job/check names while `gh run
    -- list` returns workflow names, so exact-name matching often
    -- misses (e.g. job "Lint" inside workflow "CI"). When we know
    -- there were failed checks but matched none, pull logs from the
    -- most recent failed runs as a best-effort signal.
    if has_wanted and #logs == 0 then
        for _, run in ipairs(runs) do
            if #logs >= MAX_FAILED_RUNS then break end
            fetch_run_log(run, logs)
        end
    end

    return logs
end

return M

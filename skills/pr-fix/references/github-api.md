# GitHub API Reference for pr-fix

Exact commands for fetching, replying to, and resolving PR review threads.

## Resolve PR Context

```bash
# From current branch
gh pr view --json number,headRefName,baseRefName,headRepository,url,state

# From a PR number or URL passed as argument
gh pr view <n> --json number,headRefName,baseRefName,headRepository,url,state
```

Extract `owner` and `repo` from `headRepository.owner.login` and `headRepository.name`, or parse from `url`.

## Fetch Comments (REST)

Three distinct surfaces. All three must be fetched.

```bash
# 1. PR-level discussion (top-level issue comments on the PR)
gh api "/repos/{owner}/{repo}/issues/{n}/comments" --paginate

# 2. Inline code review comments (threaded against specific lines)
gh api "/repos/{owner}/{repo}/pulls/{n}/comments" --paginate

# 3. Review bodies (summary text posted when a reviewer submits a review)
gh api "/repos/{owner}/{repo}/pulls/{n}/reviews" --paginate
```

Key fields per surface:

| Surface         | Fields to read                                                                                                    |
| --------------- | ----------------------------------------------------------------------------------------------------------------- |
| Issue comments  | `id`, `user.login`, `user.type`, `body`, `created_at`                                                             |
| Review comments | `id`, `user.login`, `body`, `path`, `line`, `diff_hunk`, `in_reply_to_id`, `pull_request_review_id`, `created_at` |
| Reviews         | `id`, `user.login`, `state`, `body`, `submitted_at`                                                               |

## Fetch Review Threads (GraphQL)

REST does not expose thread resolution state or the node IDs needed to resolve threads. Use GraphQL:

```bash
gh api graphql -F owner='{owner}' -F repo='{repo}' -F number={n} -f query='
  query($owner:String!, $repo:String!, $number:Int!) {
    repository(owner:$owner, name:$repo) {
      pullRequest(number:$number) {
        reviewThreads(first:100) {
          nodes {
            id
            isResolved
            isOutdated
            comments(first:20) {
              nodes {
                databaseId
                body
                path
                line
                author { login }
              }
            }
          }
        }
      }
    }
  }'
```

Join to REST review comments by `databaseId == REST id`. Keep only threads where `isResolved == false` and `isOutdated == false`.

## Post a Threaded Reply

Replies always go on the **root comment of an inline review thread** (the comment whose `in_reply_to_id` is null). This is the only write path this skill uses.

```bash
gh api -X POST \
  "/repos/{owner}/{repo}/pulls/{n}/comments/{root_comment_id}/replies" \
  -f body="$(cat <<'EOF'
<draft reply body>
EOF
)"
```

### Resolving the Root Comment ID

Each inline comment returned by `/pulls/{n}/comments` carries `id` and optionally `in_reply_to_id`. To find the root:

- If `in_reply_to_id == null`, the comment itself is the root.
- Otherwise, follow `in_reply_to_id` back through the list until you land on a comment with `in_reply_to_id == null`.

Equivalently, the GraphQL `reviewThreads.nodes.comments.nodes[0].databaseId` is the root REST ID for that thread.

### Forbidden Write Endpoints

The skill must not call any of these, not even as a fallback:

```
POST /repos/{owner}/{repo}/issues/{n}/comments        # top-level PR comment
POST /repos/{owner}/{repo}/pulls/{n}/reviews          # new review submission
POST /repos/{owner}/{repo}/pulls/{n}/comments         # new inline thread (not a reply)
```

Top-level PR comments, new review submissions, and starting fresh inline threads are all out of scope. If a draft reply has no root comment ID available, it is surfaced to the user in the terminal summary and left unposted.

## Resolve a Thread

```bash
gh api graphql -F threadId='<thread node id>' -f query='
  mutation($threadId:ID!) {
    resolveReviewThread(input:{threadId:$threadId}) {
      thread { id isResolved }
    }
  }'
```

The `threadId` is the GraphQL node ID from the `reviewThreads.nodes.id` field, not the REST comment ID.

## Rate Limits and Pagination

- Use `--paginate` on all REST list endpoints. PRs with many comments paginate at 30 per page.
- GraphQL `reviewThreads(first:100)` covers the vast majority of PRs. If a thread count approaches 100, add a `pageInfo { hasNextPage endCursor }` clause and page.

## Bot Filtering

Filter out bot comments early:

```bash
jq '[.[] | select(.user.type != "Bot")]'
```

Common noisy bots to skip even if `type` is `User`: `dependabot[bot]`, `codecov[bot]`, `vercel[bot]`, `coderabbitai[bot]`.

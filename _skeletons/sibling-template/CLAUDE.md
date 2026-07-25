# AI Assistant Context

The tool-agnostic rules of engagement for **all** automated agents (integration
branch, worktrees, commits, PRs, merging, honest pushes, security) live in
[`AGENTS.md`](AGENTS.md) and are imported below. They are binding for any change
in this repo; `AGENTS.md` is the single source of truth.

@AGENTS.md

## What this repo is

A **Biffo sibling app** (ADR-0007) — an independently-deployed microservice that
shares the core project's login and domain (`baseurl.com/<name>`) but has its own
repo, CI/CD, and AWS resources. It never touches the core database directly — it
only ever calls the core project's own API. Its own identity lives in
`biffo.sibling.json`.

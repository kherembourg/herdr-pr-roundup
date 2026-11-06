# Changelog

## v0.4.1 (2026-11-06)

### Fix

- **Close the side panel.** Each panel section (Files, Changes, Cost, PRs, Linear) has a `✕` at the right of its header. Before, the panel had no close button. Files and Changes now use the new mods `pr-roundup-files` and `pr-roundup-changes`, copies of Herdr's `files` and `changes` with that button.

## v0.4.0 (2026-11-05)

### New

- **One panel menu in the top bar.** The Files and Changes buttons are now one dropdown at the right of the tabs. The button shows the open section and its badge, for example `PRs 3 / 12 ▼`. A red dot shows when another section has a warning. The menu lists Files, Changes, Cost, PRs and Linear, each with its badge.
- **Cost.** Today's cost of your agents (Claude Code, Codex, pi) from `ccusage`: the trend against the 7-day average, the current 5 h block with its projection, a 14-day chart by agent, the models of today, the cost by project, and the most expensive sessions of today. A click on a session shows its agent when its pane is open.
- **PRs.** Your PRs and the reviews asked of you, grouped by repository. Filter by author, by repository (a pick loads all its open PRs) and by "needs action". A click on a PR opens the same details card as the sidebar, with the Agent, Source diff, IDE and GitHub buttons.
- **Linear.** The started issues of your teams (In Progress, In Review), with filters by assignee, project and initiative. The section shows only when a Linear tool is installed: the `linear` CLI, the Linear plugin or MCP server of Claude Code, or a Linear MCP server in Codex. It needs a Linear API key in `LINEAR_API_KEY` or in the macOS keychain item `herdr-linear`.

## v0.3.0 (2026-11-02)

### New

- **The Agent button does the PR work.** `Agent: <name>` now asks the agent to rebase the branch on the PR's base branch, resolve the conflicts and push (`--force-with-lease`), then monitor the CI and fix each failure, then fix or push back on each open review comment, and push. Before, it asked for a summary and waited for your instructions. (#3)

## v0.2.1 (2026-11-02)

### Fix

- **PRs sorted by number.** Under a space, PRs now show with the highest PR number first. Before, they were sorted by CI state and last update, so a row moved on each push or comment. (#2)

## v0.2.0 (2026-11-02)

### New

- **Open a PR from the agents list.** In the agents list, a click on the PR badge of an agent row (CI dot, `#number`, thread count) opens the PR on GitHub. The rest of the row still focuses the agent's pane. (#1)

## v0.1.0 (2026-11-02)

First version of PR Roundup: a Herdr layout with your open PRs under their spaces, CI state, review threads, a source-only diff pane, and one click to start an agent or an IDE in the PR's worktree. Built on Herdr 0.1.11.

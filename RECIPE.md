# PR Roundup implementation

[PR Roundup](README.md) is a Herdr layout for viewing GitHub pull requests and opening an agent, IDE, or source diff from a PR.

## Layout and mods

- `layouts/pr-roundup.json` arranges Herdr’s built-in Spaces and Agents on the left, the selected tab in the middle, and a panel stack on the right.
- `mods/pr-roundup-tabs/` replaces the separate Files and Changes buttons with a section menu. It shows the open section and badge, and remembers the panel selection per space.
- `mods/pr-roundup-menu/` lists Files, Changes, Cost, PRs, and Linear. It selects a section in the `panel-body` stack and shows the right panel. Keep its list of sections in sync with `pr-roundup-tabs`.
- `mods/pr-roundup-files/` and `mods/pr-roundup-changes/` add close buttons to Herdr’s built-in panels. `mods/pr-roundup-pane/` uses the PR title for source diff pane headers.
- `mods/pr-roundup-ops/` renders the Cost, PRs, and Linear sections and the source diff. `main.js` manages panel visibility, filters, and summaries. `github.js` handles GitHub requests. `prs.js` renders rows and actions. `filter.js` groups PRs and identifies which ones need action. `routing.js` finds the destination for agent tabs. `diff.js` handles source diffs, worktrees, and IDE launch.

## PRs panel

Opening PRs sets the repository filter from the active space. The resolver starts with the focused terminal, checks the active tab and other terminals in that space, then tries the saved folder. It runs `git remote get-url origin` on the space’s machine and recognizes GitHub.com remotes.

Summary requests batch the current account’s open PRs, requested reviews, and the selected repository’s open PRs through the GitHub CLI. The panel caches each list for five minutes, refreshes only when visible, and has a manual refresh button. Each repository group sorts by PR number descending. Check badges use the latest result per check name on the PR head.

Expansion fetches the full details for one PR, with open review threads and file changes. Tests and docs are excluded from the source list. When the GraphQL quota runs out, REST serves requests until the reported reset. A secondary rate limit pauses requests to both APIs. During fallback the list provides PR metadata, and expansion requests checks and changed files. Review thread status and comment text require GraphQL. A failed refresh can retain a previously loaded list.

The **Show** filter counts a PR as needing action for a review request, failed CI, requested changes, conflicts, or open threads. Drafts count only if they have a review request. Some statuses are unavailable during REST fallback.

## PR actions

**Agent** matches the PR repository against the active space, then checks other spaces for the same repository. It passes the matching space ID and worktree path explicitly to `tab.new`. It checks out the PR on that space’s machine, reusing a compatible worktree when available. Opening a PR from a fork uses the PR’s GitHub head ref and a dedicated local branch.

Worktree paths are under `<clone>/.worktrees/` if that folder is ignored, or `~/.herdr/worktrees/<repo>/` on the destination machine. The launcher checks the GitHub head and preserves existing local work. It reports a stale or incompatible branch so you can refresh the PR or inspect the branch.

**Source diff** opens a pane to the right and requests GitHub’s diff response through REST. The pane displays the list of files and the selected diff. Use the tests and docs toggle to include those files.

**IDE** opens the local worktree. Zed, VS Code, Cursor, and Windsurf can open side-by-side diffs, with an extracted merge-base copy on the left and the editable worktree file on the right.

## Other sections

**Cost** uses `mods/pr-roundup-ops/sources/cost.py` and `bunx ccusage@latest` to show agent usage. It refreshes every 60 seconds.

**Linear** uses `mods/pr-roundup-ops/sources/linear.sh` to show started issues. The menu enables it when a Linear tool is detected. It refreshes every five minutes. Set `LINEAR_API_KEY` or use the macOS keychain item `herdr-linear`. A `linear-team` file beside the script can limit it to one team.

## Verify in Herdr

1. Run `herdr-app check` for each folder in `mods/`.
2. Install the layout and mods, then switch to `pr-roundup`. Check for errors with `herdr-app status`.
3. Open the PRs panel in one GitHub space and switch to another. Check that the repository filter follows the active space. Select another repo manually and reopen the PRs panel to return to the active space’s repository.
4. Expand a PR and inspect its CI, review, and file details. Open its Source diff and select a file.
5. Confirm that the Agent action in a test space passes the matching space ID and worktree path. Run it on a disposable PR if you want to test the actual agent prompt and follow-up actions.

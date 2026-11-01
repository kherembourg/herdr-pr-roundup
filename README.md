# PR Roundup

A [Herdr](https://herdr.dev) layout: your open pull requests under the space of their repository, with CI state, AI review comments, a source-only diff pane, and one click to start an agent or an IDE in the PR's worktree.

![PR Roundup](preview.png)

## Install

Ask your agent in Herdr: "add the layout github.com/kherembourg/herdr-pr-roundup". Or copy `layouts/pr-roundup.json` to `~/.config/herdr-app/layouts/` and the three folders in `mods/` to `~/.config/herdr-app/mods/`, then switch to it with `Ctrl+Shift+L`.

Needs the GitHub CLI, logged in (`gh auth login`).

**What it runs:** the mods call GitHub through `gh`, run `git` in your clones (and on your other machines for their spaces), create git worktrees when you ask for an agent or an IDE, and start the agent or IDE you pick.

## Use

- Click a space: its repository's open PRs show under it. Click again to fold.
- `author:me ✕` shows every author's PRs; `Reset` goes back.
- Click a PR: CI, open review threads, changed source files, and the buttons:
  - **Agent** starts your default agent in a new tab, in the PR's worktree. `▾` picks another one; the pick becomes the default.
  - **Source diff** opens the diff without tests and docs, beside your pane.
  - **IDE** opens the worktree in your default IDE. `▾` picks another one.
  - **GitHub** opens the PR.
- PRs of repositories that no space is in are under **Other PRs**.
- In the agents list, an agent on a PR's branch shows the PR's number and CI dot.

How it is built, and how to rebuild it: [RECIPE.md](RECIPE.md).

## License

Apache-2.0, as Herdr. `mods/pr-roundup-spaces`, `mods/pr-roundup-agents` and `mods/pr-roundup-pane` are modified copies of Herdr's `spaces`, `agents` and `pane` mods (Herdr 0.1.11, [herdrdev/herdr-app](https://github.com/herdrdev/herdr-app)); the changes add the PR lists, the diff pane, the PR on agent rows and the diff pane titles.

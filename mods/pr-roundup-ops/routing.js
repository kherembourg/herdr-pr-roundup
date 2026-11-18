import { exec, panes, run, spaces } from "herdr";
import { prWorktree } from "./diff.js";

// A space's saved starting folder can predate the terminals it actually holds.
export async function resolveSpaceRepo(space) {
  if (!space) return null;
  const on = space.machine ?? null;
  const tabs = new Set(space.tabs.map((tab) => tab.id));
  const shown = space.tabs.find((tab) => tab.active)?.id;
  const terminals = panes().filter((pane) => tabs.has(pane.tab) && pane.cwd);
  const folders = new Set([
    terminals.find((pane) => pane.tab === shown && pane.focused)?.cwd,
    ...terminals.filter((pane) => pane.tab === shown).map((pane) => pane.cwd),
    ...terminals.map((pane) => pane.cwd),
    space.folder,
  ].filter(Boolean));

  for (const folder of folders) {
    const result = await exec("git", ["-C", folder, "remote", "get-url", "origin"], { on, timeout: 5000 }).catch(() => null);
    if (result?.code !== 0) continue;
    const remote = /^(?:(?:https?|ssh|git):\/\/(?:[^@/]+@)?github\.com(?::\d+)?\/|(?:[^@/:]+@)?github\.com:)([\w.-]+\/[\w.-]+)\/?$/i.exec(result.stdout.trim());
    if (remote) return { repo: remote[1].replace(/\.git$/i, ""), folder, on };
  }
  return null;
}

export async function launchPrAgent(pr, agent, selected = spaces().find((space) => space.active)) {
  if (!pr.headRefName || !pr.baseRefName) throw new Error("The pull request's branch information is unavailable.");
  if (pr.headRepo === null) throw new Error("The pull request's source repository is unavailable.");
  const repo = pr.repo.toLowerCase();
  const matches = (route) => route?.repo.toLowerCase() === repo;
  let target = selected;
  let route = await resolveSpaceRepo(target);

  if (!matches(route)) {
    const others = spaces().filter((space) => space.id !== selected?.id);
    // Keep work on the same machine if it already has that repo in another space.
    const machine = selected?.machine ?? null;
    const sameMachine = (space) => (space.machine ?? null) === machine;
    for (const group of [others.filter(sameMachine), others.filter((space) => !sameMachine(space))]) {
      const routes = await Promise.all(group.map(resolveSpaceRepo));
      const index = routes.findIndex(matches);
      if (index < 0) continue;
      target = group[index];
      route = routes[index];
      break;
    }
  }

  if (!matches(route)) throw new Error(`Open a Herdr space for ${pr.repo} to start an agent there.`);
  const fork = Boolean(pr.headRepo && pr.headRepo.toLowerCase() !== repo);
  const folder = await prWorktree({
    clone: route.folder, branch: pr.headRefName, ticket: pr.ticket, number: pr.number, on: route.on,
    fork, headSha: pr.headSha, requireCurrentHead: true,
  });
  if (!spaces().some((space) => space.id === target.id)) throw new Error("The destination space has been closed.");

  const lease = pr.headSha ? `--force-with-lease=refs/heads/${pr.headRefName}:${pr.headSha}` : "--force-with-lease";
  const task = [
    `Work on my pull request ${pr.url} (branch ${pr.headRefName}).`,
    "You are in its worktree.",
    `Rebase the branch on ${pr.baseRefName} and resolve conflicts. Preserve any local work already in this worktree.`,
    fork
      ? `Push updates to fork ${pr.headRepo}, branch ${pr.headRefName}. Never push this branch to the base repository.`
      : `Push updates to branch ${pr.headRefName}.`,
    `If the first push needs to rewrite history, use the exact lease ${lease}. For later pushes, use the last tip you pushed as the expected lease. If someone else updates the branch, stop and reconcile their commits before pushing.`,
    "Monitor the CI and fix each failure, then push.",
    "Read the open review comments: fix each one or push back with a reply, then push.",
  ].join(" ");
  run("tab.new", { name: `PR #${pr.number}`, space: target.id, folder, argv: agent.run, task });
}

// Open PRs for the spaces sidebar: GitHub data (CI from the newest run of each check,
// open review threads, changed source files) and the rows drawn under a space. Needs `gh` logged in.

import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, run, panes, spaces, notify, knownAgents, shared, setShared } from "herdr";
import { openDiff, prWorktree, findIdes, preferred, openIde, forge, choiceMenu, NOT_SOURCE } from "./diff.js";

export const REFRESH_MS = 120000;
const BOTS = {
  "copilot-pull-request-reviewer": "Copilot", Copilot: "Copilot", "greptile-apps": "Greptile",
  coderabbitai: "CodeRabbit", "chatgpt-codex-connector": "Codex", "gemini-code-assist": "Gemini",
};
const FAILED = new Set(["FAILURE", "TIMED_OUT", "STARTUP_FAILURE", "ACTION_REQUIRED", "ERROR"]);
export const RANK = { failed: 3, running: 2, ok: 1, none: 0 };

const query = (search) => `query { search(query: "${search} is:pr is:open archived:false", type: ISSUE, first: 100) { nodes { ... on PullRequest {
  number title url isDraft headRefName baseRefName updatedAt reviewDecision mergeable
  author { login }
  repository { name nameWithOwner }
  commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
    ... on CheckRun { name status conclusion startedAt } ... on StatusContext { context state createdAt } } } } } } }
  reviewThreads(first: 100) { nodes { isResolved isOutdated comments(first: 1) { nodes { author { login } body path } } } }
  files(first: 100) { nodes { path additions deletions } }
} } } }`;

// GitHub's own rollup keeps old cancelled runs, so a passing PR can read as failed:
// judge only the newest run of each check.
function ci(contexts) {
  const latest = new Map();
  for (const c of contexts) {
    const name = c.name ?? c.context;
    const at = c.startedAt ?? c.createdAt ?? "";
    if (!latest.has(name) || at >= latest.get(name).at) latest.set(name, { ...c, at });
  }
  const failed = [], running = [];
  let passed = 0;
  for (const [name, c] of latest) {
    if (c.context !== undefined) {
      if (FAILED.has(c.state)) failed.push(name);
      else if (c.state === "PENDING" || c.state === "EXPECTED") running.push(name);
      else passed++;
    } else if (c.status !== "COMPLETED") running.push(name);
    else if (FAILED.has(c.conclusion)) failed.push(name);
    else if (c.conclusion === "SUCCESS") passed++;
  }
  const state = failed.length ? "failed" : running.length ? "running" : passed ? "ok" : "none";
  return { state, failed, running };
}

const firstLine = (body) =>
  (body ?? "").replace(/<[^>]+>/g, " ").split("\n").map((l) => l.replace(/[#>*_`]/g, "").trim()).find((l) => l.length > 3) ?? "";

function shape(p) {
  const contexts = p.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? [];
  const threads = p.reviewThreads.nodes
    .filter((th) => !th.isResolved && !th.isOutdated)
    .map((th) => th.comments.nodes[0])
    .filter(Boolean)
    .map((c) => ({ who: BOTS[c.author?.login] ?? c.author?.login ?? "?", bot: c.author?.login in BOTS, path: c.path, text: firstLine(c.body) }));
  const files = p.files.nodes;
  return {
    ...p,
    repo: p.repository.nameWithOwner,
    // "acme/acme-ios" -> "ios": the owner's name adds nothing in a list of its repos.
    group: p.repository.name.replace(new RegExp(`^${p.repository.nameWithOwner.split("/")[0]}[-_]`, "i"), ""),
    title: p.title.replace(/^\w+(\([^)]*\))?!?:\s*/, "").replace(/\s*\([A-Z]+-\d+\)\s*$/, "").replace(/^./, (c) => c.toUpperCase()),
    ticket: p.title.match(/\(([A-Z]+-\d+)\)\s*$/)?.[1] ?? null,
    ci: ci(contexts),
    threads,
    source: files.filter((f) => !NOT_SOURCE.test(f.path)),
    hidden: files.filter((f) => NOT_SOURCE.test(f.path)).length,
  };
}

// Highest PR number first: a stable order that does not move on each push or comment.
const byNumber = (a, b) => b.number - a.number;

// `search`: "author:@me" or "repo:owner/name".
export async function fetchPrs(search) {
  const r = await exec("gh", ["api", "graphql", "-f", `query=${query(search)}`]);
  if (r.code !== 0) throw new Error(r.stderr.trim().split("\n")[0] || `gh exited with ${r.code}`);
  return JSON.parse(r.stdout).data.search.nodes.filter((p) => p.number).map(shape).sort(byNumber);
}

// A repo (its .git folder, on that machine: null here) -> "owner/name" on GitHub, or null.
export async function githubRepo(gitDir, on = null) {
  const r = await exec("git", ["-C", gitDir, "remote", "get-url", "origin"], { on }).catch(() => null);
  return r?.stdout.trim().match(/github\.com[:/](.+?\/.+?)(\.git)?$/)?.[1] ?? null;
}

// owner/repo -> the main checkout among the subfolders of `roots` (this machine), for the Agent and IDE buttons.
export async function findClones(roots) {
  const clones = {};
  const dirs = roots.map((r) => `"${r}"/*/`).join(" ");
  const r = await exec("sh", ["-c", `for d in ${dirs}; do [ -d "$d.git" ] && printf '%s %s\\n' "$d" "$(git -C "$d" remote get-url origin 2>/dev/null)"; done`]).catch(() => null);
  for (const line of (r?.stdout ?? "").split("\n")) {
    const [dir, url] = line.split(" ");
    const repo = url?.match(/github\.com[:/](.+?\/.+?)(\.git)?$/)?.[1];
    const path = dir?.replace(/\/$/, "");
    // Several clones of one repo: the shortest name is the main one (Android, not Android-mob-715).
    if (repo && (!clones[repo] || path.length < clones[repo].length)) clones[repo] = path;
  }
  return clones;
}

export const dot = (t, state, size = 8) =>
  div().w(size).h(size).flex_none().rounded_full().bg({ failed: t.ansi1, running: t.ansi3, ok: t.ansi2, none: t.dim }[state]);

export const pill = (text, fg, bg) => div().flex_none().px(5).rounded(8).text_size(10.5).text_color(fg).bg(bg).child(text);

export const worst = (prs) => prs.reduce((m, p) => (RANK[p.ci.state] > RANK[m] ? p.ci.state : m), "none");

// The PR rows and their open details; one per sidebar, so one PR is open at a time.
export class PrRows {
  constructor() {
    this.expanded = null;
    this.clones = {};
    this.spaceOf = () => null; // owner/name -> the id of the space that shows its PRs (set by the sidebar)
    this.starting = null; // the PR whose agent tab is being made
    this.agents = []; // installed agents (programs.json `run`), most picked first
    this.ides = []; // installed IDEs
    this.picking = null; // "<pr>:agent" or "<pr>:ide": whose chips show
    this.opening = null; // the PR whose IDE is opening
  }

  // shortcut: this machine's agents and IDEs, also for a space on another machine; ask knownAgents({ on }) if they differ.
  loadTools(cx) {
    cx.spawn(async (cx) => {
      try { this.agents = (await knownAgents()).filter((a) => a.installed); } catch {}
      this.ides = await findIdes();
      cx.notify();
    });
  }

  // The one-click agent: the last one picked, else Claude, else the first installed.
  defaultAgent() {
    return this.agents.find((a) => a.name === shared("prs.agent")) ?? this.agents.find((a) => a.run[0] === "claude") ?? this.agents[0]
      ?? { name: "Claude", run: ["claude"] };
  }

  ide(pr, ide, cx) {
    if (this.opening) return;
    this.opening = `${pr.repo}#${pr.number}`;
    cx.notify();
    cx.spawn(async (cx) => {
      try { await openIde({ clone: this.clones[pr.repo], branch: pr.headRefName, base: pr.baseRefName, ticket: pr.ticket, number: pr.number }, ide); }
      catch (e) { notify({ title: `PR #${pr.number}: ${ide.name} failed`, body: String(e.message ?? e), level: "error" }); }
      this.opening = null;
      cx.notify();
    });
  }

  // The pane whose terminal is on the PR's branch, with the name of its space.
  linked(pr) {
    const pane = panes().find((p) => p.terminal && p.branch === pr.headRefName);
    if (!pane) return null;
    const space = spaces().find((s) => s.tabs.some((tb) => tb.id === pane.tab));
    return { pane: pane.pane, space: space?.name ?? "" };
  }

  // A new tab with the agent `a` in the PR's worktree, in the space of its repo.
  agent(pr, a, cx) {
    if (this.starting) return;
    const key = `${pr.repo}#${pr.number}`;
    this.starting = key;
    cx.notify();
    cx.spawn(async (cx) => {
      const clone = this.clones[pr.repo];
      const space = this.spaceOf(pr.repo);
      try {
        // No local clone (a repo on another machine): the agent starts where the space is and checks the branch out itself.
        const folder = clone ? await prWorktree({ clone, branch: pr.headRefName, ticket: pr.ticket, number: pr.number }) : null;
        const task = [
          `Work on my pull request ${pr.url} (branch ${pr.headRefName}).`,
          folder ? "You are in its worktree." : "Check this branch out in a git worktree first.",
          "Read its CI state and open review comments, give me a short summary, then wait for my instructions. Ask me before you push.",
        ].join(" ");
        run("tab.new", { name: `PR #${pr.number}`, argv: a.run, task, ...(folder ? { folder } : {}), ...(space ? { space } : {}) });
      } catch (e) {
        notify({ title: `PR #${pr.number}: no agent`, body: String(e.message ?? e), level: "error" });
      }
      this.starting = null;
      cx.notify();
    });
  }

  details(t, pr) {
    const head = (text) => div().pt(6).pb(2).text_size(10).font_semibold().text_color(t.dim).child(text.toUpperCase());
    const line = (...kids) => h_flex().gap(6).items_center().min_w(0).children(kids);
    const { failed, running } = pr.ci;
    const button = (id, label, onClick, main = false) =>
      div().id(`${id}-${pr.repo}-${pr.number}`).px(8).py(2).rounded(6).border(1).cursor_pointer()
        .border_color(main ? t.solid : t.border).bg(main ? t.solid : t.surface).text_color(main ? t.solid_foreground : t.foreground)
        .hover((s) => s.opacity(0.85))
        .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
        .child(label);
    const key = `${pr.repo}#${pr.number}`;
    const agent = this.defaultAgent();
    const ide = this.clones[pr.repo] ? preferred(this.ides, "prs.ide") : null;
    const picking = this.picking?.startsWith(`${key}:`) ? this.picking.slice(key.length + 1) : null;
    const pickButton = (what) => button(`${what}-pick`, picking === what ? "▴" : "▾", (cx) => { this.picking = picking === what ? null : `${key}:${what}`; cx.notify(); });
    // A pick runs that one and makes it the one-click default.
    const chips = (what, list, current, go) => choiceMenu(t, `${what}-${key}`, list, current, (x, cx) => { setShared(`prs.${what}`, x.name); this.picking = null; go(x, cx); });
    const ciRows = failed.length
      ? failed.map((n) => line(dot(t, "failed", 7), div().truncate().child(n)))
      : running.length
        ? running.slice(0, 4).map((n) => line(dot(t, "running", 7), div().truncate().child(n)))
        : [div().text_color(t.muted).child(pr.ci.state === "ok" ? "All checks passed" : "No checks")];
    return v_flex()
      .ml(22).mr(4).mb(6).px(10).py(6).rounded(8).border(1).border_color(t.border).bg(t.background).text_size(12)
      .child(head(failed.length ? `CI · ${failed.length} failed` : running.length ? `CI · ${running.length} running` : "CI"))
      .children(ciRows)
      .child(head(`Review · ${pr.threads.length} open`))
      .when(pr.threads.length === 0, (el) => el.child(div().text_color(t.muted).child("No open comments")))
      .children(pr.threads.slice(0, 3).map((c) =>
        line(div().flex_none().text_size(11).text_color(c.bot ? t.ansi5 : t.foreground).child(c.who),
          div().flex_1().truncate().text_color(t.muted).child(c.text || c.path || ""))))
      .when(pr.threads.length > 3, (el) => el.child(div().text_color(t.dim).child(`+ ${pr.threads.length - 3} more`)))
      .child(head(`Source · ${pr.source.length} files${pr.hidden ? ` (${pr.hidden} tests/docs hidden)` : ""}`))
      .children(pr.source.slice(0, 6).map((f) =>
        line(div().flex_1().truncate().child(f.path.split("/").slice(-2).join("/")),
          div().flex_none().text_color(t.ansi2).child(`+${f.additions}`),
          div().flex_none().text_color(t.ansi1).child(`−${f.deletions}`))))
      .when(pr.source.length > 6, (el) => el.child(div().text_color(t.dim).child(`+ ${pr.source.length - 6} more`)))
      // One button per row; a ▾ opens its choices right under it.
      .child(v_flex().pt(8).gap(6).items_start().text_size(11.5)
        .child(h_flex().gap(6)
          .child(button("agent", this.starting === key ? "Starting…" : `Agent: ${agent.name}`, (cx) => this.agent(pr, agent, cx), true))
          .when(this.agents.length > 1, (el) => el.child(pickButton("agent"))))
        .when(picking === "agent", (el) => el.child(chips("agent", this.agents, agent, (a, cx) => this.agent(pr, a, cx))))
        .when(pr.source.length > 0, (el) => el.child(button("diff", "Source diff", () => openDiff(pr, this.clones[pr.repo]))))
        .when(Boolean(ide), (el) => el.child(h_flex().gap(6)
          .child(button("ide", this.opening === key ? "Opening…" : `IDE: ${ide.name}`, (cx) => this.ide(pr, ide, cx)))
          .when(this.ides.length > 1, (el) => el.child(pickButton("ide")))))
        .when(picking === "ide", (el) => el.child(chips("ide", this.ides, ide, (x, cx) => this.ide(pr, x, cx))))
        .child(button("open", forge(pr.url), () => exec("open", [pr.url]))));
  }

  // `author`: show who opened it (lists with every author).
  row(t, pr, author = false) {
    const open = this.expanded === `${pr.repo}#${pr.number}`;
    const link = this.linked(pr);
    const ai = pr.threads.length && pr.threads.every((c) => c.bot);
    return [
      h_flex()
        .id(`pr-${pr.repo}-${pr.number}`)
        .h(28).pl(14).pr(8).flex_none().gap(7).items_center().rounded(7).cursor_pointer()
        .when(open, (el) => el.bg(t.selected))
        .hover((s) => s.bg(t.hover))
        .tooltip(`${pr.title}${pr.ticket ? ` (${pr.ticket})` : ""}\n${pr.headRefName}${pr.author ? `\n@${pr.author.login}` : ""}`)
        .on_click((_e, cx) => { this.expanded = open ? null : `${pr.repo}#${pr.number}`; cx.notify(); })
        .child(dot(t, pr.ci.state))
        .child(div().flex_1().min_w(0).truncate().text_color(pr.isDraft ? t.muted : t.foreground).child(pr.title))
        .when(author && Boolean(pr.author), (el) => el.child(div().flex_none().max_w(70).truncate().text_size(11).text_color(t.dim).child(pr.author.login)))
        .when(pr.isDraft, (el) => el.child(pill("draft", t.muted, t.hover)))
        .when(pr.mergeable === "CONFLICTING", (el) => el.child(pill("conflict", t.ansi1, t.hover)))
        .when(pr.threads.length > 0, (el) => el.child(pill(`${pr.threads.length}${ai ? " AI" : ""}`, t.ansi5, t.hover)))
        .when(pr.reviewDecision === "APPROVED", (el) => el.child(pill("✓", t.ansi2, t.hover)))
        .when(Boolean(link), (el) => el.child(div().flex_none().max_w(70).truncate().text_size(11).text_color(t.dim).child(`→ ${link.space}`)))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(`#${pr.number}`)),
      ...(open ? [this.details(t, pr)] : []),
    ];
  }

  list(t, prs, author = false) {
    return prs.flatMap((p) => this.row(t, p, author));
  }
}

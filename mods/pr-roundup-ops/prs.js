// PR rows for the right panel. The list contains summaries until a row is expanded.

import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, panes, spaces, notify, knownAgents, shared, setShared } from "herdr";
import { openDiff, findIdes, preferred, openIde, forge, choiceMenu } from "./diff.js";
import { fetchPrDetails } from "./github.js";
import { launchPrAgent } from "./routing.js";

const keyOf = (pr) => `${pr.repo.toLowerCase()}#${pr.number}`;
const detailKey = (pr) => `${keyOf(pr)}@${pr.headSha ?? pr.updatedAt}`;

// owner/repo -> the main checkout among the subfolders of `roots` (this machine), for the Agent and IDE buttons.
export async function findClones(roots) {
  const clones = {};
  const script = 'for root do for d in "$root"/*/; do [ -d "$d.git" ] && printf "%s\\t%s\\n" "$d" "$(git -C "$d" remote get-url origin 2>/dev/null)"; done; done';
  const r = await exec("sh", ["-c", script, "sh", ...roots]).catch(() => null);
  for (const line of (r?.stdout ?? "").split("\n")) {
    const [dir, url] = line.split("\t");
    const repo = url?.match(/github\.com[:/](.+?\/.+?)(\.git)?$/)?.[1];
    const path = dir?.replace(/\/$/, "");
    // Several clones of one repo: the shortest name is the main one (Android, not Android-mob-715).
    if (!repo) continue;
    const key = repo.toLowerCase();
    if (!clones[key] || path.length < clones[key].length) clones[key] = path;
  }
  return clones;
}

export const dot = (t, state, size = 8) =>
  div().w(size).h(size).flex_none().rounded_full().bg({ failed: t.ansi1, running: t.ansi3, ok: t.ansi2, none: t.dim }[state]);

export const pill = (text, fg, bg) => div().flex_none().px(5).rounded(8).text_size(10.5).text_color(fg).bg(bg).child(text);

// Only one row is expanded at a time.
export class PrRows {
  constructor() {
    this.expanded = null;
    this.clones = {};
    this.starting = null; // the PR whose agent tab is being made
    this.agents = []; // installed agents (programs.json `run`), most picked first
    this.ides = []; // installed IDEs
    this.picking = null; // "<pr>:agent" or "<pr>:ide": whose chips show
    this.opening = null; // the PR whose IDE is opening
  }

  // Agents run on the target machine, while IDE shortcuts open locally.
  loadTools(cx, on = null) {
    const request = this.toolsRequest = {};
    cx.spawn(async (cx) => {
      const [agents, ides] = await Promise.all([
        knownAgents({ on }).catch(() => []),
        findIdes().catch(() => []),
      ]);
      if (request !== this.toolsRequest) return;
      this.agents = agents.filter((agent) => agent.installed);
      this.ides = ides;
      cx.notify();
    });
  }

  // The one-click agent: the last one picked, else Claude, else the first installed.
  defaultAgent() {
    return this.agents.find((a) => a.name === shared("prs.agent")) ?? this.agents.find((a) => a.run[0] === "claude") ?? this.agents[0]
      ?? { name: "Claude", run: ["claude"] };
  }

  cloneFor(pr) {
    const repo = pr.repo.toLowerCase();
    if (!this.location?.on && this.location?.repo.toLowerCase() === repo) return this.location.folder;
    return this.clones[repo];
  }

  ide(pr, ide, cx) {
    if (this.opening) return;
    this.opening = `${pr.repo}#${pr.number}`;
    cx.notify();
    cx.spawn(async (cx) => {
      try { await openIde({ clone: this.cloneFor(pr), branch: pr.headRefName, base: pr.baseRefName, ticket: pr.ticket, number: pr.number, repo: pr.repo, headRepo: pr.headRepo, headSha: pr.headSha }, ide); }
      catch (e) { notify({ title: `PR #${pr.number}: ${ide.name} failed`, body: String(e.message ?? e), level: "error" }); }
      this.opening = null;
      cx.notify();
    });
  }

  linked(pr) {
    if (!pr.headRefName || this.location?.repo.toLowerCase() !== pr.repo.toLowerCase()) return null;
    const space = spaces().find((space) => space.id === this.spaceId);
    const tabs = new Set(space?.tabs.map((tab) => tab.id) ?? []);
    return panes().some((pane) => tabs.has(pane.tab) && pane.terminal && pane.branch === pr.headRefName) ? space : null;
  }

  select(pr, cx) {
    const key = keyOf(pr);
    if (this.expanded === key) {
      this.expanded = null;
      cx.notify();
      return;
    }
    this.expanded = key;
    const state = this.detail = { key: detailKey(pr), loading: true };
    cx.notify();
    cx.spawn(async (cx) => {
      try { state.pr = await fetchPrDetails(pr); }
      catch (e) { state.error = String(e.message ?? e); }
      state.loading = false;
      cx.notify();
    });
  }

  agent(pr, agent, cx) {
    if (this.starting) return;
    const selected = spaces().find((space) => space.active);
    this.starting = keyOf(pr);
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const loaded = pr.headRefName && pr.baseRefName ? pr : await fetchPrDetails(pr);
        await launchPrAgent(loaded, agent, selected);
      } catch (e) {
        notify({ title: `PR #${pr.number}: no agent`, body: String(e.message ?? e), level: "error" });
      } finally {
        this.starting = null;
        cx.notify();
      }
    });
  }

  details(t, summary, state) {
    const pr = state?.pr ?? summary;
    const threadDetails = pr.detailsLoaded && pr.threadsKnown !== false;
    const filesKnown = pr.detailsLoaded && pr.filesKnown !== false;
    const head = (text) => div().pt(6).pb(2).text_size(10).font_semibold().text_color(t.dim).child(text.toUpperCase());
    const line = (...kids) => h_flex().gap(6).items_center().min_w(0).children(kids);
    const { failed, running } = pr.ci;
    const button = (id, label, onClick, main = false) =>
      div().id(`${id}-${pr.repo}-${pr.number}`).px(8).py(2).rounded(6).border(1).cursor_pointer()
        .border_color(main ? t.solid : t.border).bg(main ? t.solid : t.surface).text_color(main ? t.solid_foreground : t.foreground)
        .hover((s) => s.opacity(0.85))
        .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
        .child(label);
    const key = keyOf(pr);
    const agent = this.defaultAgent();
    const ide = pr.headRefName && pr.baseRefName && this.cloneFor(pr) ? preferred(this.ides, "prs.ide") : null;
    const picking = this.picking?.startsWith(`${key}:`) ? this.picking.slice(key.length + 1) : null;
    const pickButton = (what) => button(`${what}-pick`, picking === what ? "▴" : "▾", (cx) => { this.picking = picking === what ? null : `${key}:${what}`; cx.notify(); });
    // A pick runs that one and makes it the one-click default.
    const chips = (what, list, current, go) => choiceMenu(t, `${what}-${key}`, list, current, (x, cx) => { setShared(`prs.${what}`, x.name); this.picking = null; go(x, cx); });
    const ciRows = failed.length
      ? failed.map((n) => line(dot(t, "failed", 7), div().truncate().child(n)))
      : running.length
        ? running.slice(0, 4).map((n) => line(dot(t, "running", 7), div().truncate().child(n)))
        : [div().text_color(t.muted).child(pr.ciKnown === false ? "Check status unavailable" : pr.ci.state === "ok" ? "All checks passed" : "No checks")];
    return v_flex()
      .ml(22).mr(4).mb(6).px(10).py(6).rounded(8).border(1).border_color(t.border).bg(t.background).text_size(12)
      .child(head(failed.length ? `CI · ${failed.length} failed` : running.length ? `CI · ${running.length} running` : "CI"))
      .children(ciRows)
      .when(Boolean(state?.loading), (el) => el.child(div().text_color(t.dim).child("Loading comments and files…")))
      .when(Boolean(state?.error || pr.detailsError), (el) => el.child(div().text_color(t.muted).child(state?.error ?? pr.detailsError)))
      .when(threadDetails, (el) => el
        .child(head(`Review · ${pr.threads.length} open`))
        .when(pr.threads.length === 0, (el) => el.child(div().text_color(t.muted).child("No open comments")))
        .children(pr.threads.slice(0, 3).map((c) =>
          line(div().flex_none().text_size(11).text_color(c.bot ? t.ansi5 : t.foreground).child(c.who),
            div().flex_1().truncate().text_color(t.muted).child(c.text || c.path || ""))))
        .when(pr.threads.length > 3, (el) => el.child(div().text_color(t.dim).child(`+ ${pr.threads.length - 3} more`))))
      .when(filesKnown, (el) => el
        .child(head(`Source · ${pr.source.length} files${pr.hidden ? ` (${pr.hidden} tests/docs hidden)` : ""}`))
        .children(pr.source.slice(0, 6).map((f) =>
          line(div().flex_1().truncate().child(f.path.split("/").slice(-2).join("/")),
            div().flex_none().text_color(t.ansi2).child(`+${f.additions}`),
            div().flex_none().text_color(t.ansi1).child(`−${f.deletions}`))))
        .when(pr.source.length > 6, (el) => el.child(div().text_color(t.dim).child(`+ ${pr.source.length - 6} more`))))
      // One button per row; a ▾ opens its choices right under it.
      .child(v_flex().pt(8).gap(6).items_start().text_size(11.5)
        .child(h_flex().gap(6)
          .child(button("agent", this.starting === key ? "Starting…" : `Agent: ${agent.name}`, (cx) => this.agent(pr, agent, cx), true))
          .when(this.agents.length > 1, (el) => el.child(pickButton("agent"))))
        .when(picking === "agent", (el) => el.child(chips("agent", this.agents, agent, (a, cx) => this.agent(pr, a, cx))))
        .when(filesKnown && pr.source.length > 0, (el) => el.child(button("diff", "Source diff", () => openDiff(pr, this.cloneFor(pr)))))
        .when(Boolean(ide), (el) => el.child(h_flex().gap(6)
          .child(button("ide", this.opening === key ? "Opening…" : `IDE: ${ide.name}`, (cx) => this.ide(pr, ide, cx)))
          .when(this.ides.length > 1, (el) => el.child(pickButton("ide")))))
        .when(picking === "ide", (el) => el.child(chips("ide", this.ides, ide, (x, cx) => this.ide(pr, x, cx))))
        .child(button("open", forge(pr.url), () => exec("open", [pr.url]))));
  }

  // `author`: show who opened it (lists with every author).
  row(t, pr, author = false) {
    const open = this.expanded === keyOf(pr);
    const state = this.detail?.key === detailKey(pr) ? this.detail : null;
    const loaded = state?.pr ?? pr;
    const link = this.linked(loaded);
    const ai = loaded.detailsLoaded && loaded.threads.length && loaded.threads.every((c) => c.bot);
    return [
      h_flex()
        .id(`pr-${pr.repo}-${pr.number}`)
        .h(28).pl(14).pr(8).flex_none().gap(7).items_center().rounded(7).cursor_pointer()
        .when(open, (el) => el.bg(t.selected))
        .hover((s) => s.bg(t.hover))
        .tooltip(`${pr.title}${pr.ticket ? ` (${pr.ticket})` : ""}\n${pr.headRefName ?? ""}${pr.author ? `\n@${pr.author.login}` : ""}`)
        .on_click((_e, cx) => this.select(pr, cx))
        .child(dot(t, loaded.ci.state))
        .child(div().flex_1().min_w(0).truncate().text_color(pr.isDraft ? t.muted : t.foreground).child(pr.title))
        .when(author && Boolean(pr.author), (el) => el.child(div().flex_none().max_w(70).truncate().text_size(11).text_color(t.dim).child(pr.author.login)))
        .when(pr.isDraft, (el) => el.child(pill("draft", t.muted, t.hover)))
        .when(loaded.mergeable === "CONFLICTING", (el) => el.child(pill("conflict", t.ansi1, t.hover)))
        .when(loaded.threads.length > 0, (el) => el.child(pill(`${loaded.threads.length}${ai ? " AI" : ""}`, t.ansi5, t.hover)))
        .when(loaded.reviewDecision === "APPROVED", (el) => el.child(pill("✓", t.ansi2, t.hover)))
        .when(Boolean(link), (el) => el.child(div().flex_none().max_w(70).truncate().text_size(11).text_color(t.dim).child(`→ ${link.name}`)))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(`#${pr.number}`)),
      ...(open ? [this.details(t, pr, state)] : []),
    ];
  }

}

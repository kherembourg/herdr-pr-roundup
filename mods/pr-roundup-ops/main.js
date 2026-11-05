import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, theme, shared, setShared, appHome, props, home, spaces, agents, run } from "herdr";
import { reasons, mergePrs } from "./filter.js";
// The left sidebar's PR rows: same details and Agent / Source diff / IDE / GitHub buttons.
import { PrRows, fetchPrs, findClones } from "./prs.js";

let login = null; // my GitHub login, asked once
async function myLogin() {
  if (!login) login = (await exec("gh", ["api", "user", "-q", ".login"])).stdout.trim() || null;
  return login;
}

// Where to look for clones: each local space's folder and its parent (a space in ~/code/app also finds ~/code/api).
function cloneRoots() {
  const dirs = spaces().filter((sp) => sp.folder && !sp.machine).map((sp) => sp.folder.replace(/\/$/, ""));
  return [...new Set(dirs.flatMap((d) => [d, d.slice(0, d.lastIndexOf("/"))]).filter((d) => d && d !== home()))];
}

const money = (n) => `$${(n ?? 0).toFixed(n >= 100 ? 0 : 2)}`;
const short = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const open = (url) => exec("open", [url]).catch(() => {});

// Each parse returns { summary, rows }. A row: { badges: [[text, colorName]], label, sub?, url? }.
const SECTIONS = [
  { id: "cost", title: "Cost", every: 60000, script: "cost.py", run: "python3", filtered: "cost",
    parse: (d) => ({ raw: d, summary: `$${Math.round(d.today)}`, rows: [] }) },
  { id: "prs", title: "PRs", every: 120000, filtered: "prs", load: async (view) => {
    // Mine and the reviews asked of me; with a repo picked, all of its open PRs too.
    // shortcut: no org-wide search (100 PRs with files and checks gets HTTP 502 from GitHub); "all authors" needs a repo.
    const repo = view.prFilter().repo;
    // Spaces open after start bring their clones (for the Agent and IDE buttons).
    findClones(cloneRoots()).then((c) => { view.prRows.clones = { ...c, ...view.prRows.clones }; }).catch(() => {});
    const [me, mine, review, inRepo] = await Promise.all([myLogin(), fetchPrs("author:@me"), fetchPrs("review-requested:@me"),
      repo ? fetchPrs(`repo:${repo}`) : []]);
    return { raw: { me, repo, prs: mergePrs([mine, inRepo], review) }, rows: [] };
  } },
  { id: "linear", title: "Linear", every: 300000, script: "linear.sh", parse: (d) => ({ raw: d, rows: [] }),
    // Rows depend on the filters, so they are built at render time (see linearRows).
    filtered: true },
];

export default class Ops extends View {
  // props.section: show only that section (one panel tab each); without it, all of them stacked.
  sections() { const id = props()?.section; return id ? SECTIONS.filter((s) => s.id === id) : SECTIONS; }

  init(_props, cx) {
    this.data = {};
    this.local = {};
    if (this.sections().some((s) => s.id === "prs")) {
      this.prRows = new PrRows();
      this.prRows.loadTools(cx);
      // The space whose folder is the repo's clone gets the agent's tab.
      this.prRows.spaceOf = (gh) => spaces().find((sp) => sp.folder && sp.folder === this.prRows.clones[gh])?.id ?? null;
      cx.spawn(async (cx) => { this.prRows.clones = await findClones(cloneRoots()); cx.notify(); });
    }
    for (const s of this.sections()) {
      this.refresh(s, cx);
      cx.timer.every(s.every, (cx) => this.refresh(s, cx));
    }
  }

  refresh(s, cx) {
    if (this.data[s.id]?.loading) return;
    this.data[s.id] = { ...this.data[s.id], loading: true };
    cx.spawn(async (cx) => {
      const next = {};
      try {
        const r = s.load ? { code: 0, data: await s.load(this) } : await exec(s.run ?? "sh", [...(s.run === "python3" ? ["-I"] : []), `${appHome()}/mods/pr-roundup-ops/sources/${s.script}`]);
        if (r.data) Object.assign(next, r.data);
        else if (r.code !== 0) {
          next.error = (r.stderr.trim().split("\n")[0] || `exit ${r.code}`);
          next.setup = r.code === 2;
        } else Object.assign(next, s.parse(JSON.parse(r.stdout)));
      } catch (e) { next.error = String(e).split("\n")[0]; }
      // A failed refresh keeps the last good rows.
      this.data[s.id] = { ...this.data[s.id], ...(next.error ? {} : { error: null, setup: false }), ...next, loading: false };
      const d = this.data[s.id];
      // The top bar's button shows this (mods/pr-roundup-tabs).
      setShared(`ops.badge.${s.id}`, d.error && !d.summary ? { text: "!", warn: true } : { text: d.summary ?? "", warn: Boolean(d.warn) });
      cx.notify();
    });
  }

  // The Cost tab: today, the 5 h block, 14 days, models, and where the cost comes from.
  costView(d, t) {
    const c = d.raw; if (!c) return null;
    const AGENT = { claude: t.accent, codex: t.ansi5, pi: t.ansi6 };
    const MODEL = (n) => /opus/.test(n) ? t.ansi4 : /fable/.test(n) ? t.ansi5 : /sonnet/.test(n) ? t.ansi6 : /haiku/.test(n) ? t.ansi2 : t.ansi3;
    const usd = (n) => `$${n >= 100 ? Math.round(n) : n.toFixed(n >= 10 ? 1 : 2)}`;
    const label = (text) => div().px(14).pt(14).pb(6).text_size(10).font_semibold().text_color(t.dim).child(text.toUpperCase());
    const card = () => v_flex().mx(10).px(12).py(10).gap(6).rounded(8).border_1().border_color(t.border).bg(t.surface).flex_none();
    // A bar split by parts [[value, color]]; the full width stands for `of`.
    const bar = (parts, of, h = 6) => {
      const used = parts.reduce((a, [v]) => a + Math.max(0, v), 0);
      return h_flex().w_full().h(h).rounded(h / 2).overflow_hidden().bg(t.hover).flex_none()
        .children(parts.filter(([v]) => v > 0).map(([v, col]) => div().h_full().bg(col).flex_basis(0).flex_grow(v)))
        .when(used < of, (e) => e.child(div().h_full().flex_basis(0).flex_grow(of - used)));
    };
    const legend = (items) => h_flex().gap(10).flex_wrap().children(items.map(([text, col]) =>
      h_flex().gap(4).items_center().child(div().w(7).h(7).rounded(4).bg(col)).child(div().text_size(10.5).text_color(t.muted).child(text))));
    const out = [];

    // Hero: today, its trend, and the split by agent
    const delta = c.avg7 ? Math.round(100 * (c.today - c.avg7) / c.avg7) : 0;
    out.push(h_flex().px(14).pt(12).pb(4).items_end().justify_between().flex_none()
      .child(v_flex().gap(2)
        .child(div().text_size(30).font_semibold().child(usd(c.today)))
        .child(div().text_size(11).text_color(t.muted).child("today")))
      .child(v_flex().gap(3).items_end().text_size(11)
        .child(div().text_color(delta > 15 ? t.blocked : delta < -15 ? t.done : t.muted).child(`${delta >= 0 ? "▲" : "▼"} ${Math.abs(delta)}% vs 7-day avg ${usd(c.avg7)}`))
        .child(div().text_color(t.dim).child(`yesterday ${usd(c.yesterday)} · month ${usd(c.month)}`))));
    const ag = Object.entries(c.today_agents ?? {}).sort((a, b) => b[1] - a[1]);
    out.push(v_flex().px(14).pt(6).gap(6).flex_none()
      .child(bar(ag.map(([a, v]) => [v, AGENT[a] ?? t.ansi3]), c.today || 1, 8))
      .child(legend(ag.map(([a, v]) => [`${a[0].toUpperCase()}${a.slice(1)} ${usd(v)}`, AGENT[a] ?? t.ansi3]))));

    // 5 h block: time used as a bar, cost and projection
    out.push(label("5 h block"));
    if (c.block) {
      const b = c.block, start = Date.parse(b.start), end = Date.parse(b.end);
      const done = Math.min(1, Math.max(0, (Date.now() - start) / (end - start)));
      const hm = (ms) => new Date(ms).toTimeString().slice(0, 5);
      out.push(card()
        .child(h_flex().justify_between().items_end()
          .child(div().text_size(18).font_semibold().child(usd(b.cost)))
          .child(div().text_size(11).text_color(t.muted).child(`${usd(b.burn)}/h → ${usd(b.projected)}`)))
        .child(bar([[done, t.accent]], 1, 6))
        .child(h_flex().justify_between().text_size(10.5).text_color(t.dim)
          .child(div().child(hm(start)))
          .child(div().child(`${Math.floor(b.minutes_left / 60)}h${String(b.minutes_left % 60).padStart(2, "0")} left`))
          .child(div().child(hm(end)))));
    } else out.push(div().px(14).text_size(11).text_color(t.dim).child("No active block"));

    // 14 days, each bar stacked by agent; hover shows the numbers
    const max = Math.max(1, ...c.days.map((x) => x.cost));
    const H = 84, dayName = (iso) => "SMTWTFS"[new Date(iso + "T12:00:00").getDay()];
    out.push(label("14 days"));
    out.push(card()
      .child(h_flex().justify_between().text_size(10.5).text_color(t.dim)
        .child(div().child(`max ${usd(max)}`))
        .child(div().child(`avg ${usd(c.days.reduce((a, x) => a + x.cost, 0) / c.days.length)}/day`)))
      .child(h_flex().w_full().h(H).items_end().gap(3).children(c.days.map((x, i) => {
        const parts = Object.entries(x.agents).filter(([, v]) => v > 0).sort((a, b) => (a[0] === "claude" ? 1 : 0) - (b[0] === "claude" ? 1 : 0));
        return v_flex().id(`day-${x.date}`).flex_1().h(Math.max(2, H * x.cost / max)).rounded(3).overflow_hidden().justify_end()
          .opacity(i === c.days.length - 1 ? 1 : 0.75).when(!parts.length, (e) => e.bg(t.hover))
          .tooltip(`${x.date}  ${usd(x.cost)}${parts.length ? "\n" + parts.map(([a, v]) => `${a} ${usd(v)}`).join(" · ") : ""}`)
          .children(parts.map(([a, v]) => div().w_full().flex_basis(0).flex_grow(v).bg(AGENT[a] ?? t.ansi3)));
      })))
      .child(h_flex().w_full().gap(3).children(c.days.map((x, i) =>
        div().flex_1().text_size(9).text_color(i === c.days.length - 1 ? t.foreground : t.dim).child(dayName(x.date)))))
      .child(legend(Object.keys(AGENT).filter((a) => c.days.some((x) => x.agents[a])).map((a) => [a, AGENT[a]]))));

    // Models today
    if (c.models.length) {
      out.push(label("Models today"));
      const top = c.models[0].cost;
      out.push(card().children(c.models.map((m) => v_flex().gap(3)
        .child(h_flex().justify_between().text_size(11.5)
          .child(div().child(m.name.replace(/^claude-/, "")))
          .child(div().text_color(t.muted).child(`${usd(m.cost)} · ${Math.round(100 * m.cost / (c.today || 1))}%`)))
        .child(bar([[m.cost, MODEL(m.name)]], top, 5)))));
    }

    // Where it comes from: projects (Claude today + Codex sessions active today)
    if (c.projects.length) {
      out.push(label("By project"));
      const top = c.projects[0].cost;
      out.push(card().children(c.projects.map((p) => v_flex().gap(3)
        .child(h_flex().gap(8).text_size(11.5)
          .child(div().flex_1().min_w(0).truncate().child(p.name))
          .child(div().flex_none().text_color(t.muted).child(usd(p.cost))))
        .child(bar([[p.claude, AGENT.claude], [p.codex, AGENT.codex]], top, 5)))));
    }

    // Top sessions; a click shows the agent when a live pane has the same title.
    if (c.sessions.length) {
      out.push(label("Top sessions"));
      const live = agents();
      out.push(card().gap(2).children(c.sessions.map((x, i) => {
        const a = live.find((g) => g.title === x.title || g.tab_name === x.title);
        return h_flex().id(`sess-${i}`).gap(8).py(3).px(4).items_center().rounded(4)
          .when(Boolean(a), (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => run("agent.focus", { terminal: a.address })))
          .child(div().w(7).h(7).flex_none().rounded(4).bg(AGENT[x.agent] ?? t.ansi3))
          .child(v_flex().flex_1().min_w(0)
            .child(div().truncate().text_size(11.5).text_color(a ? t.foreground : t.muted).child(x.title))
            .child(div().truncate().text_size(10).text_color(t.dim).child(x.project)))
          .child(div().flex_none().text_size(11.5).child(usd(x.cost)));
      })));
    }
    out.push(div().px(14).pt(8).pb(12).text_size(10).text_color(t.dim)
      .child("Projects: Claude cost of today, plus Codex sessions active today (their full cost). Prices: ccusage."));
    return out;
  }

  // A row of filter chips; a click opens that filter's values (with counts) under it.
  // defs: [[key, label, shownValue]]; values(key) -> [[value, text, count?]].
  filterBar(t, sec, defs, f, setF, values) {
    const chip = (id, text, on, click) => div().id(id).flex_none().px(6).py(1).rounded(4).border_1().cursor_pointer()
      .border_color(on ? t.accent : t.border).text_size(11).text_color(on ? t.accent : t.muted).hover((e) => e.bg(t.hover))
      .on_click(click).child(text);
    this.open ??= {};
    const bar = h_flex().w_full().px(12).py(6).gap(4).flex_wrap().flex_none();
    for (const [k, label, shown] of defs)
      bar.child(chip(`${sec}-f-${k}`, `${label}: ${shown} ▾`, this.open[sec] === k || Boolean(f[k]),
        (_e, cx) => { this.open[sec] = this.open[sec] === k ? null : k; cx.notify(); }));
    const out = [bar];
    const k = this.open[sec];
    if (k) {
      const pick = h_flex().w_full().px(12).pb(6).gap(4).flex_wrap().flex_none();
      values(k).forEach(([v, text, c], n) => pick.child(chip(`${sec}-o-${k}-${n}`, c == null ? text : `${short(text, 28)} ${c}`,
        (f[k] ?? null) === v, (_e, cx) => { setF({ ...f, [k]: v }, cx); this.open[sec] = null; cx.notify(); })));
      out.push(pick);
    }
    return out;
  }

  prFilter() { return shared("ops.prs.filter") ?? this.pfLocal ?? { author: "me" }; }
  setPrFilter(f, cx) {
    const reload = f.repo !== this.prFilter().repo;
    this.pfLocal = f; setShared("ops.prs.filter", f);
    if (reload) this.refresh(SECTIONS.find((s) => s.id === "prs"), cx);
  }

  prsView(d, t) {
    const raw = d.raw; if (!raw || !this.prRows) return null;
    const f = this.prFilter();
    // The repo's name, without the owner and without an owner prefix ("acme/acme-ios" -> "ios").
    const short2 = (repo) => { const [o, n] = repo.split("/"); return n.replace(new RegExp(`^${o.replace(/[^\w]/g, "")}[-_]`, "i"), "") || n; };
    const authorOk = (p) => !f.author || (f.author === "me" ? p.author?.login === raw.me : f.author === "review" ? p.reviewRequested : p.author?.login === f.author);
    const keep = (p, skip) => (skip === "author" || authorOk(p)) && (skip === "repo" || !f.repo || p.repo === f.repo)
      && (skip === "show" || f.show !== "action" || reasons(p).length > 0);
    if (f.repo && raw.repo !== f.repo) return [...this.filterBar(t, "prs", [["repo", "Repo", short2(f.repo)]], f, (x, cx) => this.setPrFilter(x, cx), () => []), this.row({ label: "Loading…" }, 0, "prs", t)];
    const prs = raw.prs.filter((p) => keep(p));
    const need = prs.filter((p) => reasons(p).length).length;
    d.summary = f.show === "action" ? String(prs.length) : `${need} / ${prs.length}`;
    d.warn = need > 0;
    const badge = { text: d.summary, warn: d.warn };
    if (JSON.stringify(shared("ops.badge.prs")) !== JSON.stringify(badge)) setShared("ops.badge.prs", badge);
    const count = (k, test) => raw.prs.filter((p) => keep(p, k) && test(p)).length;
    const values = (k) => {
      const pool = raw.prs.filter((p) => keep(p, k));
      if (k === "author") return [[null, "All"], ["me", "me", count(k, (p) => p.author?.login === raw.me)], ["review", "review requested", count(k, (p) => p.reviewRequested)],
        ...[...new Set(pool.map((p) => p.author?.login).filter((a) => a && a !== raw.me))].sort().map((a) => [a, a, count(k, (p) => p.author?.login === a)])];
      if (k === "repo") {
        const repos = [...new Set([...Object.keys(this.prRows.clones), ...pool.map((p) => p.repo)])].sort((a, b) => short2(a).localeCompare(short2(b)));
        // A repo not loaded yet has no count: picking it loads its PRs.
        return [[null, "All"], ...repos.map((r) => [r, short2(r), r === raw.repo || pool.some((p) => p.repo === r) ? count(k, (p) => p.repo === r) : null])];
      }
      return [[null, "All"], ["action", "needs action", count(k, (p) => reasons(p).length > 0)]];
    };
    const defs = [["author", "Author", f.author === "review" ? "review requested" : f.author ?? "all"],
      ["repo", "Repo", f.repo ? short2(f.repo) : "all"], ["show", "Show", f.show === "action" ? "needs action" : "all"]];
    const out = this.filterBar(t, "prs", defs, f, (x, cx) => this.setPrFilter(x, cx), values);
    if (!prs.length) return [...out, this.row({ label: "No PR for these filters" }, 0, "prs", t)];
    // Grouped by repo; over each row, only the reasons its own pills don't show (conflict and threads they do).
    const sorted = [...prs].sort((a, b) => short2(a.repo).localeCompare(short2(b.repo)) || b.number - a.number);
    return [...out, ...sorted.flatMap((p, n) => {
      const r = reasons(p).filter((x) => x === "CI" || x === "changes" || x === "review");
      const head = n === 0 || sorted[n - 1].repo !== p.repo
        ? [div().px(12).pt(8).pb(2).text_size(10).font_semibold().text_color(t.dim).child(short2(p.repo).toUpperCase())] : [];
      const tags = r.length ? [h_flex().w_full().pl(29).pt(2).gap(4).flex_none().children(r.map((x) => div().flex_none().px(5).rounded(4).border_1().text_size(10)
        .border_color(x === "review" ? t.accent : t.ansi1).text_color(x === "review" ? t.accent : t.ansi1).child(x)))] : [];
      return [...head, ...tags, ...this.prRows.row(t, p, f.author !== "me")];
    })];
  }

  // Linear filters: { assignee, project, initiative } (null = all), and which picker is open.
  lf() { return shared("ops.linear.filter") ?? this.lfLocal ?? { assignee: "me" }; }
  setLf(f) { this.lfLocal = f; setShared("ops.linear.filter", f); }

  linearRows(d, t) {
    const raw = d.raw; if (!raw) return null;
    const f = this.lf(), want = (k, v) => !f[k] || (f[k] === "me" ? v === raw.me : v === f[k]);
    const keep = (i, skip) => (skip === "assignee" || want("assignee", i.assignee)) && (skip === "project" || want("project", i.project))
      && (skip === "initiative" || !f.initiative || i.initiatives.includes(f.initiative));
    const issues = raw.issues.filter((i) => keep(i));
    d.summary = String(issues.length);
    // The top bar's count follows the filters; write only on change (a write re-renders).
    if (shared("ops.badge.linear")?.text !== d.summary) setShared("ops.badge.linear", { text: d.summary, warn: false });
    const counts = (k) => {
      const m = new Map();
      // Counts follow the other two filters, so a value never leads to an empty list.
      for (const i of raw.issues.filter((i) => keep(i, k))) for (const v of k === "initiative" ? i.initiatives : [i[k]]) m.set(v, (m.get(v) ?? 0) + 1);
      return m;
    };
    const values = (k) => { const m = counts(k); return [[null, "All"], ...(k === "assignee" ? [["me", "me", m.get(raw.me) ?? 0]] : []), ...[...m.keys()].sort().map((v) => [v, v, m.get(v)])]; };
    const shownV = (k) => f[k] === "me" ? "me" : f[k] ? short(f[k], 22) : "all";
    const out = this.filterBar(t, "linear", [["assignee", "Assignee", shownV("assignee")], ["project", "Project", shownV("project")], ["initiative", "Initiative", shownV("initiative")]],
      f, (x) => this.setLf(x), values);
    const by = {};
    for (const i of issues) (by[i.state] ??= []).push(i);
    const rows = [];
    for (const [state, list] of Object.entries(by)) {
      rows.push({ header: `${state} · ${list.length}` });
      for (const i of list) rows.push({ label: i.identifier, sub: `${short(i.title, 50)}${f.assignee ? "" : ` · ${i.assignee.split(" ")[0]}`}`, url: i.url });
    }
    if (!issues.length) rows.push({ label: "No issue for these filters" });
    if (raw.more) rows.push({ label: "More than 250 issues: list cut" });
    return [...out, ...rows.map((r, n) => this.row(r, n, "linear", t))];
  }

  collapsed() { return shared("ops.collapsed") ?? this.local; }
  toggle(id) {
    const c = { ...this.collapsed(), [id]: !this.collapsed()[id] };
    this.local = c;
    setShared("ops.collapsed", c);
  }

  row(r, i, id, t) {
    const col = (n) => ({ error: t.ansi1, warn: t.blocked, accent: t.accent, dim: t.dim, working: t.working, done: t.done }[n] ?? t.muted);
    if (r.header) return div().px(12).pt(6).pb(2).text_size(10).text_color(t.dim).child(r.header.toUpperCase());
    const clickable = (e) => e.when(r.url, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => open(r.url)));
    if (r.badges) {
      // Badges on the first line, the title under it: both fit the narrow panel.
      const top = h_flex().w_full().gap(4).items_center().flex_wrap();
      for (const [text, c] of r.badges)
        top.child(div().flex_none().px(5).py(1).rounded(4).border_1().border_color(col(c)).text_size(10).text_color(col(c)).child(text));
      return clickable(v_flex().id(`${id}-${i}`).w_full().px(12).py(4).gap(2).flex_none()
        .child(top).child(h_flex().w_full().gap(6).child(div().flex_none().text_size(12).child(r.label)).child(div().flex_1().min_w(0).truncate().text_size(11).text_color(col("dim")).child(r.sub ?? ""))));
    }
    const el = clickable(h_flex().id(`${id}-${i}`).w_full().min_h(24).px(12).py(2).gap(6).items_center().flex_none())
      .when(r.dot, (e) => e.child(div().w(7).h(7).flex_none().rounded(4).bg(col(r.dot))));
    el.child(div().flex_none().text_size(12).text_color(r.link ? t.accent : t.foreground).child(r.label));
    if (r.sub) el.child(div().flex_1().min_w(0).truncate().text_size(11).text_color(col(r.subColor)).child(r.sub));
    return el;
  }

  section(s, t) {
    const d = this.data[s.id] ?? {}, closed = !props()?.section && this.collapsed()[s.id];
    const rows = d.setup ? [] : d.rows ?? [];
    const custom = s.filtered && !d.setup ? (s.filtered === "prs" ? this.prsView(d, t) : s.filtered === "cost" ? this.costView(d, t) : this.linearRows(d, t)) : null;
    return v_flex().w_full().flex_none()
      .child(h_flex().id(`ops-h-${s.id}`).w_full().h(30).flex_none().px(12).gap(8).items_center().cursor_pointer()
        .border_b(1).border_color(t.border).hover((e) => e.bg(t.hover))
        .on_click(() => { this.toggle(s.id); })
        .when(!props()?.section, (e) => e.child(div().w(10).text_size(10).text_color(t.dim).child(closed ? "▸" : "▾")))
        .child(div().font_semibold().text_size(12).child(s.title))
        .child(div().flex_1())
        .child(div().text_size(11).text_color(d.warn ? t.blocked : t.muted).child(d.summary ?? (d.loading ? "…" : ""))))
      .when(!closed, (e) => e
        .when(Boolean(d.error), (e) => e.child(div().px(12).py(4).text_size(11).text_color(d.setup ? t.blocked : t.ansi1).child(d.error)))
        .children(custom ?? rows.map((r, i) => this.row(r, i, s.id, t)))
        .when(!custom && !rows.length && !d.error, (e) => e.child(div().px(12).py(4).text_size(11).text_color(t.dim).child(d.loading ? "Loading…" : "Nothing"))));
  }

  render(_cx) {
    const t = theme();
    return v_flex().id("ops-root").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background)
      .border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(v_flex().id("ops-scroll").flex_1().min_h(0).w_full().overflow_y_scrollbar()
        .children(this.sections().map((s) => this.section(s, t))));
  }
}

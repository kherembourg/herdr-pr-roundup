// Copy of mods/pr-roundup-spaces/diff.js (a mod cannot import from another mod folder). Keep the two in sync.
// A PR's diff in a pane, drawn like the shipped Changes panel: files on top, the picked file's diff below.

import { div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list } from "gpui-base";
import { exec, run, theme, settings, home, focused, panes, shared, setShared } from "herdr";

// Tests, docs and markdown: hidden until asked for.
export const NOT_SOURCE = /(^|\/)(tests?|androidTest|testFixtures|__tests__|specs?|docs?|fixtures?)\/|Tests?\.(kt|java|swift|m|mm)$|[._](test|spec)\.[jt]sx?$|_test\.(go|py|rb)$|\.md$/;
const MAX_LINES = 3000;

// `gh pr diff` output -> one entry per file, with its hunks.
export function parseDiff(text) {
  const files = [];
  let file = null;
  for (const line of text.split("\n")) {
    const head = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (head) {
      file = { path: head[2], status: "M", add: 0, del: 0, lines: [] };
      files.push(file);
    } else if (!file) continue;
    else if (line.startsWith("new file mode")) file.status = "A";
    else if (line.startsWith("deleted file mode")) file.status = "D";
    else if (line.startsWith("Binary files")) file.lines.push("Binary file changed");
    else if (line.startsWith("@@") || file.lines.length) {
      if (line.startsWith("+")) file.add++;
      else if (line.startsWith("-")) file.del++;
      file.lines.push(line);
    }
  }
  for (const f of files) if (f.lines.at(-1) === "") f.lines.pop();
  return files;
}

// The choices a ▾ opens, as a small menu (not buttons): `onPick(x, cx)`.
export function choiceMenu(t, id, list, current, onPick) {
  return v_flex().min_w(150).p(3).rounded(7).border_1().border_color(t.border).bg(t.popover).text_size(12)
    .children(list.map((x) => {
      const on = x.name === current?.name;
      return h_flex().id(`${id}-${x.name}`).h(24).px(8).gap(8).items_center().rounded(5).cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { cx.stop_propagation(); onPick(x, cx); })
        .child(div().flex_1().text_color(on ? t.foreground : t.muted).child(x.name))
        .when(on, (e) => e.child(div().text_color(t.accent).child("✓")));
    }));
}

// Numbers each diff line once, so a frame only draws the rows on screen (as in Changes).
function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0];
    if (kind === "-") return { kind, number: old++, text: line.slice(1) || " " };
    if (kind === "+") return { kind, number: next++, text: line.slice(1) || " " };
    if (kind === " ") { old++; return { kind, number: next++, text: line.slice(1) || " " }; }
    return { kind: "", text: line };
  });
}

function diffRow({ kind, number, text }, t) {
  if (kind === "@") return div().w_full().px(12).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
  return h_flex().w_full().h(20).flex_none().gap(10).when(kind === "+", (e) => e.bg(t.ansi2 + "18")).when(kind === "-", (e) => e.bg(t.ansi1 + "18"))
    .child(div().w(30).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
    .child(div().flex_1().min_w(0).truncate().child(text));
}

// The state and drawing of the diff pane; the view in main.js holds one of these.
export class PrDiff {
  constructor(pr) {
    this.pr = pr;
    this.born = Date.now();
    this.files = [];
    this.rows = [];
    this.width = 300;
    this.open = null;
    this.all = false;
    this.error = null;
    this.loading = false;
    this.ides = []; // installed IDEs (findIdes)
    this.idePicking = false;
  }

  // Puts "#1878 Title" in the pane header (pr-roundup-pane). A mod pane doesn't get its pane id,
  // but a pane split for it takes the focus; a pane already named keeps its name (a restart).
  claimTitle() {
    const id = focused()?.pane;
    const titles = shared("pane.titles") ?? {};
    if (!id || titles[id] || panes().find((p) => p.pane === id)?.mod !== "pr-roundup-spaces") return;
    this.pane = id;
    setShared("pane.titles", { ...titles, [id]: `#${this.pr.number} ${this.pr.title ?? ""}` });
  }

  releaseTitle() {
    const titles = { ...(shared("pane.titles") ?? {}) };
    // Panes gone while the app was closed leave names behind: drop those too.
    const live = new Set(panes().map((p) => p.pane));
    for (const id of Object.keys(titles)) if (id === this.pane || !live.has(id)) delete titles[id];
    setShared("pane.titles", titles);
  }

  load(cx) {
    this.loading = true;
    if (!this.ides.length) cx.spawn(async (cx) => { this.ides = await findIdes(); cx.notify(); });
    cx.spawn(async (cx) => {
      try {
        const r = await exec("gh", ["pr", "diff", String(this.pr.number), "-R", this.pr.repo, "--color=never"]);
        if (r.code !== 0) throw new Error(r.stderr.trim().split("\n")[0] || `gh exited with ${r.code}`);
        this.files = parseDiff(r.stdout);
        this.error = null;
        const shown = this.shown();
        if (!shown.some((f) => f.path === this.open)) this.pick(shown[0]?.path ?? null);
      } catch (e) {
        this.error = String(e.message ?? e);
      }
      this.loading = false;
      cx.notify();
    });
  }

  // The PR branch's worktree in the IDE `ide`.
  ide(ide, cx) {
    if (this.ideBusy) return;
    this.ideBusy = true;
    this.ideNote = null;
    this.ideFailed = false;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const path = await openIde(this.pr, ide);
        this.ideNote = `${ide.name}: ${path.replace(home(), "~")}`;
      } catch (e) {
        this.ideNote = `${ide.name} failed: ${e.message ?? e}`;
        this.ideFailed = true;
      }
      this.ideBusy = false;
      cx.notify();
    });
  }

  shown() {
    return this.all ? this.files : this.files.filter((f) => !NOT_SOURCE.test(f.path));
  }

  pick(path) {
    this.open = path;
    const lines = (this.files.find((f) => f.path === path)?.lines ?? [])
      .slice(0, MAX_LINES).map((l) => (l.length > 4000 ? l.slice(0, 4000) + "… (line truncated)" : l));
    this.rows = diffRows(lines);
    this.width = Math.max(300, ...lines.map((l) => l.length * 7 + 50));
  }

  render() {
    // The split pane takes the focus just after this view starts: try again for a moment.
    if (!this.pane && Date.now() - this.born < 3000) this.claimTitle();
    const t = theme();
    const shown = this.shown();
    const hidden = this.files.length - this.files.filter((f) => !NOT_SOURCE.test(f.path)).length;
    const add = shown.reduce((n, f) => n + f.add, 0), del = shown.reduce((n, f) => n + f.del, 0);
    const chip = (id, text, onClick) => div().id(id).px(6).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted)
      .when(Boolean(onClick), (e) => e.cursor_pointer().hover((s) => s.text_color(t.foreground)).on_click(onClick)).child(text);
    const ide = preferred(this.ides, "prs.ide");
    const empty = this.error || (this.loading ? "Loading the diff…" : this.files.length ? "Only tests and docs changed" : "No changes");
    return v_flex().id("pr-diff").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(36).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(chip("pr-diff-files", `${shown.length} files`))
        .when(hidden > 0, (e) => e.child(chip("pr-diff-all", this.all ? "Hide tests and docs" : `+ ${hidden} tests and docs`, (_e, cx) => {
          this.all = !this.all;
          if (!this.shown().some((f) => f.path === this.open)) this.pick(this.shown()[0]?.path ?? null);
          cx.notify();
        })))
        .when(Boolean(this.pr.clone && this.pr.branch && ide), (e) => e.child(chip("pr-diff-ide", this.ideBusy ? "Opening…" : `IDE: ${ide.name}`, (_e, cx) => this.ide(ide, cx)))
          .when(this.ides.length > 1, (e) => e.child(chip("pr-diff-ide-pick", this.idePicking ? "▴" : "▾", (_e, cx) => { this.idePicking = !this.idePicking; cx.notify(); }))))
        .child(chip("pr-diff-open", forge(this.pr.url), () => exec("open", [this.pr.url])))
        .child(chip("pr-diff-reload", "Reload", (_e, cx) => this.load(cx)))
        .child(div().flex_1())
        .child(div().text_size(11).text_color(t.ansi2).child(`+${add}`)).child(div().text_size(11).text_color(t.ansi1).child(`−${del}`)))
      // A chip opens that IDE and makes it the one-click default.
      .when(this.idePicking, (e) => e.child(div().px(14).py(6).border_b(1).border_color(t.border)
        .child(choiceMenu(t, "pr-diff-ide", this.ides, ide, (x, cx) => { setShared("prs.ide", x.name); this.idePicking = false; this.ide(x, cx); }))))
      .when(Boolean(this.ideNote), (e) => e.child(div().px(14).py(4).border_b(1).border_color(t.border).text_size(11)
        .text_color(this.ideFailed ? t.ansi1 : t.dim).child(this.ideNote)))
      .child(v_flex().id("pr-diff-list").flex_none().h(Math.min(200, Math.max(44, shown.length * 28 + 12))).overflow_y_scrollbar().p(6).border_b(1).border_color(t.border)
        .children(shown.map((f) => {
          const parts = f.path.split("/"), name = parts.pop();
          return h_flex().id(`pr-file-${f.path}`).h(28).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer()
            .when(this.open === f.path, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => { this.pick(f.path); cx.notify(); })
            .child(div().w(14).text_size(11).text_color(f.status === "A" ? t.ansi2 : f.status === "D" ? t.ansi1 : t.blocked).child(f.status))
            .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : "")).child(div().max_w(260).min_w(0).truncate().child(name)))
            .when(f.add > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${f.add}`)))
            .when(f.del > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${f.del}`)));
        }))
        .when(!shown.length, (e) => e.child(div().p(8).text_color(this.error ? t.ansi1 : t.dim).child(empty))))
      .child(div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
        .child(div().id("pr-diff-x").size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(this.width).h_full().child(v_virtual_list("pr-diff-rows", this.rows.length, 20, (i) => String(i),
            (range) => this.rows.slice(range.start, range.end).map((row) => diffRow(row, t))).size_full())))
        .child(Scrollbar.vertical("pr-diff-rows").viewport_from_layout().absolute().inset_0()));
  }
}

// IDEs a worktree can open in, by their command line tool; the first installed is the default.
const IDES = [["Zed", "zed"], ["Cursor", "cursor"], ["VS Code", "code"], ["Windsurf", "windsurf"], ["IntelliJ IDEA", "idea"], ["Android Studio", "studio"], ["Xcode", "xed"]];

export async function findIdes() {
  // macOS has xed even without Xcode: count it only with Xcode installed.
  const test = IDES.map(([, c]) => `command -v ${c} >/dev/null && ${c === "xed" ? "[ -d /Applications/Xcode.app ] && " : ""}echo ${c}`).join("; ");
  const r = await exec("sh", ["-c", test]).catch(() => null);
  const found = new Set((r?.stdout ?? "").split("\n"));
  return IDES.filter(([, c]) => found.has(c)).map(([name, cmd]) => ({ name, cmd }));
}

// The one picked last (shared, so the sidebar and every diff pane agree), else the first.
export const preferred = (list, key) => list.find((x) => x.name === shared(key)) ?? list[0] ?? null;

// `pr`: { clone, branch, ticket, number }. Returns the worktree's path.
// Zed and VS Code (and its forks) also open a side-by-side diff tab per changed source file,
// <base copy> against <worktree file>, so editing the right side edits the worktree. Other IDEs
// open the worktree: in JetBrains IDEs the GitHub plugin then offers the PR's review mode.
const VSCODE = new Set(["code", "cursor", "windsurf"]);

export async function openIde(pr, ide) {
  const path = await prWorktree(pr);
  const run = async (args) => {
    const r = await exec(ide.cmd, args);
    if (r.code !== 0) throw new Error(r.stderr.trim() || `${ide.cmd} failed`);
  };
  const pairs = (ide.cmd === "zed" || VSCODE.has(ide.cmd)) && pr.base ? await reviewPairs(path, pr) : [];
  // Zed takes every pair at once, before the folder (after it, `--diff` reads as a file name).
  if (ide.cmd === "zed") await run([...pairs.flatMap(([a, b]) => ["--diff", a, b]), path]);
  else if (VSCODE.has(ide.cmd)) {
    // VS Code takes one `--diff` per call: open the worktree's window, then each diff in it.
    // shortcut: `-r` reuses the window used last, which is the new one unless another took the focus meanwhile.
    await run(["-n", path]);
    for (const [a, b] of pairs) await run(["-r", "--diff", a, b]);
  } else await run([path]);
  return path;
}

// shortcut: at most 40 files get a diff tab; a bigger PR opens its first 40.
const REVIEW_TABS = 40;

// [base copy, worktree file] for the PR's changed source files: each file as it was at the merge
// base with the PR's base branch (a copy under ~/.herdr/pr-review), against the worktree's.
async function reviewPairs(path, pr) {
  const git = async (args) => {
    const r = await exec("git", ["-C", path, ...args]);
    if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").at(-1) || `git ${args[0]} failed`);
    return r.stdout.trim();
  };
  await git(["fetch", "origin", pr.base]);
  const base = await git(["merge-base", `origin/${pr.base}`, "HEAD"]);
  const files = (await git(["diff", "--name-only", "--diff-filter=d", base, "HEAD"])).split("\n")
    .filter((f) => f && !NOT_SOURCE.test(f)).slice(0, REVIEW_TABS);
  if (!files.length) return [];
  const out = `${home()}/.herdr/pr-review/${pr.clone.split("/").pop()}-${pr.number}`;
  // A file the PR adds has no base: an empty one stands for it.
  const copy = 'set -e; dir=$1; at=$2; out=$3; shift 3; rm -rf "$out"; for f in "$@"; do mkdir -p "$out/$(dirname "$f")"; git -C "$dir" show "$at:$f" > "$out/$f" 2>/dev/null || : > "$out/$f"; done';
  const r = await exec("sh", ["-c", copy, "sh", path, base, out, ...files]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || "couldn't copy the base files");
  return files.map((f) => [`${out}/${f}`, `${path}/${f}`]);
}

// The PR's host, as a button name.
export function forge(url) {
  const host = url.match(/^https?:\/\/([^/]+)/)?.[1] ?? "";
  return /github/.test(host) ? "GitHub" : /gitlab/.test(host) ? "GitLab" : /bitbucket/.test(host) ? "Bitbucket" : host || "Web";
}

// The PR branch's worktree in its local clone: the one already on that branch, else a new one.
// `pr`: { clone, branch, ticket, number }. Returns the worktree's path.
export async function prWorktree({ clone, branch, ticket, number }) {
  const git = async (args) => {
    const r = await exec("git", ["-C", clone, ...args]);
    if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").at(-1) || `git ${args[0]} failed`);
    return r.stdout;
  };
  const list = await git(["worktree", "list", "--porcelain"]);
  const found = list.split("\n\n").map((e) => ({
    path: e.match(/^worktree (.+)$/m)?.[1],
    branch: e.match(/^branch refs\/heads\/(.+)$/m)?.[1],
  })).find((w) => w.branch === branch)?.path;
  if (found) return found;
  const slug = (ticket ?? branch).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  // A repo that ignores .worktrees/ keeps its worktrees there; others go to Herdr's own place.
  const ignored = (await exec("git", ["-C", clone, "check-ignore", "-q", ".worktrees/x"])).code === 0;
  const base = ignored ? `${clone}/.worktrees` : `${home()}/.herdr/worktrees/${clone.split("/").pop()}`;
  const taken = (await exec("test", ["-e", `${base}/${slug}`])).code === 0;
  const path = `${base}/${slug}${taken ? `-pr${number}` : ""}`;
  await git(["fetch", "origin", branch]);
  const local = (await exec("git", ["-C", clone, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;
  await git(local ? ["worktree", "add", path, branch] : ["worktree", "add", "--track", "-b", branch, path, `origin/${branch}`]);
  return path;
}

// Opens the diff beside the focused pane.
// `clone`: the local main checkout of the repo, for the IDE button (none: no button).
export const openDiff = (pr, clone) =>
  run("pane.split", { direction: "right", mod: "pr-roundup-spaces", props: { diff: {
    repo: pr.repo, number: pr.number, title: pr.title, url: pr.url, branch: pr.headRefName, base: pr.baseRefName, ticket: pr.ticket, clone: clone ?? null,
  } } });

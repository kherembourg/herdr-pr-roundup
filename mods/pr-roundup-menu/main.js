// The panel dropdown of the top bar: one row per panel section, with its badge.
// A click shows that section in the side panel. ↑/↓ move, Enter opens, Esc closes.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, props, closeOverlay, theme, shared } from "herdr";

// Keep in sync with OPS in mods/pr-roundup-tabs/main.js (a mod cannot import from another).
const OPS = [["files", "Files"], ["changes", "Changes"], ["cost", "Cost"], ["prs", "PRs"], ["linear", "Linear"]];

// Linear only when pr-roundup-tabs found a Linear tool.
const shown = () => OPS.filter(([id]) => id !== "linear" || shared("ops.linear"));

export default class OpsMenu extends View {
  init(_props, cx) {
    this.at = 0;
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  choose(i) {
    const [id] = shown()[i];
    closeOverlay(props()?.overlay);
    run("layout.select", { stack: "panel-body", child: id });
    run("layout.show", { id: "panel" });
  }

  render() {
    const t = theme();
    const active = props()?.active, OPS_ = shown();
    return v_flex().id("ops-menu").track_focus(this.handle).w_full().p(5).bg(t.popover).text_size(12.8)
      .on_key_down((e, cx) => {
        if (e.key === "down") this.at = (this.at + 1) % OPS_.length;
        else if (e.key === "up") this.at = (this.at + OPS_.length - 1) % OPS_.length;
        else if (e.key === "enter") this.choose(this.at);
        else if (e.key === "escape") closeOverlay(props()?.overlay);
        else return;
        cx.notify();
      })
      .children(OPS_.map(([id, label], i) => {
        const badge = shared(`ops.badge.${id}`);
        return h_flex().id(`om-${id}`).h(31).px(8).gap(9).rounded(7).items_center()
          .text_color(id === active ? t.foreground : t.muted).when(i === this.at, (el) => el.bg(t.selected))
          .hover((s) => s.bg(t.hover)).on_click(() => this.choose(i))
          .child(div().w(6).h(6).rounded(3).flex_none().bg(id === active ? t.accent : t.chrome))
          .child(div().flex_1().child(label))
          .when(Boolean(badge?.text), (el) => el.child(div().text_size(11).text_color(badge.warn ? t.blocked : t.dim).child(badge.text)));
      }));
  }
}

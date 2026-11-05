// How notifications look. Anything can post one with notify({ title, body,
// level, icon, action }); replace this mod to restyle them all. Click to
// run its action (e.g. go to the agent) and dismiss it.

import { View, div, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, run, theme } from "herdr";

const DOT = { error: "blocked", warning: "blocked", success: "done", info: "done" };

export default class Toast extends View {
  init(_props, cx) {
    const p = props() ?? {};
    if (/\bfinished\b/i.test(String(p.title ?? "")) && p.overlay) {
      cx.timer.after(0, () => closeOverlay(p.overlay));
    }
  }
  render(cx) {
    const t = theme();
    const p = props() ?? {};
    if (/\bfinished\b/i.test(String(p.title ?? ""))) return div().size(0);
    return h_flex()
      .id("toast")
      .size_full()
      .px(12)
      .gap(9)
      .items_center()
      .bg(t.chrome)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click(() => {
        if (p.action?.name) run(p.action.name, p.action.args ?? {});
        closeOverlay(p.overlay);
      })
      .child(p.icon ? image(p.icon).w(15).h(15).flex_none() : div().size(6).rounded(3).flex_none().bg(t[DOT[p.level] ?? "done"]))
      .child(
        v_flex()
          .flex_1()
          .overflow_hidden()
          .child(div().truncate().font_medium().text_size(12).text_color(t.foreground).child(p.title ?? ""))
          .when(Boolean(p.body), (el) => el.child(div().truncate().text_size(11).text_color(t.dim).child(p.body ?? ""))),
      );
  }
}

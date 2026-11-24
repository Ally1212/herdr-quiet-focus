// Agents in grouped or priority views; parents take their most urgent sub-agent's place.
// A viewed done agent stays in Done until left.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, terminals, panes, focused, spaces, run, theme, shared, setShared, setAgentOrder, openOverlay, closeOverlay, props, window, layout, exec, hc, appHome, checking, watchFolder } from "herdr";
import { questionInScreen, observed, unavailable } from "./attention.js";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// To the rail (on macOS wide enough for the traffic lights), or back to the width it had.
function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  // Mods edited before the rail went by width still read the flag.
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", { id: "sidebar", px: narrow() ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44 });
}

const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();

function leadPanes(all) {
  const leads = new Map();
  for (const p of all) {
    if (!p.terminal) continue;
    const current = leads.get(p.tab);
    // First agent, else first focused terminal, else first terminal in the tab.
    if (!current || (!current.program?.agent && (p.program?.agent || (!current.focused && p.focused)))) leads.set(p.tab, p);
  }
  return leads;
}

function title(tab, l) {
  const prog = l?.program?.name;
  const live = clean(l?.title);
  const telling = live && live !== prog && !/^[~/]|^[A-Za-z]:\\/.test(live) && !live.includes("@") && live.toLowerCase() !== l?.program?.key;
  return (tab.name === prog || !tab.named) && telling ? live : tab.name;
}
const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
// A sub-agent without a pane isn't in agents(): its raw word, error counting as
// blocked. It's never done: it reports to its parent, and the parent's done is the news.
const kidStatus = (k, listed) => {
  const s = listed.get(k.address) ?? k.status;
  return s === "error" ? "blocked" : s === "done" ? "idle" : s;
};
const SORTS = [
  { id: "priority", label: "按优先级", icon: "clock" },
  { id: "grouped", label: "按项目分组", icon: "layers" },
];
const sortOf = () => SORTS.find((s) => s.id === shared("agents.sort")) ?? SORTS[0];
const SECTION = { 4: "待处理", 3: "已完成", 2: "运行中", 1: "就绪" };
const SECTION_STATUS = { 4: "blocked", 3: "done", 2: "working", 1: "idle" };
const FOCUSED_SPIN_MS = 1100;
const ACTIVITY_WINDOW_MS = 15000;

function spinPeriod(toolCalls) {
  if (toolCalls >= 6) return 650;
  if (toolCalls >= 3) return 800;
  if (toolCalls >= 1) return 950;
  return FOCUSED_SPIN_MS;
}

function pinwheel(t, size, { focused = false, animate = true, period = FOCUSED_SPIN_MS } = {}) {
  return svg("mods/ziheng-pinwheel-tasks/pinwheel.svg").size(size).flex_none().text_color(t.working)
    .when(animate && focused, el => el.spin(period))
    .when(animate && !focused, el => el.loop("opacity", { from: .5, to: 1, period: 1400 }));
}

function completedPinwheel(t, size) {
  return svg("mods/ziheng-pinwheel-tasks/pinwheel-done.svg").size(size).flex_none().text_color(t.ansi1);
}

function pendingBell(t, size) {
  return svg("mods/ziheng-pinwheel-tasks/pending-bell.svg").size(size).flex_none().text_color(t.blocked);
}

function readyPinwheel(t, size) {
  return svg("mods/ziheng-pinwheel-tasks/pinwheel-ready.svg").size(size).flex_none().text_color(t.idle ?? t.muted);
}

function mixColor(base, accent, amount) {
  if (!/^#[\da-f]{6}$/i.test(base) || !/^#[\da-f]{6}$/i.test(accent)) return base;
  const channels = [1, 3, 5].map(offset => {
    const from = parseInt(base.slice(offset, offset + 2), 16);
    const to = parseInt(accent.slice(offset, offset + 2), 16);
    return Math.round(from + (to - from) * amount).toString(16).padStart(2, "0");
  });
  return "#" + channels.join("");
}

function taskTitle(a, tabTitle) {
  const project = a.space_name?.trim().toLowerCase();
  for (const value of [tabTitle, a.title]) {
    const parts = clean(value).split(/\s+[|｜]\s+/);
    if (parts.at(-1)?.toLowerCase() === project) parts.pop();
    const title = parts.join(" | ").trim();
    if (title && !/^\d+$/.test(title)) return title;
  }
  return a.program?.name || "未命名任务";
}

function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// The agent's icon from the app's program table: a one-color glyph or a picture.
function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

export default class Agents extends View {
  init(_props, cx) {
    if (props()?.sortMenu) return;
    this.folded = new Set();
    this.attention = {};
    this.scanning = false;
    if (!checking()) {
      setShared("ziheng.pinwheel.attention.v1", {});
      this.scan(cx);
      cx.timer.every(4000, (cx) => {
        this.scan(cx);
        if (this.toolActivity?.disconnected) this.followToolActivity(agents(), cx, true);
      });
    }
    // Each agent's last state and when it changed (ms), kept across restarts.
    this.changed = JSON.parse(localStorage.getItem("changed") ?? "{}");
    this.pendingPins = JSON.parse(localStorage.getItem("pins") ?? "[]");
    if (!this.pendingPins.length) localStorage.removeItem("pins");
    this.migratingPins = new Set();
    if (!checking()) cx.timer.every(30000, (cx) => cx.notify());
  }

  stopToolActivity() {
    const activity = this.toolActivity;
    this.toolActivity = null;
    activity?.watch?.cancel();
    activity?.expiry?.cancel();
  }

  followToolActivity(list, cx, retry = false) {
    if (checking()) return;
    const agent = list.find(a => a.focused && (a.execution ?? a.status) === "working"
      && !a.address.includes("/") && (a.app === "codex" || a.program?.key === "codex"));
    if (agent?.address === this.toolActivity?.address && !retry) return;
    this.stopToolActivity();
    if (!agent) return;

    const activity = { address: agent.address, period: FOCUSED_SPIN_MS, calls: [] };
    this.toolActivity = activity;
    cx.spawn(async (cx) => {
      try {
        const terminal = await hc(["get", activity.address, "--json"]);
        const pid = terminal.code === 0 ? JSON.parse(terminal.stdout).foreground?.pid : null;
        if (!Number.isInteger(pid) || pid <= 0) return;
        const path = await this.readToolActivity("locate", String(pid));
        if (!path || this.toolActivity !== activity) return;
        const folder = path.slice(0, path.lastIndexOf("/"));
        activity.watch = watchFolder(folder);
        await this.updateToolActivity(activity, path, cx);
        while (this.toolActivity === activity) {
          const changed = await activity.watch;
          if (!changed.length || this.toolActivity !== activity) return;
          activity.watch = watchFolder(folder);
          if (changed.includes(path) || changed.includes(folder)) {
            await this.updateToolActivity(activity, path, cx);
          }
        }
      } catch (_) {
        // A rollout can disappear or change when Codex restarts.
      } finally {
        activity.watch?.cancel();
        if (this.toolActivity === activity) {
          activity.disconnected = true;
          activity.calls = [];
          this.applyToolActivity(activity, cx);
        }
      }
    });
  }

  async readToolActivity(command, value) {
    const script = `${appHome()}/mods/ziheng-pinwheel-tasks/tool-activity.py`;
    const result = await exec("python3", [script, command, value], { timeout: 1800 });
    if (result.code !== 0) throw new Error("Codex activity unavailable");
    return JSON.parse(result.stdout);
  }

  async updateToolActivity(activity, path, cx) {
    const calls = await this.readToolActivity("recent", path);
    if (this.toolActivity !== activity) return;
    activity.calls = calls;
    this.applyToolActivity(activity, cx);
  }

  applyToolActivity(activity, cx) {
    activity.expiry?.cancel();
    const now = Date.now();
    activity.calls = activity.calls.filter(at => at + ACTIVITY_WINDOW_MS > now);
    if (activity.calls.length) {
      const nextExpiry = Math.min(...activity.calls) + ACTIVITY_WINDOW_MS;
      activity.expiry = cx.timer.after(nextExpiry - now, cx => {
        activity.expiry = null;
        if (this.toolActivity === activity) this.applyToolActivity(activity, cx);
      });
    }
    const period = spinPeriod(activity.calls.length);
    if (activity.period !== period) {
      activity.period = period;
      cx.notify();
    }
  }

  // Read-only, screen only (no history scrolling), at most two reads in flight.
  scan(cx) {
    if (this.scanning) return;
    this.scanning = true;
    cx.spawn(async (cx) => {
      try {
        const candidates = agents().filter(a => a.app === "codex" || a.program?.key === "codex");
        const next = {};
        for (let i = 0; i < candidates.length; i += 2) {
          await Promise.all(candidates.slice(i, i + 2).map(async a => {
            try {
              const r = await hc(["read", a.address, "--lines", "0", "--json"]);
              if (r.code !== 0) throw new Error("screen unavailable");
              const data = JSON.parse(r.stdout);
              if (data.how !== "screen" || typeof data.text !== "string") throw new Error("unexpected screen response");
              const evidence = observed(this.attention[a.address], questionInScreen(data.text), Date.now());
              if (evidence) next[a.address] = { ...evidence, tab: a.tab, space: a.space };
            } catch (_) {
              const previous = unavailable(this.attention[a.address], Date.now());
              if (previous) next[a.address] = previous;
            }
          }));
        }
        // A terminal closed during the read must not reappear as a pending question.
        const live = new Set(agents().map(a => a.address));
        const updated = Object.fromEntries(Object.entries(next).filter(([id]) => live.has(id)));
        if (JSON.stringify(updated) !== JSON.stringify(this.attention)) {
          this.attention = updated;
          setShared("ziheng.pinwheel.attention.v1", this.attention);
          cx.notify();
        }
      } finally { this.scanning = false; }
    });
  }

  close() {
    this.stopToolActivity();
    if (!checking() && !props()?.sortMenu) setShared("ziheng.pinwheel.attention.v1", {});
  }

  withAttention(list) {
    return list.map(a => {
      const attention = this.attention?.[a.address];
      return attention ? { ...a, execution: a.status, status: "blocked", attention } : a;
    });
  }

  // Stamps agents whose state changed. Done and idle count as one: looking at a
  // finished agent turns done into idle, and looking isn't the agent doing anything.
  track(list, now) {
    let dirty = false;
    for (const a of list) {
      const s = a.status === "done" ? "idle" : a.status;
      if (this.changed[a.address]?.s === s) continue;
      this.changed[a.address] = { s, at: now };
      dirty = true;
    }
    if (!dirty) return;
    // Gone and old: the list alone is empty right after a start.
    const listed = new Set(list.map((a) => a.address));
    for (const [k, c] of Object.entries(this.changed)) if (!listed.has(k) && now - c.at > 30 * 86400000) delete this.changed[k];
    localStorage.setItem("changed", JSON.stringify(this.changed));
  }

  // Keep offline pins until their terminal returns, and keep each pending until
  // core echoes the label so a failed write doesn't erase the old pin.
  migratePins(all) {
    const listed = new Map(all.filter((t) => t.state === "live").map((t) => [t.address, t]));
    const pending = this.pendingPins.filter((address) => {
      const terminal = listed.get(address);
      if (!terminal) return true;
      if (terminal.labels?.["herdr.pinned"]) return false;
      if (!this.migratingPins.has(address)) {
        this.migratingPins.add(address);
        run("terminal.pin", { terminal: address, pinned: true });
      }
      return true;
    });
    if (pending.length === this.pendingPins.length) return;
    this.pendingPins = pending;
    if (pending.length) localStorage.setItem("pins", JSON.stringify(pending));
    else localStorage.removeItem("pins");
  }

  since(a) {
    return this.changed[a.address]?.at ?? 0;
  }

  // Looking at a done agent makes it idle; it stays with Done until you leave
  // it rather than drop away under you. Any other change moves it at once.
  hold(list) {
    const cur = list.find((a) => a.focused);
    const same = cur && cur.address === this.held?.address;
    // Arriving, or any change but done turning idle, sets what it was.
    if (!same || cur.status !== "idle") this.held = cur ? { address: cur.address, rank: RANK[cur.status] ?? 0 } : null;
  }

  rank(a) {
    const sawDone = a.address === this.held?.address && this.held.rank === RANK.done && a.status === "idle";
    return sawDone ? RANK.done : RANK[a.status] ?? 0;
  }

  sortMenu(t) {
    const on = sortOf().id;
    return v_flex()
      .w_full()
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).child("任务排序"))
      .children(SORTS.map((s) => h_flex()
        .id(`sort-${s.id}`)
        .h(31)
        .px(8)
        .gap(9)
        .rounded(7)
        .items_center()
        .text_color(t.foreground)
        .hover((el) => el.bg(t.hover))
        .on_click(() => {
          setShared("agents.sort", s.id);
          closeOverlay(props().overlay);
        })
        .child(svg(`mods/workspace-chrome/${s.icon}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().child(s.label))
        .when(s.id === on, (el) => el.child(svg("mods/workspace-chrome/check.svg").size(14).flex_none().text_color(t.foreground)))));
  }

  peek(addr) {
    run("terminal.peek", { terminal: addr });
  }

  // Live sub-agents of `addr`, depth first, each with the tree lines in front of it.
  tree(all, addr, lead = []) {
    const kids = all.filter((k) => k.parent === addr && k.state === "live");
    return kids.flatMap((k, i) => {
      const last = i === kids.length - 1;
      return [
        { t: k, lines: [...lead, last ? "└" : "├"] },
        ...this.tree(all, k.address, [...lead, last ? "" : "│"]),
      ];
    });
  }

  subRow(t, s, shown) {
    const k = s.t;
    const st = kidStatus(k, this.listed);
    const pic = icon(k.program, 14, t.foreground);
    const on = k.address === shown;
    return h_flex()
      .id(`sub-${k.address}`)
      .pl(39)
      .pr(8)
      .rounded(8)
      .h(26)
      .flex_none()
      .gap(0)
      .items_center()
      .text_size(12.5)
      .when(on, (el) => el.bg(t.raised))
      .hover((s) => s.bg(t.hover))
      .on_click(() => this.peek(k.address))
      .children(s.lines.map(l => div().self_start().mt(-4).w(9).h(17).mr(4).flex_none()
        .when(Boolean(l), el => el.border_l(1.5).border_color(t.input))
        .when(l === "└" || l === "├", el => el.border_b(1.5).rounded_bl(6))))
      .when(Boolean(pic), el => el.child(div().mr(8).child(pic)))
      .child(div().flex_1().truncate().text_color(on ? t.foreground : t.muted).child(k.name || k.template || k.program?.name || k.address))
      .child(this.status(t, { address: k.address, status: st, focused: on }));
  }

  status(t, a) {
    const period = this.toolActivity?.address === a.address ? this.toolActivity?.period : undefined;
    const motion = { focused: a.focused, period };
    const slot = h_flex().size(22).flex_none().items_center().justify_center();
    if (a.attention) {
      const text = a.attention.stale ? "待核验" : `待回答 ${a.attention.count}`;
      return h_flex().gap(5).flex_none().items_center()
        .when(a.execution === "working", el => el.child(pinwheel(t, 14, motion)))
        .child(div().text_size(11).text_color(t.blocked).child(text))
        .child(slot.child(pendingBell(t, 17)))
        .tooltip(a.attention.stale ? "终端读取失败，尚未确认问题是否已解决" : (a.execution === "working" ? "有问题待回答，任务仍在运行；点击任务查看并回答" : "点击任务查看并回答"));
    }
    if (a.status === "working") return slot.child(pinwheel(t, 18, motion));
    if (a.status === "blocked") return slot.accessibility_label("待处理").tooltip("待处理").child(pendingBell(t, 17));
    if (a.status === "idle") return slot.child(readyPinwheel(t, 18));
    if (a.status === "done") return slot.accessibility_label("已完成").child(completedPinwheel(t, 16));
    return slot;
  }

  render(cx) {
    const palette = theme();
    if (props()?.sortMenu) return this.sortMenu(palette);
    const t = {
      ...palette,
      blocked: mixColor(palette.blocked, palette.foreground, .25),
      ansi1: mixColor(palette.ansi1, palette.foreground, .25),
      taskSelection: mixColor(palette.chrome, palette.selected, .78),
    };
    const collapsed = narrow();
    const sort = sortOf();
    let list = this.withAttention(agents());
    this.followToolActivity(list, cx);
    this.listed = new Map(list.map((a) => [a.address, a.status]));
    const all = terminals();
    this.migratePins(all);
    const shown = focused()?.agent;
    const now = Date.now();
    this.track(list, now);
    this.hold(list);
    const byPriority = sort.id === "priority";
    const urgency = new Map(list.map((a) => [a.address, Math.max(this.rank(a), ...this.tree(all, a.address).map((s) => RANK[kidStatus(s.t, this.listed)] ?? 0))]));
    const rankOf = (a) => urgency.get(a.address);
    if (byPriority) list = [...list].sort((x, y) => rankOf(y) - rankOf(x) || this.since(y) - this.since(x) || y.seq - x.seq);
    const pinned = list.filter((a) => a.pinned);
    const rest = list.filter((a) => !a.pinned);
    list = [...pinned, ...rest];
    setAgentOrder(list.map((a) => a.address));

    const withKids = (a, i) => {
      const subs = collapsed ? [] : this.tree(all, a.address);
      const r = row(a, i, subs);
      if (this.folded.has(a.address)) return [r];
      return [r, ...subs.map((s) => this.subRow(t, s, shown))];
    };

    // The fold chevron; folded, the count too, colored by the most urgent one.
    const fold = (a, subs) => {
      const sts = subs.map((s) => kidStatus(s.t, this.listed));
      const top = sts.reduce((m, s) => ((RANK[s] ?? 0) > (RANK[m] ?? 0) ? s : m), null);
      const open = !this.folded.has(a.address);
      return div()
        .id(`fold-${a.address}`)
        .h(18)
        .px(3)
        .gap(3)
        .flex()
        .items_center()
        .rounded(4)
        .text_size(11)
        .text_color(open ? t.dim : (t[top] ?? t.dim))
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => {
          cx.stop_propagation();
          open ? this.folded.add(a.address) : this.folded.delete(a.address);
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none())
        .when(!open, (el) => el.child(String(subs.length)));
    };

    // Read the pane snapshot once: every host read copies the whole list into JS.
    const paneList = panes();
    const spaceList = spaces();
    const paneFolders = new Map(paneList.map(p => [p.pane, p.cwd]));
    const spaceFolders = new Map(spaceList.map(s => [s.id, s.folder]));
    const leads = leadPanes(paneList);
    const tabLabels = new Map(spaceList.flatMap(s => s.tabs).map(tab => [tab.id, title(tab, leads.get(tab.id))]));
    const row = (a, i, subs = []) => {
      const pic = icon(a.program, 18, t.foreground);
      // Match the visible Done group while Herdr acknowledges a focused task.
      const displayed = this.rank(a) === RANK.done ? { ...a, status: "done" } : a;
      if (collapsed) {
        return h_flex()
          .id(`ag-${a.address}`)
          .h(26)
          .px(8)
          .flex_none()
          .items_center()
          .gap(4)
          .hover((s) => s.bg(t.hover))
          .on_click(() => run("pane.focus", { pane: a.pane }))
          .child(div().flex_1().min_w(0).whitespace_nowrap().text_right().text_color(t.muted).child(String(i + 1)))
          .child(h_flex().w(22).flex_none().items_center().justify_center().child(
            a.attention ? this.status(t, { status: "blocked" }) : this.status(t, displayed),
          ));
      }
      const when = a.attention?.since ?? this.since(a);
      const isPinned = a.pinned;
      const pin = div()
        .id(`pin-${a.address}`)
        .flex_none()
        .p(2)
        .rounded(4)
        .text_color(t.dim)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip(isPinned ? "Unpin" : "Pin to the top")
        .on_click((_e, cx) => {
          cx.stop_propagation();
          run("terminal.pin", { terminal: a.address, pinned: !isPinned });
          // The row moves away from under the pointer, and no hover-out comes.
          this.hovered = null;
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/${isPinned ? "pin-off" : "pin"}.svg`).size(13));
      const title = taskTitle(a, tabLabels.get(a.tab));
      const folder = paneFolders.get(a.pane) || spaceFolders.get(a.space);
      const project = folder?.split(/[/\\]+/).filter(Boolean).at(-1) ?? folder;
      const machine = a.address.includes("/") ? a.address.split("/")[0] : null;
      return h_flex()
        .id(`ag-${a.address}`)
        .pl(5)
        .pr(9)
        .h(project ? 39 : 31)
        .flex_none()
        .rounded(8)
        .items_center()
        .gap(7)
        .when(a.focused, el => el.bg(t.taskSelection))
        .cursor_pointer()
        .hover(el => el.bg(a.focused ? t.taskSelection : t.hover))
        .on_hover((on, cx) => {
          if (on) this.hovered = a.address;
          else if (this.hovered === a.address) this.hovered = null;
          cx.notify();
        })
        .on_click(() => run("pane.focus", { pane: a.pane }))
        .when(Boolean(pic), el => el.child(div().id(`agent-fold-${a.address}`)
          .when(subs.length > 0, el => el.on_click((_e, cx) => {
            cx.stop_propagation();
            this.folded.has(a.address) ? this.folded.delete(a.address) : this.folded.add(a.address);
            cx.notify();
          })).child(pic)))
        .child(v_flex().id(`agent-title-${a.address}`).flex_1().min_w(0)
          .tooltip([folder, title, machine].filter(Boolean).join(" · "))
          .child(div().min_w(0).truncate().font_semibold().text_color(t.foreground).child(project || title))
          .when(Boolean(project), el => el.child(div().min_w(0).truncate().text_size(11)
            .text_color(t.muted).child(title))))
        .when(subs.length > 0, el => el.child(fold(a, subs)))
        .when(this.hovered === a.address, el => el.child(pin))
        .when(this.hovered !== a.address && Boolean(when) && !a.attention, el => el.child(div().flex_none().text_size(11).text_color(t.muted).child(duration(now - when))))
        .child(this.status(t, displayed));
    };

    // Groups in list order: spaces (grouped) or priority sections. Agents of a
    // space are next to each other in agents(), so neighbours make a group.
    const groups = pinned.length ? [{ id: "pinned", label: "已固定", status: null, members: pinned }] : [];
    for (const a of rest) {
      const r = rankOf(a) || RANK.idle;
      const id = byPriority ? `sec-${r}` : `sp-${a.space}`;
      if (groups.at(-1)?.id === id) groups.at(-1).members.push(a);
      else groups.push({ id, label: byPriority ? SECTION[r] : a.space_name || "", status: byPriority ? SECTION_STATUS[r] : null, members: [a] });
    }

    const railColor = mixColor(t.chrome, t.foreground, .20);
    const group = (g, index) => {
      const first = index === 0;
      const last = index === groups.length - 1;
      const open = !this.folded.has(g.id);
      const top = g.members.reduce((m, a) => ((RANK[a.status] ?? 0) > (RANK[m] ?? 0) ? a.status : m), null);
      const accent = g.status === "done" ? t.ansi1 : t[g.status] ?? t.muted;
      const header = h_flex().id(g.id).px(9).h(27).flex_none().gap(7).items_center()
        .rounded(5).text_size(12).text_color(mixColor(accent, t.foreground, .3))
        .cursor_pointer().hover(el => el.bg(t.hover))
        .tooltip(open ? "折叠分组" : "展开分组")
        .on_click((_e, cx) => {
          open ? this.folded.add(g.id) : this.folded.delete(g.id);
          cx.notify();
        })
        .child(h_flex().size(18).flex_none().items_center().justify_center()
          .rounded(9).bg(t.chrome).text_color(accent)
          .when(g.status === "working", el => el.child(pinwheel(t, 14, { animate: !open })))
          .when(g.status === "done", el => el.child(completedPinwheel(t, 14)))
          .when(g.status === "idle", el => el.child(readyPinwheel(t, 14)))
          .when(g.status === "blocked", el => el.child(pendingBell(t, 14)))
          .when(!g.status, el => el.child(svg(`mods/workspace-chrome/${g.id === "pinned" ? "pin" : "layers"}.svg`).size(12))))
        .child(div().min_w(0).truncate().font_semibold().child(g.label))
        .child(div().flex_none().text_size(10.5).text_color(t.muted).child(String(g.members.length)))
        .child(div().flex_1())
        .when(!open && !byPriority && top && top !== "idle", el => el.child(this.status(t, { status: top })))
        .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.muted));

      return v_flex().relative().flex_none().pb(last ? 0 : 9)
        .when(groups.length > 1, el => el.child(div().absolute().left(17.5)
          .top(first ? 13 : 0).w(1).bg(railColor)
          .when(last, line => line.h(13))
          .when(!last, line => line.bottom(0))))
        .child(header)
        .when(open, el => el.child(v_flex().pl(21).pt(5).pb(2).gap(3).children(g.members.flatMap(withKids))));
    };
    const rows = collapsed ? list.flatMap(withKids) : groups.map(group);

    return v_flex()
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(13)
      .when(!collapsed, (el) =>
        el.child(
          h_flex()
            .px(16)
            .h(36)
            .flex_none()
            .items_center()
            .justify_between()
            .child(div().text_size(12).font_semibold().text_color(t.foreground).child("任务"))
            .child(
              div()
                .id("ag-sort")
                .text_size(11)
                .text_color(t.muted)
                .hover((s) => s.text_color(t.foreground))
                .on_click(() => openOverlay({ mod: "ziheng-pinwheel-tasks", kind: "popup", width: 200, height: 140, props: { sortMenu: true } }))
                .tooltip(`任务排序 · ${sort.label}`)
                .child(svg(`mods/workspace-chrome/${sort.icon}.svg`).size(14)),
            ),
        ),
      )
      .when(list.length === 0 && !collapsed, (el) =>
        el.child(div().px(12).text_size(12).text_color(t.dim).child("No agent status yet. Agents show up here when they report their status. Older versions and agents inside tmux may not.")),
      )
      .child(v_flex().id("ag-list").flex_1().min_h(0).px(collapsed ? 0 : 10)
        .when(!collapsed, el => el.pb(8)).overflow_y_scrollbar().children(rows))
      .when(collapsed, (el) =>
        el.child(
          h_flex()
            .h(28)
            .items_center()
            .justify_center()
            .child(
              div()
                .id("collapse")
                .text_size(13)
                .text_color(t.dim)
                .hover((s) => s.text_color(t.foreground))
                .on_click(toggleSidebar)
                .child("»"),
            ),
        ),
      );
  }
}

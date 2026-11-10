// The rule behind the chip: anything that can be clicked looks
// clickable, and nothing else does: nothing may be clickable with nothing showing it's a control. These tests read the view's source, so a new click handler that isn't a chip fails here,
// naming its file.
import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { chipColours, chipText } from "./chip"
import { conversationLines } from "./panes/agent"
import { chip } from "./panes/lines"
import { C } from "./theme"

const VIEW = import.meta.dir

function sources(dir = VIEW): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name)
    if (e.isDirectory()) return sources(path)
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [path] : []
  })
}

const count = (text: string, pattern: RegExp) => (text.match(pattern) ?? []).length

/** Every click handler in the view, and why it's allowed. Anything new must be a chip, or be added here with its reason. */
const CLICKS: Record<string, { n: number; why: string }> = {
  "chip.tsx": { n: 1, why: "the chip itself" },
  "app.tsx": { n: 1, why: "a right-click copies the text selected with the mouse, and does nothing else" },
  "panes/lines.tsx": { n: 1, why: "a click on a card's body only highlights it, and on a token row selects it for the token pane, as a list's row is selected; its acting segments are chips" },
  "panes/pane.tsx": { n: 1, why: "a click on a pane only focuses it; on its border it also starts a resize as it's dragged" },
  "panes/layout-menu.tsx": { n: 1, why: "the layout menu's rows, a menu in the control colour" },
  "overlays.tsx": { n: 5, why: "an overlay closes on any click (it says so), and the agent, settings and Signals menus' rows" },
  "palette.tsx": { n: 1, why: "the palette's rows, a menu" },
  "panes/engines.tsx": { n: 1, why: "the model picker's rows, a menu, in the control colour" },
  "panes/approvals.tsx": { n: 1, why: "the approvals menu's wallet rows, a menu in the control colour; its settings and figures are chips" },
  "panes/triggers.tsx": { n: 1, why: "the Triggers overlay's rows pick a trigger, as the approvals menu's wallets do; what changes one is a chip" },
  "panes/memory.tsx": { n: 1, why: "the memory overlay's clear all, a menu row in the control colour; each line's delete is a ✕ chip" },
  "tabs.tsx": { n: 1, why: "the tabs, in the control colour" },
  "panes/cli-prompt.tsx": { n: 1, why: "a click on the prompt pane only focuses it" },
  "onboarding.tsx": { n: 2, why: "onboarding's choices, a menu in the control colour, and its typed fields, a click putting the caret there; its copies are chips" },
  "embedded-terminal.tsx": { n: 1, why: "a click in the pane's terminal focuses the pane; the child gets the click itself" },
}

test("every click handler in the view is a chip, a menu row, or a click that only focuses", () => {
  const found: Record<string, number> = {}
  for (const path of sources()) {
    const n = count(readFileSync(path, "utf8"), /onMouseDown/g)
    if (n > 0) found[relative(VIEW, path)] = n
  }
  expect(found).toEqual(Object.fromEntries(Object.entries(CLICKS).map(([file, { n }]) => [file, n])))
})

test("a clickable segment is made only by chip()", () => {
  for (const path of sources()) {
    if (path.endsWith(join("panes", "lines.tsx"))) continue
    expect({ file: relative(VIEW, path), acts: count(readFileSync(path, "utf8"), /\bact:\s*"/g) }).toEqual({ file: relative(VIEW, path), acts: 0 })
  }
})

test("the control colour is used only where things are clicked", () => {
  const allowed = new Set(["chip.tsx", "panes/lines.tsx", "tabs.tsx", "overlays.tsx", "palette.tsx", "panes/engines.tsx", "panes/memory.tsx", "status-bar.tsx", "panes/layout-menu.tsx", "panes/approvals.tsx", "onboarding.tsx"])
  for (const path of sources()) {
    const file = relative(VIEW, path)
    if (allowed.has(file)) continue
    expect({ file, uses: count(readFileSync(path, "utf8"), /C\.ctl\b(?!Bg|Hover)/g) }).toEqual({ file, uses: 0 })
  }
})

test("chips: padded, blue on a tint, approve solid, kill red", () => {
  expect(chip("⏎ approve", "approve", "primary")).toEqual({ text: " ⏎ approve ", fg: C.ctl, act: "approve", kind: "primary" })
  expect(chipText("resume")).toBe(" resume ")
  expect(chipColours("control")).toEqual({ fg: C.ctl, bg: C.ctlBg })
  expect(chipColours("control", true)).toEqual({ fg: C.ctl, bg: C.ctlHover })
  expect(chipColours("primary")).toEqual({ fg: C.page, bg: C.ctl })
  expect(chipColours("danger")).toEqual({ fg: C.bad, bg: C.badBg })
})

test("the agent's words never become a control, even when they name one", () => {
  const lines = conversationLines([{ turnId: "t1", user: "what can I do?", reply: "Press ctrl-r re-quote, or click ⏎ approve.", streaming: false, tools: [] }], 80)
  // The only control is the answer's own ⧉, which copies it.
  expect(lines.flatMap((l) => l.segs).filter((s) => s.act).map((s) => s.act)).toEqual(["copyReply"])
  expect(lines.some((l) => l.segs.some((s) => s.fg === C.ctl && s.act !== "copyReply"))).toBe(false)
})

test("amber means look at this, and appears only where that's what it says", () => {
  const LOOK: Record<string, string> = {
    "panes/card.tsx": "a waiting card's edge and expiry, a near limit, an unanswered card",
    "status-bar.tsx": "the cards-waiting count, the debug switch",
    "panes/token.tsx": "a flag, a check that didn't load, a stale read, a trending list that didn't load",
    "panes/agent.tsx": "the cards header while focused, an unanswered trade, Candle stopping a key",
    "panes/activity.tsx": "activity rows that want a look (withdrawn, no answer yet)",
    "panes/wallets.tsx": "an agent that can only read, a TEE wallet Candle has stopped, a portfolio read that failed",
    "panes/positions.tsx": "a portfolio read that failed",
    "panes/engines.tsx": "an engine that can't run here, and what to do",
    "panes/feed.tsx": "Final Stretch's source behind, and a list whose last read failed",
    "panes/signals.tsx": "Hacc refused every agent's key, so the tape can't show",
    "panes/pnl.tsx": "a book or fills whose read failed, and a failed trade with its error",
    "panes/journal.tsx": "a Journal row that wants a look (withdrawn, no answer yet, abandoned)",
    "panes/research.tsx": "a flag, an authority that can still mint or freeze, a sell that didn't route, and a check or read that didn't load",
    "panes/layout-menu.tsx": "a problem reading layouts.toml, with its line",
    "panes/away.tsx": "the core not running in the gap, trades outside the Candle Harness, and cards waiting now",
    "panes/every-wallet.tsx": "a name that breaks the Candle Harness's rules, taken by address only",
    "panes/approvals.tsx": "a wallet being turned on, and a key Candle doesn't cap, where only the Candle Harness's limits hold",
    "panes/triggers.tsx": "keep-awake that failed to start",
    "triggers-view.ts": "a trigger whose firings wait for you, one held, a card nobody pressed, and remove's question",
    "build-view.ts": "a paper test that isn't connected, and an alert the bot raises about itself",
    "bots-view.ts": "a bot paused or held, a slippage bound looser than its route's, what can't run live, the armed trailing level, and flatten's and remove's question",
    "trade-tab.tsx": "the card strip's header while its cards have focus, as the agent pane's",
    "too-small.tsx": "the window is too small",
    "pane-overlay.tsx": "a bot's card that opened while the person typed in their harness: the keys aren't on it yet",
    "popped.tsx": "a popped view's cards waiting in the main window, and its window too small",
    "tabs.tsx": "the agent's change to the screen waiting on the person's click, and a tab with its preview",
    "onboarding.tsx": "a step running, the line under an open pane, and that a subscription in OpenCode or Pi won't be used",
  }
  const found = sources()
    .map((path) => relative(VIEW, path))
    .filter((file) => count(readFileSync(join(VIEW, file), "utf8"), /C\.look\b/g) > 0)
    .sort()
  expect(found).toEqual(Object.keys(LOOK).sort())
})

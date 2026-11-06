// The Research tab's panes: Check's flags in words with amber only for a
// flag, Traders' P&L columns with ⧉ and a question by the wallet's address, its signals in Signals' words
// without the token column, Mentions' posts as data never put in a question, and each pane saying why
// it has nothing: no token, reading, Hacc off, a failed read.
import { describe, expect, test } from "bun:test"
import { CLOCK } from "../../../test/frame-scenes"
import { researchScene, YOUNG_MINT } from "../../../test/research-scene"
import type { ResearchView } from "../../core/research-reads"
import { type LayoutNode, RESEARCH } from "../layout"
import { C } from "../theme"
import { type Line, textOf } from "./lines"
import { checkLines, flagWords, mentionLines, researchParts, researchTitle, tokenSignalLines, traderLines } from "./research"

const NOW = CLOCK
const JUPF = { mint: "JupF1111111111111111111111111111111111111111", chain: "solana" as const, symbol: "JUPF" }
const jup = researchScene(NOW, "jup", JUPF)
const young = researchScene(NOW, "young", { mint: YOUNG_MINT, chain: "solana", symbol: "SPARK" })
const texts = (lines: Line[]) => lines.map(textOf)

describe("which parts a layout reads", () => {
  test("Research's four panes, each its part; the token pane and the agent read none", () => {
    expect(researchParts(["token", "check", "traders", "token-signals", "mentions", "agent"])).toEqual(["check", "traders", "signals", "mentions"])
    expect(researchParts(["token", "agent", "positions"])).toEqual([])
  })

  test("the preset: the token over Check, a list to pick from over Traders, its signals and Mentions beside them, the agent on the right; collapsed below 130", () => {
    expect(RESEARCH.collapse).toMatchObject({ below: 130, keep: "agent" })
    const tree = (n: LayoutNode): unknown => ("pane" in n ? n.pane : n.children.map(tree))
    expect(tree(RESEARCH.root)).toEqual([
      [
        ["token", "check"],
        ["lists", "traders", "token-signals", "mentions"],
      ],
      "agent",
    ])
  })
})

describe("titles", () => {
  test("each names its token; Traders its span, its signals how many", () => {
    expect(researchTitle("check", jup)).toBe("Check · JUPF")
    expect(researchTitle("traders", jup)).toBe("Traders · JUPF · 24h")
    expect(researchTitle("token-signals", jup)).toBe(`Its signals · JUPF · ${jup.signals!.data!.length}`)
    expect(researchTitle("mentions", { token: null })).toBe("Mentions")
  })
})

describe("Check", () => {
  test("each of Candle's flags in words, the mint, the sell probe, the dev wallet, holders, liquidity, age and stage", () => {
    const lines = texts(checkLines(young, { width: 52, now: NOW }))
    expect(lines[0]).toBe("incomplete: sellability unknown (not clean)")
    expect(texts(checkLines(young, { width: 30, now: NOW })).slice(0, 2)).toEqual(["incomplete: sellability", "unknown (not clean)"])
    for (const label of ["mint authority", "freeze authority", "token extensions", "LP lock", "sellability", "liquidity drain", "can mint more", "can freeze", "sell probe", "dev wallet", "holders", "liquidity", "age", "stage"])
      expect(lines.some((l) => l.startsWith(label))).toBe(true)
    expect(lines.find((l) => l.startsWith("stage"))).toBe("stage            on pump's curve, 63% along")
    expect(lines.find((l) => l.startsWith("holders"))).toBe("holders          129 · top 10 hold 86%")
    expect(lines.find((l) => l.startsWith("sell probe"))).toBe("sell probe       not run")
    expect(lines).toContain("Not checked: deploy window, disclosed wallets.")
    expect(lines.at(-1)).toMatch(/^Unknown, not clean\.$|^read: Candle \d\d:\d\d · Hacc \d\d:\d\d$/)
  })

  test("amber only for a flag: a flagged check's headline and its line, and an authority that can still mint", () => {
    const flagged: ResearchView = {
      ...jup,
      check: {
        ...jup.check!,
        candle: { at: NOW, data: { ...jup.check!.candle.data!, summary: "flagged", flags: [{ name: "mintAuthority", status: "flagged" }, { name: "lpLock", status: "clear" }], mint: { mintAuthority: "AuthFake111111111111111111111111111111111111", freezeAuthority: null, extensions: [], risks: [] } } },
      },
    }
    const lines = checkLines(flagged, { width: 52, now: NOW })
    const amber = lines.filter((l) => l.segs.some((s) => s.fg === C.look)).map(textOf)
    expect(amber).toEqual(["⚑ flagged: mint authority", "mint authority   ⚑ flagged", "can mint more    yes: Auth…1111"])
    // The clear check has none.
    expect(checkLines(jup, { width: 52, now: NOW }).some((l) => l.segs.some((s) => s.fg === C.look))).toBe(false)
    expect(textOf(checkLines(jup, { width: 52, now: NOW })[0]!)).toBe("✓ no flags: all six checks clear")
  })

  test("the dev wallet's ⧉ copies its address, shown in full after", () => {
    const lines = checkLines(jup, { width: 52, now: NOW })
    const dev = lines.find((l) => textOf(l).startsWith("dev wallet"))!
    expect(dev.ref).toBe("DevFake111111111111111111111111111111111111")
    expect(dev.segs.some((s) => s.act === "copy")).toBe(true)
    expect(texts(checkLines(jup, { width: 52, now: NOW, shownInFull: dev.ref! }))).toContain("DevFake111111111111111111111111111111111111")
  })

  test("a JUP-like token: years old, graduated, its holders in thousands", () => {
    const lines = texts(checkLines(jup, { width: 52, now: NOW }))
    expect(lines.find((l) => l.startsWith("age"))).toMatch(/^age {14}\d\.\d years$/)
    expect(lines.find((l) => l.startsWith("stage"))).toBe("stage            graduated")
    expect(lines.find((l) => l.startsWith("holders"))).toBe("holders          831K · top 10 hold 65%")
  })

  test("Candle's check failed or still reading, and Hacc off: each said, unchecked never read as clean", () => {
    expect(texts(checkLines(researchScene(NOW, "reading", JUPF), { width: 52, now: NOW }))).toEqual(["Reading Candle's check…", "Reading Hacc's holders and age…"])
    const failed: ResearchView = { ...jup, check: { candle: { at: NOW, data: null, failed: { at: NOW, words: "CANDLE_MCP_DOWN" } }, hacc: jup.check!.hacc } }
    expect(textOf(checkLines(failed, { width: 80, now: NOW })[0]!)).toBe("Candle's check didn't load (CANDLE_MCP_DOWN): unchecked, not clean.")
    const off = texts(checkLines(researchScene(NOW, "hacc-off", JUPF), { width: 80, now: NOW }))
    expect(off).toContain("Hacc's data is off in this Candle Harness's config ([hacc] enabled = false).")
  })

  test("flag names in words, an unknown one from its own name", () => {
    expect([flagWords("lpLock"), flagWords("mintAuthority"), flagWords("transferFeeHook")]).toEqual(["LP lock", "mint authority", "transfer fee hook"])
  })
})

describe("Traders", () => {
  test("the wallet with ⧉, realised and unrealised, signed; under 50 cents, $0", () => {
    const lines = traderLines(jup, { width: 40, now: NOW })
    expect(textOf(lines[0]!)).toBe("wallet        realised  unreal.")
    expect(textOf(lines[1]!)).toBe("Hacc…111T  ⧉    -$5.4K       $0")
    expect(textOf(lines[2]!)).toBe("Hacc…111U  ⧉    +$1.1K    -$895")
    expect(lines[1]!.ref).toBe("HaccFake1111111111111111111111111111111111T")
    expect(lines[1]!.segs.find((s) => s.text.includes("-$5.4K"))!.fg).toBe(C.bad)
  })

  test("narrow, unrealised goes first; wide, a label or handle in what's left, never in the question", () => {
    expect(textOf(traderLines(jup, { width: 28, now: NOW })[0]!)).toBe("wallet        realised")
    const named: ResearchView = { ...jup, traders: { at: NOW, data: [{ address: "HaccFake1111111111111111111111111111111111T", realizedUsd: 1200, unrealizedUsd: 0, trades: 40, handle: "loud_kol", label: "Some Fund", tracked: true }] } }
    const row = traderLines(named, { width: 50, now: NOW })[1]!
    expect(textOf(row)).toContain("Some Fund")
    expect(row.pick).toEqual({
      id: "HaccFake1111111111111111111111111111111111T",
      mint: "",
      ask: "What do you make of the wallet HaccFake1111111111111111111111111111111111T, one of JUPF's top traders? From Research: +$1.2K realised, $0 unrealised, 40 trades in 24h.",
    })
    expect(row.pick!.ask).not.toContain("Some Fund")
    expect(row.pick!.ask).not.toContain("loud_kol")
  })

  test("no traders, reading, failed with the last rows kept", () => {
    expect(texts(traderLines({ ...jup, traders: { at: NOW, data: [] } }, { width: 60, now: NOW }))).toEqual(["Hacc has no traders on JUPF in the last 24 hours."])
    expect(texts(traderLines({ ...jup, traders: { at: null, data: null } }, { width: 60, now: NOW }))).toEqual(["Reading Hacc's top traders…"])
    const failed = texts(traderLines({ ...jup, traders: { ...jup.traders!, failed: { at: NOW, words: "Hacc failed (503: busy)." } } }, { width: 200, now: NOW }))
    expect(failed.at(-1)).toMatch(/^The last read failed \(Hacc failed \(503: busy\)\.\); these are from \d\d:\d\d\.$/)
    expect(texts(traderLines({ ...jup, traders: { at: NOW, data: null, failed: { at: NOW, words: "Hacc didn't answer in 5 s." } } }, { width: 200, now: NOW }))).toEqual(["Hacc didn't answer in 5 s. It's read again within a minute."])
    // Words without their full stop get one.
    expect(texts(traderLines({ ...jup, traders: { at: NOW, data: null, failed: { at: NOW, words: "Hacc's answer had nothing to show" } } }, { width: 200, now: NOW }))).toEqual(["Hacc's answer had nothing to show. It's read again within a minute."])
  })
})

describe("Its signals", () => {
  test("newest first, in Signals' words, without the token column every row would repeat", () => {
    for (const width of [40, 70, 90]) {
      const lines = tokenSignalLines(young, { width, now: NOW })
      expect(lines).toHaveLength(young.signals!.data!.length)
      for (const l of lines) {
        expect(textOf(l)).not.toContain("SPARK")
        expect(textOf(l).length).toBeLessThanOrEqual(width)
      }
      // Each row is still a pick of its token, with Signals' question.
      expect(lines[0]!.pick).toMatchObject({ mint: YOUNG_MINT })
      expect(lines[0]!.pick!.ask).toStartWith("What do you make of SPARK? From Signals: first buy")
    }
    expect(textOf(tokenSignalLines(young, { width: 40, now: NOW })[0]!)).toStartWith("first buy")
  })

  test("none: said, in words", () => {
    expect(texts(tokenSignalLines({ ...jup, signals: { at: NOW, data: [] } }, { width: 200, now: NOW }))).toEqual(["No signals on Hacc's tape for JUPF: none of Hacc's tracked wallets has done anything with it that Hacc flags."])
  })

  test("one wallet saying the same thing in a row is one line with how many (30 rows of one wallet's book moves said one thing 30 times)", () => {
    const one = young.signals!.data![0] as Record<string, unknown>
    const at = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString()
    const same = Array.from({ length: 12 }, (_, i) => ({ ...one, id: 9000 + i, created_at: at(60 + i * 30) }))
    const lines = tokenSignalLines({ ...young, signals: { at: NOW, data: [...same.toReversed(), { ...one, id: 9100, pattern: "large_move", created_at: at(5) }] } }, { width: 70, now: NOW })
    expect(lines).toHaveLength(2)
    expect(textOf(lines[1]!)).toContain("×12")
    expect(textOf(lines[1]!)).toMatch(/ 1h /)
    expect(textOf(lines[1]!).length).toBeLessThanOrEqual(70)
    expect(textOf(lines[0]!)).not.toContain("×")
  })
})

describe("Mentions", () => {
  test("each post's author, following and age, its text under it as data; the question names no handle and no text", () => {
    const lines = mentionLines(jup, { width: 60, now: NOW })
    expect(textOf(lines[0]!)).toMatch(/^2 posts by 2 accounts Hacc follows since \d{4}-\d\d-\d\d:$/)
    expect(textOf(lines[1]!)).toMatch(/^@fake-handle-1 · \d+d · 541K$/)
    expect(textOf(lines[2]!)).toBe("  fake-text-1")
    expect(lines[2]!.segs[0]!.fg).toBe(C.dim)
    expect(lines[3]!.segs.map((s) => s.text).join("")).toContain("repost")
    const ask = lines[1]!.pick!.ask!
    expect(ask).toMatch(/^What do you make of the posts about JUPF on X\? From Research: 2 accounts Hacc follows posted, the latest \d+d ago\.$/)
    expect(ask).not.toContain("fake-handle")
    expect(ask).not.toContain("fake-text")
  })

  test("a long post is cut to three lines", () => {
    const long: ResearchView = { ...jup, mentions: { at: NOW, data: { rows: [{ handle: "h", at: NOW - 60_000, text: "word ".repeat(80), repost: false }] } } }
    const lines = texts(mentionLines(long, { width: 30, now: NOW }))
    expect(lines.filter((l) => l.startsWith("  word"))).toHaveLength(3)
    expect(lines.at(-1)).toBe("  …")
  })

  test("none, over the overview's span: a date a day back, else the last minutes", () => {
    expect(texts(mentionLines(young, { width: 200, now: NOW }))).toEqual([expect.stringMatching(/^No posts about SPARK by the accounts Hacc follows on X in the last \d+m\.$/)])
    expect(texts(mentionLines({ ...jup, mentions: { at: NOW, data: { rows: [], from: NOW - 3 * 86_400_000 } } }, { width: 200, now: NOW }))[0]).toMatch(/since \d{4}-\d\d-\d\d\.$/)
  })
})

describe("before any token", () => {
  test("each pane says what it will show, and how to get a token there", () => {
    for (const lines of [checkLines({ token: null }, { width: 60, now: NOW }), traderLines(undefined, { width: 60, now: NOW }), tokenSignalLines({ token: null }, { width: 60, now: NOW }), mentionLines({ token: null }, { width: 60, now: NOW })])
      expect(texts(lines).at(-1)).toBe("Pick a token in any list, or ask the agent about one.")
  })
})

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { buildNames, candleLabelProblem, lookupWallet, markedWords, nameProblem, pairsFile, planRenames, renameCommand, short, walletName } from "./wallet-names"

const A = "TeeA1111111111111111111111111111111111111111"
const B = "TeeB2222222222222222222222222222222222222222"
const EMB = "Embd3333333333333333333333333333333333333333"
const VK = "Vaul4444444444444444444444444444444444444444"
const LNK = "Link5555555555555555555555555555555555555555"

const book = (over: Partial<Parameters<typeof buildNames>[0]> = {}) =>
  buildNames({ embedded: [EMB], tee: [{ address: A, label: "hot" }, { address: B }], linked: [{ address: LNK, label: "ledger" }], vaultKeys: [{ address: VK, label: "cold" }], other: [], harness: {}, agents: ["agent-a", "agent-b"], ...over })

describe("Candle's label rule (validateLabel, cli/src/vault/labels.ts), case by case", () => {
  // The CLI's own cases: empty, whitespace only, a control character, a leading "-", edge whitespace, over 64.
  test.each([
    ["", "empty"],
    ["   ", "empty"],
    ["a\tb", "control"],
    ["a\nb", "control"],
    ["a\u007fb", "control"],
    ["-hot", '"-"'],
    [" hot", "space"],
    ["hot ", "space"],
    ["hot ", "space"],
    ["x".repeat(65), "64"],
  ])("refuses %j (%s)", (label, word) => {
    expect(candleLabelProblem(label)).toContain(word)
  })

  test("takes 64 UTF-16 code units, and counts by them, not characters, as Candle does", () => {
    expect(candleLabelProblem("x".repeat(64))).toBeUndefined()
    // 32 emoji are 64 code units: fine. 33 are 66: over, though only 33 characters.
    expect(candleLabelProblem("🔥".repeat(32))).toBeUndefined()
    expect(candleLabelProblem("🔥".repeat(33))).toContain("64")
  })

  test("never trims: a name inside spaces is refused, not cleaned", () => {
    expect(candleLabelProblem("hot wallet")).toBeUndefined()
    expect(candleLabelProblem(" hot wallet ")).toBeDefined()
  })
})

describe("the Candle Harness's rules on top", () => {
  const others = book()
  const check = (name: string, address = B) => nameProblem(name, { address, others, agents: ["agent-a"] })

  test("a name another wallet has is refused, any case", () => {
    expect(check("hot")).toContain("already names TeeA…1111")
    expect(check("HOT")).toContain("without case")
    expect(check("cold")).toContain("Vaul…4444")
    expect(check("Ledger")).toContain("Link…5555")
  })

  test("a wallet keeping its own name, or changing its case, isn't a clash with itself", () => {
    expect(check("hot", A)).toBeUndefined()
    expect(check("Hot", A)).toBeUndefined()
  })

  test("never embedded, an agent's name, an address or a short address", () => {
    expect(check("embedded")).toContain("embedded wallet")
    expect(check("Embedded")).toContain("embedded wallet")
    expect(check("Agent-A")).toContain("agent's name")
    expect(check(VK)).toContain("address")
    expect(check("0x1234567890abcdef1234567890abcdef12345678")).toContain("address")
    expect(check("TeeA…1111")).toContain("short address")
    expect(check("TeeA...1111")).toContain("short address")
  })

  test("no character the screen doesn't draw, so two names can't look alike", () => {
    expect(check("ho​t")).toContain("doesn't draw")
  })

  test("Candle's rule comes first, in Candle's words", () => {
    expect(check(" hot")).toContain("space")
  })

  test("names in a batch can swap: the others are the book as it will be", () => {
    const swapped = others.map((e) => (e.address === A ? { ...e, name: "cool" } : e))
    expect(nameProblem("hot", { address: B, others: swapped, agents: [] })).toBeUndefined()
  })
})

describe("the name book", () => {
  test("each wallet once, named where it's owned", () => {
    const names = book({ harness: { [EMB]: "main", [B]: "spare" } })
    const of = (a: string) => names.find((e) => e.address === a)!
    expect(of(A)).toMatchObject({ name: "hot", owner: "candle", kind: "tee" })
    expect(of(EMB)).toMatchObject({ name: "main", owner: "harness", kind: "embedded" })
    expect(of(VK)).toMatchObject({ name: "cold", owner: "vault" })
    expect(of(LNK)).toMatchObject({ name: "ledger", owner: "candle", kind: "linked" })
    // A TEE wallet Candle holds no label for: the Candle Harness's name stands in, and a rename still goes to Candle.
    expect(of(B)).toMatchObject({ name: "spare", owner: "candle" })
  })

  test("a Candle Harness name for a wallet Candle labels is left unused, and said", () => {
    const names = book({ harness: { [A]: "mine" } })
    expect(names.find((e) => e.address === A)).toMatchObject({ name: "hot", shadowed: "mine" })
  })

  test("a TEE wallet the vault also lists is the TEE wallet", () => {
    const names = book({ vaultKeys: [{ address: A, label: "hot-vault-entry" }] })
    expect(names.filter((e) => e.address === A)).toHaveLength(1)
    expect(names.find((e) => e.address === A)).toMatchObject({ kind: "tee", name: "hot" })
  })

  test("a Candle label that breaks the Candle Harness's rules is shown, marked, and taken by address only", () => {
    const names = book({ tee: [{ address: A, label: "embedded" }, { address: B, label: "twin" }], linked: [{ address: LNK, label: "Twin" }] })
    expect(names.find((e) => e.address === A)!.marked).toContain("embedded")
    expect(names.find((e) => e.address === B)!.marked).toContain("same name")
    expect(names.find((e) => e.address === LNK)!.marked).toContain("same name")
    expect(walletName(names, { address: A })).toBe("embedded")
    expect(lookupWallet(names, "twin")).toMatchObject({ kind: "marked" })
    expect(lookupWallet(names, B)).toMatchObject({ kind: "found", by: "address" })
    expect(markedWords("twin", (lookupWallet(names, "twin") as unknown as { entries: never[] }).entries)).toContain("more than one wallet")
  })

  test("a label shaped like an address is marked", () => {
    const names = book({ tee: [{ address: A, label: VK }] })
    expect(names.find((e) => e.address === A)!.marked).toContain("address")
  })

  test("lookups: the exact address first, then a name, any case", () => {
    const names = book({ harness: { [EMB]: "main" } })
    expect(lookupWallet(names, A)).toMatchObject({ kind: "found", by: "address" })
    expect(lookupWallet(names, "HOT")).toMatchObject({ kind: "found", by: "name", entry: { address: A } })
    expect(lookupWallet(names, "main")).toMatchObject({ kind: "found", entry: { address: EMB } })
    expect(lookupWallet(names, "nope")).toEqual({ kind: "none" })
  })

  test("what a wallet is called: its name, else embedded, else its short address", () => {
    const names = book()
    expect(walletName(names, { address: A })).toBe("hot")
    expect(walletName(names, { address: EMB })).toBe("embedded")
    expect(walletName(names, { address: B })).toBe("TeeB…2222")
    expect(walletName(undefined, { address: B, label: "given" })).toBe("given")
    expect(walletName(undefined, { address: B, kind: "tee" })).toBe(short(B))
  })

  test("the rename that fixes a name is the owner's command", () => {
    const names = book()
    expect(renameCommand(names.find((e) => e.address === A)!)).toBe(`candle tee rename ${A} <new name>`)
    expect(renameCommand(names.find((e) => e.address === VK)!)).toBe(`candle vault rename ${VK} <new name>`)
    expect(renameCommand(names.find((e) => e.address === EMB)!)).toBe(`name ${EMB} <new name>`)
  })
})

describe("a --pairs-from file, as the CLI's rerunFile writes one", () => {
  test("plain lines when every name survives that form", () => {
    expect(pairsFile([{ address: A, name: "hot" }, { address: B, name: "cool" }])).toBe(`${A} hot\n${B} cool\n`)
  })
  test("a from,to CSV, each name quoted, when one holds a space, a comma or a quote", () => {
    expect(pairsFile([{ address: A, name: 'my "hot" one' }, { address: B, name: "a,b" }])).toBe(`from,to\n${A},"my ""hot"" one"\n${B},"a,b"\n`)
  })
})

describe("one name, one short address (a test fails on a new copy)", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f)
      return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) ? [p] : []
    })
  const src = join(import.meta.dir, "..")

  test("no file shortens an address but wallet-names.ts", () => {
    const copies = files(src).filter((f) => !f.endsWith("wallet-names.ts") && /slice\(0, 4\)\}…\$\{[^}]*slice\(-4\)/.test(readFileSync(f, "utf8")))
    expect(copies).toEqual([])
  })

  test("no file names a wallet by its label or short address itself", () => {
    const copies = files(src).filter((f) => !f.endsWith("wallet-names.ts") && /\.label \?\? (short|shortAddress)\(/.test(readFileSync(f, "utf8")))
    expect(copies).toEqual([])
  })
})

describe("planning renames, checked whole first", () => {
  const names = book({ harness: { [EMB]: "main" } })
  const agents = ["agent-a"]

  test("split by where each name is kept, with what it was", () => {
    const r = planRenames([{ wallet: "hot", name: "fast" }, { wallet: "main", name: "home" }, { wallet: "cold", name: "deep" }, { wallet: "ledger", name: "hw" }], names, agents)
    expect(r).toMatchObject({ ok: true, unchanged: 0 })
    expect((r as { rows: unknown[] }).rows).toEqual([
      { address: A, kind: "tee", owner: "candle", name: "fast", was: "hot" },
      { address: EMB, kind: "embedded", owner: "harness", name: "home", was: "main" },
      { address: VK, kind: "vault-key", owner: "vault", name: "deep", was: "cold" },
      { address: LNK, kind: "linked", owner: "candle", name: "hw", was: "ledger" },
    ])
  })

  test("two names can swap in one go, as Candle's batch allows", () => {
    expect(planRenames([{ wallet: "hot", name: "cold" }, { wallet: "cold", name: "hot" }], names, agents)).toMatchObject({ ok: true })
  })

  test("two new names that clash, a wallet named twice, a name it already has, too many: refused whole", () => {
    expect(planRenames([{ wallet: "hot", name: "same" }, { wallet: "cold", name: "SAME" }], names, agents)).toMatchObject({ ok: false, code: "NAME_REFUSED" })
    expect(planRenames([{ wallet: "hot", name: "a" }, { wallet: A, name: "b" }], names, agents)).toMatchObject({ ok: false, code: "NAMED_TWICE" })
    expect(planRenames([{ wallet: "hot", name: "hot" }], names, agents)).toMatchObject({ ok: false, code: "UNCHANGED" })
    expect(planRenames(Array.from({ length: 257 }, (_, i) => ({ wallet: "hot", name: `n${i}` })), names, agents)).toMatchObject({ ok: false, code: "TOO_MANY" })
    expect(planRenames([], names, agents)).toMatchObject({ ok: false, code: "NAME_SOMETHING" })
  })

  test("a row that changes nothing is left out of a batch", () => {
    expect(planRenames([{ wallet: "hot", name: "hot" }, { wallet: "cold", name: "deep" }], names, agents)).toMatchObject({ ok: true, unchanged: 1, rows: [{ address: VK }] })
  })

  test("an unknown wallet, and a marked name, say why", () => {
    expect(planRenames([{ wallet: "nope", name: "x" }], names, agents)).toMatchObject({ ok: false, code: "UNKNOWN_WALLET" })
    expect((planRenames([{ wallet: "Dest6666666666666666666666666666666666666666", name: "x" }], names, agents) as { message: string }).message).toContain("vault list")
    const twins = book({ tee: [{ address: A, label: "twin" }, { address: B, label: "twin" }] })
    expect(planRenames([{ wallet: "twin", name: "x" }], twins, agents)).toMatchObject({ ok: false, code: "WALLET_AMBIGUOUS" })
    // By address, a marked wallet can be renamed: that's how it's fixed.
    expect(planRenames([{ wallet: A, name: "fixed" }], twins, agents)).toMatchObject({ ok: true })
  })

  test("embedded always names the embedded wallet", () => {
    expect(planRenames([{ wallet: "embedded", name: "main2" }], names, agents)).toMatchObject({ ok: true, rows: [{ address: EMB }] })
  })
})

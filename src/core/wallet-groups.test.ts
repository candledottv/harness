import { describe, expect, test } from "bun:test"
import { groupLookup, groupNameProblem, planGroupChange, prefixProblem, resolveGroups } from "./wallet-groups"
import { buildNames } from "./wallet-names"

const pad = (s: string) => s.padEnd(44, "1")
const EMB = pad("Embd")
const bot = (i: number) => pad(`Bot${i}z`)
const names = buildNames({
  embedded: [EMB],
  tee: [
    ...Array.from({ length: 12 }, (_, i) => ({ address: bot(i + 1), label: `bot-${String(i + 1).padStart(2, "0")}` })),
    { address: pad("Swing"), label: "swing-a" },
    { address: pad("Alpha"), label: "Alpha" },
    { address: pad("Dup1"), label: "twin" },
    { address: pad("Dup2"), label: "twin" },
  ],
  linked: [],
  vaultKeys: [],
  other: [],
  harness: { [EMB]: "main" },
  agents: ["agent-a"],
})
const agents = ["agent-a"]

describe("a group's name and prefix", () => {
  test("a group's name is a short word: letters, digits, '.', '_' and '-', starting with a letter or digit", () => {
    expect(groupNameProblem("bots")).toBeUndefined()
    expect(groupNameProblem("lp.v2_x-1")).toBeUndefined()
    expect(groupNameProblem("")).toContain("a name")
    expect(groupNameProblem("my bots")).toContain("letters, digits")
    expect(groupNameProblem("-bots")).toContain("start")
    expect(groupNameProblem("x".repeat(33))).toContain("32")
  })

  test("a prefix follows Candle's label rule, and a trailing * (Candle's own way of writing it) is taken off", () => {
    expect(prefixProblem("bot-")).toBeUndefined()
    expect(prefixProblem("bot-*")).toBeUndefined()
    expect(prefixProblem("")).toContain("empty")
    expect(prefixProblem("*")).toContain("empty")
    expect(prefixProblem(" bot")).toContain("space")
    expect(prefixProblem("a*b")).toContain("*")
  })

  test("a prefix with a character the screen doesn't draw is refused, a lone surrogate among them", () => {
    expect(prefixProblem(JSON.parse('"bot\\ud800"'))).toContain("doesn't draw")
    expect(prefixProblem("bot\u200b")).toContain("doesn't draw")
  })
})

describe("resolving groups against the name book", () => {
  test("a prefix takes in every wallet whose name starts with it, without case, and a list by address or name", () => {
    const groups = resolveGroups({ bots: { prefix: "BOT-1" }, swing: { wallets: ["swing-a", pad("Alpha")] } }, names, agents)
    const bots = groups.find((g) => g.name === "bots")!
    // bot-10, bot-11, bot-12: the book's order.
    expect(bots.members).toEqual([bot(10), bot(11), bot(12)])
    expect(bots.prefix).toBe("BOT-1")
    expect(groups.find((g) => g.name === "swing")!.members).toEqual([pad("Swing"), pad("Alpha")])
  })

  test("a wallet a list names that the Candle Harness doesn't know is kept and named, never dropped silently", () => {
    const [g] = resolveGroups({ swing: { wallets: ["swing-a", "swing-z", pad("Nope")] } }, names, agents)
    expect(g!.members).toEqual([pad("Swing")])
    expect(g!.unknown).toEqual(["swing-z", pad("Nope")])
  })

  test("a list naming a name two wallets share takes neither, and says so", () => {
    const [g] = resolveGroups({ pair: { wallets: ["twin"] } }, names, agents)
    expect(g!.members).toEqual([])
    expect(g!.unknown).toEqual(["twin"])
  })

  test("a prefix and a list together, and a wallet in several groups, each counted once in a group", () => {
    const groups = resolveGroups({ a: { prefix: "bot-0", wallets: ["bot-01", "bot-10"] }, b: { wallets: ["bot-01"] } }, names, agents)
    expect(groups[0]!.members).toEqual([...Array.from({ length: 9 }, (_, i) => bot(i + 1)), bot(10)])
    expect(groups[1]!.members).toEqual([bot(1)])
  })

  test("a group whose name is a wallet's, an agent's, `embedded` or `all` is marked, since `from` and the chips read those words", () => {
    const groups = resolveGroups({ main: { prefix: "x" }, "agent-a": { prefix: "x" }, ALL: { prefix: "x" }, embedded: { prefix: "x" }, fine: { prefix: "x" } }, names, agents)
    expect(groups.map((g) => [g.name, g.marked !== undefined])).toEqual([
      ["agent-a", true],
      ["ALL", true],
      ["embedded", true],
      ["fine", false],
      ["main", true],
    ])
    expect(groups.find((g) => g.name === "main")!.marked).toContain("a wallet is called main")
  })

  test("groups come in name order, and are found by name without case", () => {
    const groups = resolveGroups({ snipers: { prefix: "s" }, bots: { prefix: "b" } }, names, agents)
    expect(groups.map((g) => g.name)).toEqual(["bots", "snipers"])
    expect(groupLookup(groups, "BOTS")?.name).toBe("bots")
    expect(groupLookup(groups, "nope")).toBeUndefined()
  })
})

describe("changing a group", () => {
  const defs = { bots: { prefix: "bot-" }, swing: { wallets: [pad("Swing")] } }

  test("adding makes the group if it's new, and keeps each wallet by address, so a rename never drops it", () => {
    const r = planGroupChange({ op: "add", group: "keep", wallets: ["bot-03", "Alpha"] }, defs, names, agents)
    expect(r).toMatchObject({ ok: true, group: "keep", next: { wallets: [bot(3), pad("Alpha")] } })
    expect(r.ok && r.was).toBeUndefined()
    expect(r.ok && r.words).toBe("made the group keep with bot-03 and Alpha")
  })

  test("adding to a group that has the wallet already, or by its prefix, changes nothing and says so", () => {
    expect(planGroupChange({ op: "add", group: "swing", wallets: ["swing-a"] }, defs, names, agents)).toMatchObject({ ok: false, code: "UNCHANGED" })
    const r = planGroupChange({ op: "add", group: "bots", wallets: ["bot-02"] }, defs, names, agents)
    expect(r).toMatchObject({ ok: false, code: "UNCHANGED" })
    expect(!r.ok && r.message).toContain("by its name's start (bot-)")
  })

  test("a wallet that isn't known, or a name two share, refuses the change before anything is written", () => {
    expect(planGroupChange({ op: "add", group: "swing", wallets: ["nope"] }, defs, names, agents)).toMatchObject({ ok: false, code: "UNKNOWN_WALLET" })
    expect(planGroupChange({ op: "add", group: "swing", wallets: ["twin"] }, defs, names, agents)).toMatchObject({ ok: false, code: "WALLET_AMBIGUOUS" })
  })

  test("removing a listed wallet; one in by its prefix can't be taken out by hand, and the words say why", () => {
    const r = planGroupChange({ op: "remove", group: "swing", wallets: ["swing-a"] }, { ...defs, swing: { wallets: [pad("Swing"), pad("Alpha")] } }, names, agents)
    expect(r).toMatchObject({ ok: true, next: { wallets: [pad("Alpha")] }, was: { wallets: [pad("Swing"), pad("Alpha")] } })
    const p = planGroupChange({ op: "remove", group: "bots", wallets: ["bot-04"] }, defs, names, agents)
    expect(p).toMatchObject({ ok: false, code: "IN_BY_PREFIX" })
    expect(!p.ok && p.message).toContain("rename it, or change the group's prefix")
  })

  test("a group left with no prefix and no wallets is gone", () => {
    expect(planGroupChange({ op: "remove", group: "swing", wallets: ["swing-a"] }, defs, names, agents)).toMatchObject({ ok: true, next: undefined, words: "took swing-a out of swing, which leaves it empty, so the group is gone" })
    expect(planGroupChange({ op: "prefix", group: "bots", prefix: null }, defs, names, agents)).toMatchObject({ ok: true, next: undefined })
  })

  test("setting a prefix takes off Candle's *, and says how many wallets it takes in", () => {
    const r = planGroupChange({ op: "prefix", group: "tens", prefix: "bot-1*" }, defs, names, agents)
    expect(r).toMatchObject({ ok: true, next: { prefix: "bot-1" }, words: "made the group tens: every wallet whose name starts bot-1 (3 now)" })
  })

  test("deleting a group, and one that doesn't exist", () => {
    expect(planGroupChange({ op: "delete", group: "BOTS" }, defs, names, agents)).toMatchObject({ ok: true, group: "bots", next: undefined, was: { prefix: "bot-" } })
    expect(planGroupChange({ op: "delete", group: "nope" }, defs, names, agents)).toMatchObject({ ok: false, code: "UNKNOWN_GROUP" })
  })

  test("a new group's name is checked: the static rule, then not a wallet's, an agent's, `embedded` or `all`", () => {
    expect(planGroupChange({ op: "add", group: "my bots", wallets: ["bot-01"] }, defs, names, agents)).toMatchObject({ ok: false, code: "GROUP_NAME_REFUSED" })
    const r = planGroupChange({ op: "add", group: "Main", wallets: ["bot-01"] }, defs, names, agents)
    expect(r).toMatchObject({ ok: false, code: "GROUP_NAME_REFUSED" })
    expect(!r.ok && r.message).toContain("a wallet is called main")
    expect(planGroupChange({ op: "add", group: "all", wallets: ["bot-01"] }, defs, names, agents)).toMatchObject({ ok: false, code: "GROUP_NAME_REFUSED" })
  })
})

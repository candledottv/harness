import { describe, expect, test } from "bun:test"
import type { WalletsTopic } from "../core/agent-wallets"
import { parseAliases } from "./aliases"
import { HELP_LINES } from "../view/keymap"
import { type CommandContext, parseCommand } from "./commands"

const MOON = "MoonFake11111111111111111111111111111111111"
const PEPE = "PepeFake11111111111111111111111111111111111"
const ctx: CommandContext = { agents: ["momentum", "swing"], knownTokens: new Map([["MOON", MOON]]) }
const parse = (line: string) => parseCommand(line, ctx)

test("buy with an asset, by name or by mint", () => {
  expect(parse("buy 0.1 sol MOON")).toEqual({ kind: "trade", tool: "candle_trade", args: { mint: MOON, side: "buy", amount: "0.1", quoteAsset: "sol" }, echo: "buy 0.1 sol MOON" })
  expect(parse("buy 2 USDC moon")).toMatchObject({ args: { amount: "2", quoteAsset: "usdc" } })
  expect(parse(`buy .5 cndl ${PEPE}`)).toMatchObject({ args: { mint: PEPE, amount: ".5", quoteAsset: "cndl" } })
  expect(parse("buy 0.1 sol $MOON")).toMatchObject({ args: { mint: MOON } })
})

test("buy in dollars sends amountUsd", () => {
  expect(parse("buy $25 MOON")).toMatchObject({ kind: "trade", args: { mint: MOON, side: "buy", amountUsd: "25" } })
  expect(parse("buy $12.50 MOON")).toMatchObject({ args: { amountUsd: "12.50" } })
})

test("sell an amount or a percent", () => {
  expect(parse("sell 50% MOON")).toMatchObject({ kind: "trade", args: { mint: MOON, side: "sell", percent: 50 } })
  expect(parse("sell 1000 MOON")).toMatchObject({ args: { side: "sell", amount: "1000" } })
  expect(parse("sell 150% MOON")).toEqual({ kind: "refused", message: "Sell a percent from 1% to 100%." })
})

test("swap between base assets", () => {
  expect(parse("swap 0.1 SOL USDC")).toEqual({ kind: "trade", tool: "candle_swap", args: { from: "SOL", to: "USDC", amount: "0.1" }, echo: "swap 0.1 SOL USDC" })
  expect(parse("swap 0.1 sol sol")).toEqual({ kind: "refused", message: "A swap needs two different assets." })
})

test("`as <agent>` uses that agent; an unknown one is refused, never run as the active agent", () => {
  expect(parse("buy 0.1 sol MOON as swing")).toMatchObject({ kind: "trade", agent: "swing", args: { mint: MOON } })
  expect(parse("sell 50% MOON as momentum")).toMatchObject({ agent: "momentum" })
  expect(parse("buy 0.1 sol MOON as ghost")).toEqual({ kind: "refused", message: "No agent named ghost. Agents: momentum, swing." })
})

test("near misses go to the agent whole, never as a half-parsed trade", () => {
  for (const line of ["buy moon", "buy some MOON", "sell MOON", "sell half MOON", "buy -1 sol MOON", "swap SOL for USDC"]) {
    expect(parse(line)).toEqual({ kind: "agent", text: line })
  }
})

test("a line shaped like a trade that can't run says why, keeps the line, and sends nothing", () => {
  const why = (line: string) => {
    const c = parse(line)
    expect(c).toMatchObject({ kind: "refused", keepLine: true })
    return (c as { message: string }).message
  }
  expect(why("buy 0.1 MOON")).toContain("say what pays")
  expect(why("buy 0.1 eth MOON")).toContain("buy it with SOL, USDC or CNDL")
  expect(why("buy 0.1 sol")).toContain("say what pays")
  expect(why("buy $12.505 MOON")).toContain("two decimals")
  expect(why("sell 50%")).toContain("sell a percent or an amount of one token")
  expect(why("swap 0.1 SOL MOON")).toContain("A token is bought or sold")
})

test("a trade-shaped line that goes on as a sentence is for the agent; commands are exact", () => {
  for (const line of [
    "Buy $1 of JUP (mint JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN), then sell all of it once the buy has filled.",
    "buy $1 of MOON, then sell it",
    "sell 50% of MOON and tell me what's left",
    "buy $5 MOON?",
    "Buy $1 of MOON. Then sell it once it fills.",
    "buy 0.1 sol of MOON if it's still under a dollar",
  ]) expect(parse(line)).toEqual({ kind: "agent", text: line })
  // Short misses are still said, not sent: a number's comma isn't a clause.
  expect(parse("sell 100% WOOF")).toMatchObject({ kind: "refused", keepLine: true })
  expect(parse("buy $1,000 MOON")).toMatchObject({ kind: "refused", keepLine: true })
  expect(parse("buy 0.1 MOON")).toMatchObject({ kind: "refused", keepLine: true })
})

test("a token name nobody has shown says so, and sends nothing", () => {
  for (const line of ["buy 0.1 sol WOOF", "buy $1 WOOF", "sell 50% WOOF", "sell 100 WOOF"]) {
    expect(parse(line)).toEqual({ kind: "refused", message: "Not a trade yet: WOOF isn't a token this session has shown, and a name can match many tokens. Paste its mint, or ask the agent to find it.", keepLine: true, ask: true })
  }
})

test("`of` before the token reads as typed (sell 50% of RIFT had gone to the agent)", () => {
  expect(parse("sell 50% of MOON")).toMatchObject({ kind: "trade", args: { mint: MOON, side: "sell", percent: 50 } })
  expect(parse("buy $25 of MOON")).toMatchObject({ kind: "trade", args: { mint: MOON, amountUsd: "25" } })
  expect(parse("buy 0.1 sol of MOON as swing")).toMatchObject({ kind: "trade", agent: "swing", args: { mint: MOON, quoteAsset: "sol" } })
})

test("a sentence's full stop isn't part of the token (Buy $1 of ORE. was refused as ORE.)", () => {
  expect(parse("Buy $1 of MOON.")).toMatchObject({ kind: "trade", args: { mint: MOON, amountUsd: "1" } })
  expect(parse("sell 50% MOON!")).toMatchObject({ kind: "trade", args: { mint: MOON, percent: 50 } })
  expect(parse("buy $1 WOOF.")).toEqual({ kind: "refused", message: "Not a trade yet: WOOF isn't a token this session has shown, and a name can match many tokens. Paste its mint, or ask the agent to find it.", keepLine: true, ask: true })
})

test("the one-word commands", () => {
  expect(parse("paper")).toEqual({ kind: "mode", mode: "paper" })
  expect(parse("LIVE")).toEqual({ kind: "mode", mode: "live" })
  expect(parse("kill")).toEqual({ kind: "kill" })
  expect(parse("resume")).toEqual({ kind: "resume" })
  expect(parse("resend")).toEqual({ kind: "resolve", action: "resend" })
  expect(parse("Abandon")).toEqual({ kind: "resolve", action: "abandon" })
  expect(parse("help")).toEqual({ kind: "help" })
  expect(parse("agent swing")).toEqual({ kind: "setAgent", agent: "swing" })
  expect(parse("agent ghost")).toMatchObject({ kind: "refused" })
  // In a sentence, they're English.
  expect(parse("kill the MOON position")).toEqual({ kind: "agent", text: "kill the MOON position" })
})

test("candle commands go to cli.run; candle swap points to swap … from <wallet>", () => {
  expect(parse("candle keys list")).toEqual({ kind: "cli", argv: ["keys", "list"] })
  expect(parse("candle portfolio as swing")).toEqual({ kind: "cli", argv: ["portfolio"], agent: "swing" })
  const swap = parse("candle swap SOL USDC --amount 0.1")
  expect(swap).toMatchObject({ kind: "refused" })
  expect((swap as { message: string }).message).toContain("swap 0.1 SOL USDC")
  expect((swap as { message: string }).message).toContain("from <wallet>")
})

describe("from <wallet>", () => {
  const TEE = "TeeFakeA11111111111111111111111111111111111"
  const OTHER = "TeeFakeB11111111111111111111111111111111111"
  const EMBEDDED = "WalletFake111111111111111111111111111111111"
  const teeA = { id: "teeA", address: TEE, label: "tee-one", chain: "solana" as const, active: true }
  const teeB = { id: "teeB", address: OTHER, label: "swing-tee", chain: "solana" as const, active: true }
  const topic = (over: { tier?: string; teeA?: Partial<typeof teeA>; embeddedWallet?: "allowed" | "denied" } = {}): WalletsTopic => {
    const a = { ...teeA, ...over.teeA }
    const payable = (tee: (typeof teeA)[]) => ({
      ...(over.embeddedWallet !== "denied" ? { embedded: { address: EMBEDDED, chain: "solana" as const } } : {}),
      tee,
      readAt: 0,
      unreadable: [],
      ...(over.tier ? { tier: over.tier } : {}),
    })
    return {
      agents: {
        momentum: { payable: payable([a]), embeddedWallet: over.embeddedWallet ?? "allowed", prefix: "momeAb3d" },
        swing: { payable: payable([teeB]), embeddedWallet: "allowed", prefix: "swinAb3d" },
      },
      account: [a, teeB],
      boundTo: { [TEE]: "momentum", [OTHER]: "swing" },
    }
  }
  const live = (over: Parameters<typeof topic>[0] = {}): CommandContext => ({ ...ctx, activeAgent: "momentum", mode: "live", wallets: topic(over) })
  const at = (line: string, c: CommandContext = live()) => parseCommand(line, c)

  test("by label, address, id or embedded: the trade names the address the core hashes, or embedded", () => {
    expect(at("buy 0.1 sol MOON from tee-one")).toEqual({ kind: "trade", tool: "candle_trade", args: { mint: MOON, side: "buy", amount: "0.1", quoteAsset: "sol", wallet: TEE }, echo: "buy 0.1 sol MOON from tee-one" })
    expect(at(`sell 50% MOON from ${TEE}`)).toMatchObject({ args: { side: "sell", percent: 50, wallet: TEE } })
    expect(at("sell 50% of MOON from teeA")).toMatchObject({ args: { percent: 50, wallet: TEE } })
    expect(at("swap 0.5 usdc sol from TEE-ONE")).toMatchObject({ tool: "candle_swap", args: { from: "USDC", to: "SOL", amount: "0.5", wallet: TEE } })
    expect(at("buy $25 MOON from embedded")).toMatchObject({ args: { amountUsd: "25", wallet: "embedded" } })
    expect(at(`buy $25 MOON from ${EMBEDDED}`)).toMatchObject({ args: { wallet: "embedded" } })
  })

  test("`as` and `from` in either order, each resolved for that agent", () => {
    expect(at("buy 0.1 sol MOON from swing-tee as swing")).toMatchObject({ kind: "trade", agent: "swing", args: { wallet: OTHER } })
    expect(at("buy 0.1 sol MOON as swing from swing-tee")).toMatchObject({ kind: "trade", agent: "swing", args: { wallet: OTHER } })
    expect(at("buy 0.1 sol MOON as ghost from tee-one")).toEqual({ kind: "refused", message: "No agent named ghost. Agents: momentum, swing." })
  })

  test("a wallet the agent can't pay from says why in the core's words, keeps the line, and sends nothing", () => {
    expect(at("buy 0.1 sol MOON from ghost")).toEqual({ kind: "refused", message: "Not a trade yet: momentum can't pay from ghost. It can pay from: embedded, tee-one.", keepLine: true })
    expect(at("buy 0.1 sol MOON from swing-tee")).toEqual({ kind: "refused", message: "Not a trade yet: momentum can't pay from swing-tee: it's bound to swing's key, and a TEE wallet is bound to one key only. It can pay from: embedded, tee-one.", keepLine: true })
    const why = (line: string, c: CommandContext) => (at(line, c) as { message: string }).message
    expect(why("buy 0.1 sol MOON from tee-one", live({ tier: "free" }))).toContain("TEE wallets are a Pro or Max feature: this account is on Free")
    expect(why("buy 0.1 sol MOON from tee-one", live({ teeA: { active: false } }))).toContain("stopped on Candle's side (inactive)")
    expect(why("buy 0.1 sol MOON from embedded", live({ embeddedWallet: "denied" }))).toContain("candle keys update momeAb3d --embedded-wallet allow")
    // Before the core has said what the agent can pay from.
    expect(at("buy 0.1 sol MOON from tee-one", { ...ctx, activeAgent: "momentum", mode: "live" })).toEqual({ kind: "refused", message: "Not a trade yet: momentum's wallets haven't been read from Candle yet. Try again in a moment.", keepLine: true })
  })

  test("in paper mode a TEE wallet has no paper form; embedded is the paper book, read or not", () => {
    const paper = (over: Parameters<typeof topic>[0] = {}): CommandContext => ({ ...live(over), mode: "paper" })
    expect(at("buy 0.1 sol MOON from tee-one", paper())).toEqual({
      kind: "refused",
      message: 'Not a trade yet: tee-one is a TEE wallet, and TEE wallets have no paper form. Switch to live to pay from it, or leave out "from tee-one".',
      keepLine: true,
    })
    expect(at("buy 0.1 sol MOON from tee-one", paper({ tier: "free" }))).toMatchObject({ message: expect.stringContaining("no paper form") })
    expect(at("buy 0.1 sol MOON from ghost", paper())).toMatchObject({ message: expect.stringContaining("momentum can't pay from ghost") })
    expect(at("buy 0.1 sol MOON from embedded", { ...ctx, mode: "paper" })).toMatchObject({ kind: "trade", args: { wallet: "embedded" } })
  })

  test("in paper mode either embedded address is the embedded wallet, whichever chain the token is on", () => {
    const evm = "0x" + "a1".repeat(20)
    const hoodMint = "0x" + "b2".repeat(20)
    const t = topic()
    const paper: CommandContext = { ...ctx, activeAgent: "momentum", mode: "paper", wallets: { ...t, agents: { ...t.agents, momentum: { ...t.agents.momentum!, evm } } } }
    expect(at(`buy $25 ${hoodMint} from ${EMBEDDED}`, paper)).toMatchObject({ kind: "trade", args: { wallet: "embedded" } })
    expect(at(`buy 0.1 sol MOON from ${evm}`, paper)).toMatchObject({ kind: "trade", args: { wallet: "embedded" } })
  })

  test("a swap on Hood from a Hood TEE wallet pays from it, both ways; a Solana swap can't name it", () => {
    const HOOD_TEE = "0x" + "c3".repeat(20)
    const hoodTee = { id: "teeH", address: HOOD_TEE, label: "bot-1-h", chain: "hood" as const, active: true }
    const t = topic()
    const withHood: CommandContext = {
      ...live(),
      wallets: { ...t, agents: { ...t.agents, momentum: { ...t.agents.momentum!, payable: { ...t.agents.momentum!.payable, tee: [...t.agents.momentum!.payable.tee, hoodTee] } } }, account: [...t.account, hoodTee], boundTo: { ...t.boundTo, [HOOD_TEE]: "momentum" } },
    }
    expect(at("swap 0.01 eth usdg from bot-1-h", withHood)).toMatchObject({ kind: "trade", tool: "candle_swap", args: { from: "ETH", to: "USDG", amount: "0.01", wallet: HOOD_TEE } })
    expect(at("swap 5 usdg eth from bot-1-h", withHood)).toMatchObject({ kind: "trade", tool: "candle_swap", args: { from: "USDG", to: "ETH", amount: "5", wallet: HOOD_TEE } })
    expect(at("swap 0.5 usdc sol from bot-1-h", withHood)).toMatchObject({ kind: "refused", message: expect.stringContaining("bot-1-h is a Hood wallet") })
  })

  test("a trade's own mistake comes first; a line that isn't trade-shaped still goes to the agent whole", () => {
    expect(at("buy 0.1 MOON from tee-one")).toMatchObject({ kind: "refused", message: expect.stringContaining("say what pays") })
    expect(at("buy moon from tee-one")).toEqual({ kind: "agent", text: "buy moon from tee-one" })
    expect(at("sell from tee-one")).toEqual({ kind: "agent", text: "sell from tee-one" })
  })
})

test("anything else is plain English, and an empty line is nothing", () => {
  expect(parse("what's trending?")).toEqual({ kind: "agent", text: "what's trending?" })
  expect(parse("   ")).toBeUndefined()
})

test("help lists from <wallet>, by any wallet's name, and naming one", () => {
  expect(HELP_LINES.some((l) => l.startsWith("… from <wallet>") && l.includes("name or address"))).toBe(true)
  expect(HELP_LINES.some((l) => l.startsWith("name <wallet> <name>"))).toBe(true)
})

// Aliases and chains.
const BONK = "BonkFake11111111111111111111111111111111111"
const withAliases = (body: string): CommandContext => ({ ...ctx, knownTokens: new Map([["MOON", MOON], ["BONK", BONK]]), activeAgent: "momentum", aliases: parseAliases(`[aliases]\n${body}`).map })

test("a chain's parts are parsed whole: two trades, each as typed", () => {
  const c = withAliases("")
  const chain = parseCommand("buy $1 of MOON; sell 100% of MOON", c)
  expect(chain).toEqual({
    kind: "chain",
    echo: "buy $1 of MOON; sell 100% of MOON",
    parts: [
      { text: "buy $1 of MOON", command: { kind: "trade", tool: "candle_trade", args: { mint: MOON, side: "buy", amountUsd: "1" }, echo: "buy $1 of MOON" } },
      { text: "sell 100% of MOON", command: { kind: "trade", tool: "candle_trade", args: { mint: MOON, side: "sell", percent: 100 }, echo: "sell 100% of MOON" } },
    ],
  })
  // `as` and candle commands work in a part.
  const mixed = parseCommand("candle keys list; sell 50% BONK as swing", c)
  expect(mixed?.kind === "chain" && mixed.parts.map((p) => p.command)).toEqual([
    { kind: "cli", argv: ["keys", "list"] },
    { kind: "trade", tool: "candle_trade", args: { mint: BONK, side: "sell", percent: 50 }, agent: "swing", echo: "sell 50% BONK as swing" },
  ])
})

test("a line is a chain only when its first part is a command: English with a semicolon goes to the agent whole", () => {
  const c = withAliases("")
  expect(parseCommand("what moved today; anything on MOON?", c)).toEqual({ kind: "agent", text: "what moved today; anything on MOON?" })
  // A trailing semicolon is just the command.
  expect(parseCommand("sell 50% MOON;", c)).toMatchObject({ kind: "trade", args: { percent: 50 } })
})

test("a refused part refuses the whole line with its number and why, and keeps it", () => {
  const c = withAliases("")
  expect(parseCommand("buy $1 of MOON; buy $1 of WOOF", c)).toEqual({ kind: "refused", keepLine: true, message: expect.stringMatching(/^Part 2 of 2: Not a trade yet: WOOF isn't a token this session has shown.* Nothing was sent\.$/) })
  expect(parseCommand("buy $1 of MOON; then tell me how it went", c)).toMatchObject({ kind: "refused", keepLine: true, message: expect.stringContaining("Part 2 of 2 isn't a command (\"then tell me how it went\")") })
  expect(parseCommand("buy $1 of MOON; kill", c)).toMatchObject({ kind: "refused", message: 'Part 2 of 2: "kill" runs on its own, not in a chain. Nothing was sent.' })
  expect(parseCommand("paper; buy $1 of MOON", c)).toMatchObject({ kind: "refused", message: expect.stringContaining("Part 1 of 2") })
  expect(parseCommand("buy $1 of WOOF; sell 50% MOON", c)).toMatchObject({ kind: "refused", message: expect.stringContaining("Part 1 of 2: Not a trade yet: WOOF") })
})

test("at most 5 parts", () => {
  const c = withAliases("")
  expect(parseCommand(Array(5).fill("sell 1% MOON").join("; "), c)).toMatchObject({ kind: "chain" })
  expect(parseCommand(Array(6).fill("sell 1% MOON").join("; "), c)).toEqual({ kind: "refused", keepLine: true, message: "A chain runs at most 5 parts, and this has 6. Nothing was sent." })
})

test("an alias's line is parsed as typed: a trade, a chain, or English for the agent", () => {
  const c = withAliases(`b1 = "buy $1 of"\nflip = "buy $1 of MOON; sell 100% of MOON"\ngm = "good morning, what's moving?"\nbuy = "sell 100% of"`)
  expect(parseCommand("b1 MOON", c)).toMatchObject({ kind: "trade", args: { mint: MOON, side: "buy", amountUsd: "1" }, echo: "buy $1 of MOON" })
  expect(parseCommand("flip", c)).toMatchObject({ kind: "chain", parts: [{ text: "buy $1 of MOON" }, { text: "sell 100% of MOON" }] })
  expect(parseCommand("b1 MOON; b1 BONK", c)).toMatchObject({ kind: "chain", parts: [{ command: { args: { mint: MOON } } }, { command: { args: { mint: BONK } } }] })
  expect(parseCommand("gm", c)).toEqual({ kind: "agent", text: "good morning, what's moving?" })
  // An alias can't shadow buy: config.toml's `buy` is left out, so buy is still buy.
  expect(parseCommand("buy $1 of MOON", c)).toMatchObject({ kind: "trade", args: { side: "buy" } })
  // An alias's part still can't run what a typed line couldn't.
  expect(parseCommand("b1 WOOF", c)).toMatchObject({ kind: "refused", message: expect.stringContaining("WOOF isn't a token") })
})

describe("name <wallet> <new name>", () => {
  const EMB = "Embd3333333333333333333333333333333333333333"
  const TEE = "TeeA1111111111111111111111111111111111111111"
  const wallets = {
    agents: {},
    account: [],
    boundTo: {},
    names: [
      { address: EMB, kind: "embedded", owner: "harness" },
      { address: TEE, kind: "tee", owner: "candle", name: "my hot one" },
    ],
  } as unknown as WalletsTopic
  const named = (line: string) => parseCommand(line, { ...ctx, wallets })

  test("the wallet by name (several words too), embedded or address, then the new name as typed", () => {
    expect(named("name embedded main")).toEqual({ kind: "name", wallet: "embedded", name: "main" })
    expect(named("name my hot one fast lane")).toEqual({ kind: "name", wallet: "my hot one", name: "fast lane" })
    expect(named('name "my hot one" fast')).toEqual({ kind: "name", wallet: "my hot one", name: "fast" })
    expect(named(`name ${TEE} desk`)).toEqual({ kind: "name", wallet: TEE, name: "desk" })
    // An address the Candle Harness doesn't know is still a command: the core says why.
    expect(named("name Dest6666666666666666666666666666666666666666 exchange")).toMatchObject({ kind: "name" })
  })

  test("prose that starts with name is for the agent", () => {
    expect(named("name the wallet you'd pay from")).toEqual({ kind: "agent", text: "name the wallet you'd pay from" })
    expect(named("name")).toMatchObject({ kind: "agent" })
  })
})

describe("forget vault", () => {
  test("exactly the two words, in any case, are the person's step; anything longer is for the agent, and it never chains", () => {
    expect(parseCommand("forget vault", ctx)).toEqual({ kind: "forgetVault" })
    expect(parseCommand("Forget Vault", ctx)).toEqual({ kind: "forgetVault" })
    expect(parseCommand("forget vault please", ctx)).toMatchObject({ kind: "agent" })
    expect(parseCommand("forget the vault", ctx)).toMatchObject({ kind: "agent" })
    expect(parseCommand("candle keys list; forget vault", ctx)).toMatchObject({ kind: "refused" })
  })
})

describe("typed buys on Hood", () => {
  const HTOK = "0x00000000000000000000000000000000000b0B01"
  const hood: CommandContext = { ...ctx, knownTokens: new Map([["MOON", MOON], ["HTOK", HTOK]]) }
  const at = (line: string) => parseCommand(line, hood)

  test("eth and usdg pay for a Hood token; a dollar buy names no asset, and pays in the token's own", () => {
    expect(at("buy 0.01 eth HTOK")).toEqual({ kind: "trade", tool: "candle_trade", args: { mint: HTOK, side: "buy", amount: "0.01", quoteAsset: "eth" }, echo: "buy 0.01 eth HTOK" })
    expect(at("buy 5 USDG HTOK")).toMatchObject({ kind: "trade", args: { mint: HTOK, amount: "5", quoteAsset: "usdg" } })
    expect(at(`buy 0.01 eth ${HTOK.toLowerCase()}`)).toMatchObject({ kind: "trade", args: { mint: HTOK.toLowerCase(), quoteAsset: "eth" } })
    expect(at("buy $5 HTOK")).toEqual({ kind: "trade", tool: "candle_trade", args: { mint: HTOK, side: "buy", amountUsd: "5" }, echo: "buy $5 HTOK" })
  })

  test("what pays must be the token's chain's, both ways, said with what would", () => {
    expect(at("buy 0.1 sol HTOK")).toEqual({ kind: "refused", message: "SOL pays for a token on Solana, and HTOK is on Hood: buy it with ETH or USDG. Nothing was sent.", keepLine: true })
    expect(at("buy 0.01 eth MOON")).toEqual({ kind: "refused", message: "ETH pays for a token on Hood, and MOON is on Solana: buy it with SOL, USDC or CNDL. Nothing was sent.", keepLine: true })
    expect(at("buy 5 usdg MOON")).toMatchObject({ kind: "refused", message: expect.stringContaining("buy it with SOL, USDC or CNDL") })
  })

  test("an asset no chain pays with is no trade, naming each chain's", () => {
    const r = at("buy 1 doge HTOK") as { kind: string; message: string }
    expect(r.message).toContain("SOL, USDC or CNDL for a token on Solana, ETH or USDG for a token on Hood")
  })
})

test("a name the view saw on two chains isn't traded: the line names each, and keeps what was typed", () => {
  const HOOD_MOON = "0x00000000000000000000000000000000000b0B01"
  const both: CommandContext = { ...ctx, knownTokens: new Map(), onTwoChains: new Map([["MOON", [{ chain: "Solana", mint: MOON }, { chain: "Hood", mint: HOOD_MOON }]]]) }
  // The pick says which of the line's words is the token's, for the picked address to take its place.
  for (const [line, at] of [["buy 0.1 sol MOON", 3], ["buy $5 MOON", 2], ["sell 50% MOON", 2], ["sell 50% of MOON as momentum", 3]] as const) {
    expect(parseCommand(line, both)).toEqual({
      kind: "refused",
      message: "Not a trade yet: MOON is a token on Solana (Moon…1111) and on Hood (0x0000…0B01). Pick the one you mean, or paste its address.",
      keepLine: true,
      pick: { word: "MOON", tokens: [{ chain: "Solana", mint: MOON }, { chain: "Hood", mint: HOOD_MOON }], at },
    })
  }
  // Its address trades it.
  expect(parseCommand(`buy 0.01 eth ${HOOD_MOON}`, both)).toMatchObject({ kind: "trade", args: { mint: HOOD_MOON } })
})

describe("bridge <amount> <asset> to <asset>", () => {
  const at = (line: string) => parseCommand(line, ctx)

  test("SOL or USDC to ETH or USDG, or back, by an amount or a percent, with from and as as a trade takes them", () => {
    expect(at("bridge 0.5 sol to eth")).toEqual({ kind: "trade", tool: "candle_bridge", args: { from: "SOL", to: "ETH", amount: "0.5" }, echo: "bridge 0.5 sol to eth" })
    expect(at("bridge 0.5 sol eth")).toMatchObject({ kind: "trade", tool: "candle_bridge", args: { from: "SOL", to: "ETH", amount: "0.5" } })
    expect(at("bridge 50% eth to sol from bot-1-h")).toMatchObject({ kind: "trade", tool: "candle_bridge", args: { from: "ETH", to: "SOL", percent: 50, wallet: "bot-1-h" } })
    expect(at("bridge 25 USDC to USDG from embedded as swing")).toMatchObject({ kind: "trade", tool: "candle_bridge", args: { from: "USDC", to: "USDG", amount: "25", wallet: "embedded" }, agent: "swing" })
  })

  test("a pair on one chain, CNDL, or a percent out of range is said at the line and kept; a sentence goes to the agent", () => {
    expect(at("bridge 0.5 sol to usdc")).toMatchObject({ kind: "refused", keepLine: true, message: expect.stringContaining("SOL or USDC on Solana to ETH or USDG on Hood") })
    expect(at("bridge 1 cndl to eth")).toMatchObject({ kind: "refused", keepLine: true })
    expect(at("bridge 150% eth to sol")).toMatchObject({ kind: "refused", message: "Bridge a percent from 1% to 100%." })
    expect(at("bridge the gap between us")).toMatchObject({ kind: "agent" })
  })

  test("into <wallet> names the TEE wallet it lands in, in any order with from and as; into in to's place reads as to", () => {
    expect(at("bridge 0.009 sol to eth from h1-sol-tee into h1-hood-2")).toMatchObject({ kind: "trade", tool: "candle_bridge", args: { from: "SOL", to: "ETH", amount: "0.009", wallet: "h1-sol-tee", destination: "h1-hood-2" } })
    expect(at("bridge 0.009 sol to eth into h1-hood-2 from h1-sol-tee as swing")).toMatchObject({ kind: "trade", args: { wallet: "h1-sol-tee", destination: "h1-hood-2" }, agent: "swing" })
    expect(at("bridge 0.009 sol eth into h1-hood-2")).toMatchObject({ kind: "trade", args: { from: "SOL", to: "ETH", destination: "h1-hood-2" } })
    // As a fresh Hood TEE wallet's funding chip types it: into its address, then the agent.
    expect(at("bridge 0.01 sol to eth from tee-one into 0x0000000000000000000000000000000000000Ab1 as swing")).toMatchObject({ kind: "trade", args: { wallet: "tee-one", destination: "0x0000000000000000000000000000000000000Ab1", amount: "0.01" }, agent: "swing" })
    expect(at("bridge 0.5 sol into eth")).toMatchObject({ kind: "trade", args: { from: "SOL", to: "ETH", amount: "0.5" } })
    expect((at("bridge 0.5 sol into eth") as { args: Record<string, unknown> }).args.destination).toBeUndefined()
  })

  test("a bridge said as a sentence goes to the agent, as a buy's does: it can name where it lands", () => {
    const line = "Bridge 0.009 SOL from h1-sol-tee to ETH, landing in h1-hood-2 (not h1-hood-tee, which Candle has locked)."
    expect(at(line)).toEqual({ kind: "agent", text: line })
    expect(at("bridge 0.009 SOL from h1-sol-tee to ETH landing in h1-hood-2")).toMatchObject({ kind: "agent" })
  })

  test("a swap across chains is a bridge: said, with the bridge's own line", () => {
    expect(at("swap 0.5 SOL ETH")).toEqual({ kind: "refused", message: "Not a trade yet: SOL to ETH crosses chains, which is a bridge: bridge 0.5 sol to eth.", keepLine: true })
    expect(at("swap 0.5 SOL USDC")).toMatchObject({ kind: "trade", tool: "candle_swap" })
  })
})

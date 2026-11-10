import { afterEach, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { join } from "node:path"
import { loadConfig } from "../config"
import { paths, type Paths } from "../paths"
import { recordProfile } from "./candle-profile"
import { DEFAULT_LIMITS, keyAdd, PromptCancelled, readHiddenLine } from "./key-add"

/** Made-up keys of the real shape (a kind, then 43 characters), built so no key-shaped text sits in the source. */
const LIVE = ["cndl", "live", ""].join("_")
const fakeKey = (kind: "live" | "test", prefix: string, fill: string) => `${["cndl", kind, ""].join("_")}${prefix}${fill.repeat(35)}`
const KEY = fakeKey("live", "Abcdefgh", "x")
const OTHER_KEY = fakeKey("live", "Zyxwvuts", "y")
const TEST_KEY = fakeKey("test", "Testtest", "z")

const homes: string[] = []
afterEach(() => {
  while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true })
})

function home(): { env: Record<string, string>; p: Paths } {
  const dir = mkdtempSync("/tmp/chrn-ka-")
  homes.push(dir)
  const env = { CANDLE_HARNESS_HOME: dir }
  return { env, p: paths(env) }
}

function io(stdin: string) {
  const out: string[] = []
  const err: string[] = []
  const prompts: string[] = []
  return {
    io: {
      out: (s: string) => void out.push(s),
      err: (s: string) => void err.push(s),
      readKey: async (prompt: string) => {
        prompts.push(prompt)
        return stdin
      },
    },
    out,
    err,
    prompts,
    all: () => out.join("") + err.join(""),
  }
}

const mode = (file: string) => statSync(file).mode & 0o777

test("a key given as an argument is refused, never repeated, and nothing is read or written", async () => {
  for (const args of [["--agent", "momentum", KEY], [KEY, "--agent", "momentum"], ["--agent", "momentum", "--key", KEY], ["--agent", "momentum", `--key=${KEY}`]]) {
    const { env, p } = home()
    const t = io(KEY)
    expect(await keyAdd(args, t.io, env)).toBe(2)
    expect(t.all()).toContain("never from an argument")
    expect(t.all()).not.toContain("Abcdefgh")
    expect(t.prompts).toEqual([])
    expect(existsSync(p.configFile)).toBe(false)
    expect(existsSync(p.stateDir)).toBe(false)
  }
})

test("--agent is required, and must be a plain name", async () => {
  const { env } = home()
  const missing = io(KEY)
  expect(await keyAdd([], missing.io, env)).toBe(2)
  expect(missing.err.join("")).toContain("Usage: candle-harness key add --agent <name>")
  const bad = io(KEY)
  expect(await keyAdd(["--agent", "Momentum!"], bad.io, env)).toBe(2)
  expect(bad.err.join("")).toContain("can't be an agent name")
  expect(bad.prompts).toEqual([])
})

test("a key of the wrong shape is refused, never repeated, and nothing is written", async () => {
  const wrong = [
    "",
    "sk-ant-not-a-candle-key",
    "cndl_live_short",
    `cndl_prod_Abcdefgh${"x".repeat(35)}`,
    `${KEY}x`,
    `${LIVE}Abcdefgh${"x".repeat(17)}\n${"x".repeat(18)}`, // a paste split over two lines
    `cndl_live_Abcd efgh${"x".repeat(34)}`,
  ]
  for (const stdin of wrong) {
    const { env, p } = home()
    const t = io(stdin)
    expect(await keyAdd(["--agent", "momentum"], t.io, env)).toBe(1)
    expect(t.err.join("")).toMatch(stdin === "" ? /No key arrived/ : /isn't a Candle agent key/)
    if (stdin.length > 10) expect(t.all()).not.toContain(stdin.slice(10, 30))
    expect(existsSync(p.keyFile("momentum"))).toBe(false)
    expect(existsSync(p.configFile)).toBe(false)
  }
})

test("the first agent: its key at 0600 in a 0700 folder, a new config in paper mode with the default limits", async () => {
  const { env, p } = home()
  const t = io(`  ${KEY}\n`)
  expect(await keyAdd(["--agent", "momentum"], t.io, env)).toBe(0)
  expect(readFileSync(p.keyFile("momentum"), "utf8")).toBe(`${KEY}\n`)
  expect(mode(p.keyFile("momentum"))).toBe(0o600)
  expect(mode(p.keysDir)).toBe(0o700)
  expect(mode(p.stateDir)).toBe(0o700)
  // The config can hold a paid RPC address, so it's the person's alone.
  expect(mode(p.configFile)).toBe(0o600)
  const { config, warnings } = loadConfig(p)
  expect(warnings).toEqual([])
  expect(config.mode).toBe("paper")
  expect(config.activeAgent).toBe("momentum")
  expect(config.agents.momentum!.limits).toEqual(DEFAULT_LIMITS)
  // Said once what it did, with the public prefix only, and the advice on the master copy.
  expect(t.prompts).toEqual(["Paste momentum's Candle agent key (it won't show): "])
  expect(t.all()).not.toContain(KEY)
  expect(t.all()).not.toContain(KEY.slice(18))
  expect(t.out.join("")).toContain(`Added momentum (key ${LIVE}Abcdefgh…), in paper mode.`)
  expect(t.out.join("")).toContain("password manager")
  expect(t.out.join("")).toContain("$10 per trade, $50 per day")
})

test("the agent's table carries the default wallet as a commented line, which works once filled in", async () => {
  const { env, p } = home()
  expect(await keyAdd(["--agent", "momentum"], io(KEY).io, env)).toBe(0)
  const text = readFileSync(p.configFile, "utf8")
  expect(text).toContain('[agents.momentum]\n# The wallet momentum pays from when a trade names none')
  expect(text).toContain('# wallet = "<label or address>"\n# Quant (the default)')
  expect(text).toContain('# preset = "trader"\n[agents.momentum.limits]')
  expect(loadConfig(p).config.agents.momentum!.wallet).toBeUndefined()
  writeFileSync(p.configFile, text.replace('# wallet = "<label or address>"', 'wallet = "tee-one"'))
  const { config, warnings } = loadConfig(p)
  expect(warnings).toEqual([])
  expect(config.agents.momentum).toMatchObject({ wallet: "tee-one", limits: DEFAULT_LIMITS })
  writeFileSync(p.configFile, text.replace('# preset = "trader"', 'preset = "trader"'))
  expect(loadConfig(p).config.agents.momentum!.preset).toBe("trader")
})

test("limits given on the command line go into the config", async () => {
  const { env, p } = home()
  expect(await keyAdd(["--agent", "momentum", "--per-trade-usd", "2", "--per-day-usd=10"], io(KEY).io, env)).toBe(0)
  expect(loadConfig(p).config.agents.momentum!.limits).toEqual({ perTradeUsd: 2, perDayUsd: 10 })
  for (const bad of [["--per-trade-usd", "0"], ["--per-trade-usd", "-5"], ["--per-day-usd", "ten"], ["--per-day-usd"]]) {
    const t = io(OTHER_KEY)
    expect(await keyAdd(["--agent", "swing", ...bad], t.io, env)).toBe(2)
    expect(t.prompts).toEqual([])
  }
  expect(Object.keys(loadConfig(p).config.agents)).toEqual(["momentum"])
})

test("a second agent is appended, keeping the file as the user wrote it", async () => {
  const { env, p } = home()
  mkdirSync(p.configDir, { recursive: true })
  const written = `# my settings\nmode = "live"\nactiveAgent = "momentum"\n\n[cards]\ntypedTrades = "instant"\n\n[agents.momentum.limits]\nperTradeUsd = 5\nperDayUsd = 20`
  writeFileSync(p.configFile, written, { mode: 0o600 })
  const t = io(OTHER_KEY)
  expect(await keyAdd(["--agent", "swing"], t.io, env)).toBe(0)
  const text = readFileSync(p.configFile, "utf8")
  expect(text.startsWith(written)).toBe(true)
  expect(mode(p.configFile)).toBe(0o600)
  const { config } = loadConfig(p)
  expect(Object.keys(config.agents)).toEqual(["momentum", "swing"])
  expect(config.mode).toBe("live")
  expect(config.cards.typedTrades).toBe("instant")
  expect(t.out.join("")).toContain("in live mode")
})

test("adding an agent that's already there replaces its key and leaves the config alone", async () => {
  const { env, p } = home()
  expect(await keyAdd(["--agent", "momentum"], io(KEY).io, env)).toBe(0)
  const before = readFileSync(p.configFile, "utf8")
  const t = io(OTHER_KEY)
  expect(await keyAdd(["--agent", "momentum"], t.io, env)).toBe(0)
  expect(readFileSync(p.keyFile("momentum"), "utf8")).toBe(`${OTHER_KEY}\n`)
  expect(readFileSync(p.configFile, "utf8")).toBe(before)
  expect(t.out.join("")).toContain("Replaced the key for momentum")
  // Its limits are changed in the file, not here.
  const limits = io(KEY)
  expect(await keyAdd(["--agent", "momentum", "--per-trade-usd", "3"], limits.io, env)).toBe(2)
  expect(limits.err.join("")).toContain("change its limits there")
  expect(readFileSync(p.keyFile("momentum"), "utf8")).toBe(`${OTHER_KEY}\n`)
})

test("one key can't be two agents", async () => {
  const { env, p } = home()
  expect(await keyAdd(["--agent", "momentum"], io(KEY).io, env)).toBe(0)
  const t = io(KEY)
  expect(await keyAdd(["--agent", "swing"], t.io, env)).toBe(1)
  expect(t.err.join("")).toContain("already momentum's")
  expect(existsSync(p.keyFile("swing"))).toBe(false)
  expect(Object.keys(loadConfig(p).config.agents)).toEqual(["momentum"])
})

test("a test key is accepted, with a warning that it can't trade", async () => {
  const { env, p } = home()
  const t = io(TEST_KEY)
  expect(await keyAdd(["--agent", "tester"], t.io, env)).toBe(0)
  expect(existsSync(p.keyFile("tester"))).toBe(true)
  expect(t.err.join("")).toContain("TEST_ENVIRONMENT_FORBIDDEN")
  expect(t.all()).not.toContain(TEST_KEY)
})

test("a config with problems is left alone, and no key is asked for", async () => {
  const { env, p } = home()
  mkdirSync(p.configDir, { recursive: true })
  for (const bad of [`mode = "yolo"\n[agents.momentum.limits]\nperTradeUsd = 5\nperDayUsd = 20\n`, "this isn't toml ="]) {
    writeFileSync(p.configFile, bad)
    const t = io(KEY)
    expect(await keyAdd(["--agent", "swing"], t.io, env)).toBe(1)
    expect(t.err.join("")).toContain("nothing was changed")
    expect(t.prompts).toEqual([])
    expect(readFileSync(p.configFile, "utf8")).toBe(bad)
    expect(existsSync(p.keysDir)).toBe(false)
  }
})

test("a config the agent can't be appended to is left alone, with the lines to add", async () => {
  const { env, p } = home()
  mkdirSync(p.configDir, { recursive: true })
  // An inline table can't be extended by a later [agents.x] header.
  const inline = `agents = { momentum = { limits = { perTradeUsd = 5, perDayUsd = 20 } } }\n`
  writeFileSync(p.configFile, inline)
  const t = io(OTHER_KEY)
  expect(await keyAdd(["--agent", "swing"], t.io, env)).toBe(1)
  expect(t.err.join("")).toContain("[agents.swing.limits]")
  expect(readFileSync(p.configFile, "utf8")).toBe(inline)
  expect(existsSync(p.keyFile("swing"))).toBe(false)
})

test("a config with no agents yet gets the first one", async () => {
  const { env, p } = home()
  mkdirSync(p.configDir, { recursive: true })
  writeFileSync(p.configFile, `mode = "paper"\n`)
  expect(await keyAdd(["--agent", "momentum"], io(KEY).io, env)).toBe(0)
  expect(Object.keys(loadConfig(p).config.agents)).toEqual(["momentum"])
})

test("never takes a key from the environment", async () => {
  const { env, p } = home()
  const t = io("")
  expect(await keyAdd(["--agent", "momentum"], t.io, { ...env, CANDLE_API_KEY: KEY, CANDLE_AGENT_API_KEY: KEY })).toBe(1)
  expect(t.err.join("")).toContain("No key arrived")
  expect(existsSync(p.keyFile("momentum"))).toBe(false)
})

test("says a running core picks the key up when it restarts", async () => {
  const { env, p } = home()
  mkdirSync(p.stateDir, { recursive: true, mode: 0o700 })
  const server = createServer(() => {}).listen(p.socket)
  await new Promise((resolve) => server.once("listening", resolve))
  try {
    const t = io(KEY)
    expect(await keyAdd(["--agent", "momentum"], t.io, env)).toBe(0)
    expect(t.out.join("")).toContain("A core is running")
  } finally {
    server.close()
  }
})

/** A stand-in for a terminal's stdin. */
class FakeTty extends EventEmitter {
  raw: boolean[] = []
  setRawMode(on: boolean) {
    this.raw.push(on)
  }
  resume() {}
  pause() {}
}

test("the hidden prompt echoes nothing, handles backspace, and ends on Enter", async () => {
  const tty = new FakeTty()
  const written: string[] = []
  const line = readHiddenLine(tty, (s) => void written.push(s), "Paste: ")
  tty.emit("data", Buffer.from("cndl_livx"))
  tty.emit("data", "\u007f_rest\rignored")
  expect(await line).toBe("cndl_liv_rest")
  expect(written).toEqual(["Paste: ", "\n"])
  expect(tty.raw).toEqual([true, false])
  expect(tty.listenerCount("data")).toBe(0)
})

test("ctrl-c at the hidden prompt cancels it and puts the terminal back", async () => {
  const tty = new FakeTty()
  const line = readHiddenLine(tty, () => {}, "Paste: ")
  tty.emit("data", "abc\u0003")
  expect(line).rejects.toBeInstanceOf(PromptCancelled)
  await line.catch(() => {})
  expect(tty.raw).toEqual([true, false])
})

test("a new agent is said to join the mode last picked, not the config's", async () => {
  const { env, p } = home()
  expect(await keyAdd(["--agent", "momentum"], io(KEY).io, env)).toBe(0)
  writeFileSync(p.modeState, JSON.stringify({ mode: "live" }), { mode: 0o600 })
  const t = io(OTHER_KEY)
  expect(await keyAdd(["--agent", "swing"], t.io, env)).toBe(0)
  expect(t.out.join("")).toContain("Added swing")
  expect(t.out.join("")).toContain("in live mode")
})

test("the CLI profile recorded on a fresh home makes a config only the person can read", async () => {
  const { p } = home()
  expect(await recordProfile(p, "candle-harness")).toEqual({ ok: true, wrote: true })
  expect(mode(p.configFile)).toBe(0o600)
  // Its folder too, when this makes it, as every other path that makes it does: it holds config.toml and the keys.
  const fresh = paths({ CANDLE_HARNESS_HOME: join(p.configDir, "harness") })
  expect(await recordProfile(fresh, "candle-harness")).toEqual({ ok: true, wrote: true })
  expect(mode(fresh.configDir)).toBe(0o700)
})

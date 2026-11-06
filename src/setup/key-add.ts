// `candle-harness key add --agent <name>`: the only way an agent's key gets into the Candle Harness.
// The key comes from stdin, never an argument, so it stays out of shell history and the process
// list; on a terminal it's read on a hidden prompt. It's checked for the shape of a Candle agent key,
// written to state/keys/<agent>.key at 0600, and the agent goes into config.toml with its Candle Harness limits.
// Nothing here reads the keychain, a CLI profile or an env file, and the key is never printed.
import { randomBytes } from "node:crypto"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { chmod, link, mkdir, rename, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { ConfigError, MAX_AGENTS, parseConfig } from "../config"
import { readSavedMode } from "../core/mode-state"
import { ensureStateDir, isAgentName, paths, PathsError, type Paths, UnsafeStateDir } from "../paths"
import { apiKeyPrefix } from "../shared/api-key"
import { answers } from "../shared/socket-path"

/** A new agent's Candle Harness limits when `key add` isn't given them: small, so a first live trade is small. */
export const DEFAULT_LIMITS = { perTradeUsd: 10, perDayUsd: 50 }

export interface KeyAddIo {
  out(text: string): void
  err(text: string): void
  /** The key: a hidden prompt on a terminal (showing `prompt`), or all of stdin when it's piped. */
  readKey(prompt: string): Promise<string>
}

const USAGE = `Usage: candle-harness key add --agent <name> [--per-trade-usd <n>] [--per-day-usd <n>]

  The key is read from stdin: paste it at the prompt, or pipe it in from your password manager.
  It's never taken as an argument, which would put it in your shell history.
`

const FROM_STDIN =
  "The key is read from stdin, never from an argument, which would put it in your shell history and the process list. " +
  "Run `candle-harness key add --agent <name>` and paste it at the prompt, or pipe it in from your password manager."

interface Parsed {
  agent: string
  perTradeUsd?: number
  perDayUsd?: number
}

/** The parsed flags, or the exit code when there's nothing more to do (help, or a usage error). */
function parseArgs(args: string[], io: KeyAddIo): Parsed | number {
  let agent: string | undefined
  const limits: { perTradeUsd?: number; perDayUsd?: number } = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === "--help" || arg === "-h") {
      io.out(USAGE)
      return 0
    }
    const eq = arg.indexOf("=")
    const flag = arg.startsWith("--") && eq > 0 ? arg.slice(0, eq) : arg
    // Whatever isn't a known flag may be the key itself: refused without being repeated.
    if (flag === "--key" || flag === "--api-key" || !flag.startsWith("--")) {
      io.err(`${FROM_STDIN}\n`)
      return 2
    }
    if (flag !== "--agent" && flag !== "--per-trade-usd" && flag !== "--per-day-usd") {
      io.err(`candle-harness key add: unknown option ${flag}\n\n${USAGE}`)
      return 2
    }
    const value = flag !== arg ? arg.slice(eq + 1) : args[++i]
    if (value === undefined || value === "") {
      io.err(`candle-harness key add: ${flag} needs a value\n\n${USAGE}`)
      return 2
    }
    if (flag === "--agent") {
      agent = value
      continue
    }
    const dollars = Number(value)
    if (!/^\d+(\.\d+)?$/.test(value) || !(dollars > 0)) {
      io.err(`candle-harness key add: ${flag} is a dollar amount above 0, such as 10\n`)
      return 2
    }
    if (flag === "--per-trade-usd") limits.perTradeUsd = dollars
    else limits.perDayUsd = dollars
  }
  if (agent === undefined) {
    io.err(USAGE)
    return 2
  }
  return { agent, ...limits }
}

/**
 * Writes `text` beside `file` and renames it into place, so a reader never sees half of it.
 * `exclusive`: never over a file that's there (a hard link fails if one appeared meanwhile).
 */
async function writeAtomic(file: string, text: string, mode: number, opts: { exclusive?: boolean } = {}): Promise<void> {
  const temp = join(dirname(file), `.${basename(file)}.${randomBytes(6).toString("hex")}.tmp`)
  try {
    await writeFile(temp, text, { mode, flag: "wx" })
    await chmod(temp, mode) // the umask can narrow writeFile's mode, never widen it; say exactly
    if (opts.exclusive) {
      await link(temp, file)
      await rm(temp, { force: true })
    } else await rename(temp, file)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

/** The agent that already holds this exact key, if any. */
function keyHeldBy(p: Paths, key: string, except: string): string | undefined {
  if (!existsSync(p.keysDir)) return undefined
  for (const file of readdirSync(p.keysDir)) {
    if (!file.endsWith(".key")) continue
    const agent = file.slice(0, -".key".length)
    if (agent === except || !isAgentName(agent)) continue
    try {
      if (readFileSync(join(p.keysDir, file), "utf8").trim() === key) return agent
    } catch {}
  }
  return undefined
}

const NEW_CONFIG_HEAD = `# Candle Harness config: https://github.com/candledottv/harness
# \`candle-harness key add\` adds each agent here with its Candle Harness limits, which the core enforces on top of
# the key's own caps on Candle. A fresh install starts in this mode; after that, the Candle Harness keeps the
# mode you last picked.
mode = "paper"
`

/**
 * The agent's table, with its default paying wallet and its preset as commented lines to fill in.
 */
function agentBlock(agent: string, limits: { perTradeUsd: number; perDayUsd: number }): string {
  return (
    `\n[agents.${agent}]\n` +
    `# The wallet ${agent} pays from when a trade names none: a TEE wallet bound to its key, by label or\n` +
    `# address. Left out, the embedded wallet. A trade can name one too: buy 0.1 sol MOON from <wallet>.\n` +
    `# wallet = "<label or address>"\n` +
    `# Quant (the default) reads Candle's data first and uses Candle's skills; "trader" is the plain\n` +
    `# prompt; "bare" the essentials only, to run light or with your own skills (skills/<name>/SKILL.md\n` +
    `# beside this file). Where ${agent} starts: after that, the Candle Harness keeps the preset you last picked (ctrl-g).\n` +
    `# preset = "trader"\n` +
    `[agents.${agent}.limits]\nperTradeUsd = ${limits.perTradeUsd}\nperDayUsd = ${limits.perDayUsd}\n`
  )
}

const usd = (n: number) => `$${n}`

export async function keyAdd(args: string[], io: KeyAddIo, env: Record<string, string | undefined> = process.env): Promise<number> {
  const parsed = parseArgs(args, io)
  if (typeof parsed === "number") return parsed
  const { agent } = parsed
  if (!isAgentName(agent)) {
    io.err(`"${agent}" can't be an agent name: use 1 to 32 lower-case letters, digits, "-" or "_", starting with a letter or digit\n`)
    return 2
  }

  let p: Paths
  try {
    p = paths(env)
  } catch (error) {
    if (error instanceof PathsError) {
      io.err(`${error.message}\n`)
      return 1
    }
    throw error
  }

  // What the config will say once the agent is in, checked before anything is asked for or written.
  const existing = existsSync(p.configFile) ? readFileSync(p.configFile, "utf8") : undefined
  let current: ReturnType<typeof parseConfig> | undefined
  if (existing !== undefined) {
    try {
      current = parseConfig(existing, p.configFile)
    } catch (error) {
      if (!(error instanceof ConfigError) || error.code !== "no_agents") {
        io.err(`${(error as Error).message}\nFix config.toml first; nothing was changed.\n`)
        return 1
      }
    }
  }
  const known = current?.config.agents[agent]
  if (known && (parsed.perTradeUsd !== undefined || parsed.perDayUsd !== undefined)) {
    io.err(`${agent} is already in ${p.configFile}; change its limits there. To replace its key, run key add again without the limits.\n`)
    return 2
  }
  let nextConfig: string | undefined
  let limits = known?.limits
  if (!known) {
    if (current && Object.keys(current.config.agents).length >= MAX_AGENTS) {
      io.err(`${p.configFile} already has ${MAX_AGENTS} agents, Candle's limit of active keys per account. Remove one first.\n`)
      return 1
    }
    limits = { perTradeUsd: parsed.perTradeUsd ?? DEFAULT_LIMITS.perTradeUsd, perDayUsd: parsed.perDayUsd ?? DEFAULT_LIMITS.perDayUsd }
    const base = existing === undefined ? NEW_CONFIG_HEAD : existing.endsWith("\n") || existing === "" ? existing : `${existing}\n`
    nextConfig = base + agentBlock(agent, limits)
    try {
      const next = parseConfig(nextConfig, p.configFile)
      if (!next.config.agents[agent]) throw new ConfigError("invalid", `${p.configFile} wouldn't hold ${agent}`)
    } catch (error) {
      io.err(
        `Couldn't add ${agent} to ${p.configFile} as it's written: ${(error as Error).message}\n` +
          `Add it yourself:\n${agentBlock(agent, limits)}\nNothing was changed.\n`,
      )
      return 1
    }
  }

  const key = (await io.readKey(`Paste ${agent}'s Candle agent key (it won't show): `)).trim()
  if (key === "") {
    io.err(`No key arrived on stdin. ${FROM_STDIN}\n`)
    return 1
  }
  const prefix = apiKeyPrefix(key)
  if (prefix === undefined) {
    io.err(
      "That isn't a Candle agent key: one starts with cndl_live_ (or cndl_test_) and is 53 characters long, all on one line. " +
        "Nothing was written. Make one with `candle keys create --access write --embedded-wallet allow --label <name>`.\n",
    )
    return 1
  }
  const holder = keyHeldBy(p, key, agent)
  if (holder) {
    io.err(`That key is already ${holder}'s. Each agent needs its own key, so each keeps its own Candle caps and history. Nothing was written.\n`)
    return 1
  }

  try {
    await ensureStateDir(p)
  } catch (error) {
    if (error instanceof UnsafeStateDir) {
      io.err(`${error.message}\n`)
      return 1
    }
    throw error
  }
  await mkdir(p.keysDir, { recursive: true, mode: 0o700 })
  const keyFile = p.keyFile(agent)
  const replacing = existsSync(keyFile) ? readFileSync(keyFile, "utf8").trim() : undefined
  await writeAtomic(keyFile, `${key}\n`, 0o600)
  if (nextConfig !== undefined) {
    await mkdir(p.configDir, { recursive: true, mode: 0o700 })
    const mode = existing === undefined ? 0o600 : statSync(p.configFile).mode & 0o777
    await writeAtomic(p.configFile, nextConfig, mode)
  }

  const shown = `${key.slice(0, key.indexOf("_", 5) + 1)}${prefix}…`
  const what = replacing === undefined ? "Added" : replacing === key ? "Kept" : "Replaced the key for"
  const mode = readSavedMode(p.modeState) ?? current?.config.mode ?? "paper"
  io.out(`${what} ${agent} (key ${shown})${replacing === undefined ? `, in ${mode} mode` : ""}.\n`)
  io.out(`  key file  ${keyFile} (0600)\n`)
  io.out(`  limits    ${usd(limits!.perTradeUsd)} per trade, ${usd(limits!.perDayUsd)} per day, enforced by the Candle Harness on top of the key's caps on Candle (${p.configFile})\n\n`)
  if (key.startsWith("cndl_test_")) {
    io.err("This is a test key. Reads work, but Candle refuses every trade from a test key, paper included (TEST_ENVIRONMENT_FORBIDDEN). Use a cndl_live_ key to trade.\n\n")
  }
  io.out("Keep this key's master copy in your password manager. The Candle Harness holds a working copy and never shows it again.\n")
  if (await answers(p.socket)) {
    io.out("A core is running. It picks up the key when it restarts: quit every view (ctrl-c twice) and it stops a minute later.\n")
  }
  io.out("Next: `candle-harness doctor` checks the key can trade, then `candle-harness` opens the Candle Harness.\n")
  return 0
}

/**
 * A key `keys create` just made, stored as a new agent: by the prompt pane's
 * launcher, with `key add`'s own checks and writes. It only adds: an agent already in config.toml, a
 * key file already there, or a key another agent holds is refused, and nothing is written (the
 * Candle Harness never replaces a key). The key is never printed.
 */
export async function storeNewAgentKey(p: Paths, agent: string, key: string): Promise<{ ok: true; prefix: string } | { ok: false; prefix?: string; why: string }> {
  const prefix = apiKeyPrefix(key.trim())
  if (prefix === undefined) return { ok: false, why: "the CLI's answer didn't hold a Candle agent key" }
  if (!isAgentName(agent)) return { ok: false, prefix, why: `"${agent}" can't be an agent name` }
  const existing = existsSync(p.configFile) ? readFileSync(p.configFile, "utf8") : undefined
  let current: ReturnType<typeof parseConfig> | undefined
  try {
    if (existing !== undefined) current = parseConfig(existing, p.configFile)
  } catch (error) {
    if (!(error instanceof ConfigError) || error.code !== "no_agents") return { ok: false, prefix, why: `config.toml doesn't parse: ${(error as Error).message}` }
  }
  if (current?.config.agents[agent] || existsSync(p.keyFile(agent))) return { ok: false, prefix, why: `${agent} is already an agent here, and the Candle Harness never replaces a key` }
  if (current && Object.keys(current.config.agents).length >= MAX_AGENTS) return { ok: false, prefix, why: `config.toml already has ${MAX_AGENTS} agents` }
  if (keyHeldBy(p, key.trim(), agent)) return { ok: false, prefix, why: "another agent already holds that key" }
  const base = existing === undefined ? NEW_CONFIG_HEAD : existing.endsWith("\n") || existing === "" ? existing : `${existing}\n`
  const nextConfig = base + agentBlock(agent, DEFAULT_LIMITS)
  try {
    if (!parseConfig(nextConfig, p.configFile).config.agents[agent]) return { ok: false, prefix, why: `config.toml wouldn't hold ${agent} as it's written` }
  } catch (error) {
    return { ok: false, prefix, why: `config.toml wouldn't hold ${agent} as it's written: ${(error as Error).message}` }
  }
  try {
    await ensureStateDir(p)
    await mkdir(p.keysDir, { recursive: true, mode: 0o700 })
    // The key first, then the config: a config naming an agent with no key is what the doctor finds.
    await writeAtomic(p.keyFile(agent), `${key.trim()}\n`, 0o600, { exclusive: true })
    await mkdir(p.configDir, { recursive: true, mode: 0o700 })
    await writeAtomic(p.configFile, nextConfig, existing === undefined ? 0o600 : statSync(p.configFile).mode & 0o777)
  } catch (error) {
    return { ok: false, prefix, why: `it couldn't be written: ${(error as Error).message}` }
  }
  return { ok: true, prefix }
}

/** The parts of a terminal's stdin the hidden prompt uses (process.stdin has them all). */
export interface HiddenInput {
  setRawMode(on: boolean): unknown
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown
  removeListener(event: "data", listener: (chunk: Buffer | string) => void): unknown
  resume(): unknown
  pause(): unknown
}

export class PromptCancelled extends Error {
  constructor() {
    super("cancelled")
    this.name = "PromptCancelled"
  }
}

/**
 * One line from a terminal with nothing echoed. Enter ends it (so a paste that brings its own newline
 * does too), backspace takes a character off, ctrl-c or ctrl-d on an empty line cancels. Listens for
 * data and never iterates the stream, which would close stdin when it returns early.
 */
export function readHiddenLine(input: HiddenInput, write: (text: string) => void, prompt: string): Promise<string> {
  write(prompt)
  return new Promise((resolve, reject) => {
    let line = ""
    const finish = (error?: Error) => {
      input.removeListener("data", onData)
      input.setRawMode(false)
      input.pause()
      write("\n")
      if (error) reject(error)
      else resolve(line)
    }
    const onData = (chunk: Buffer | string) => {
      for (const ch of chunk.toString()) {
        if (ch === "\r" || ch === "\n") return finish()
        if (ch === "\u0003" || (ch === "\u0004" && line === "")) return finish(new PromptCancelled())
        if (ch === "\u0004") return finish()
        if (ch === "\u007f" || ch === "\b") line = line.slice(0, -1)
        else if (ch >= " ") line += ch
      }
    }
    input.setRawMode(true)
    input.on("data", onData)
    input.resume()
  })
}

/**
 * An agent's Candle Harness limits, as onboarding's limits step sets them: the two lines under its own
 * `[agents.<agent>.limits]` table changed, and nothing else in the file. Only an agent whose table is there, as
 * `key add` and the launcher write it; the result must parse to exactly these figures, or nothing is written.
 */
export async function recordAgentLimits(p: Paths, agent: string, limits: { perTradeUsd: number; perDayUsd: number }): Promise<{ ok: true; wrote: boolean } | { ok: false; why: string }> {
  if (!isAgentName(agent)) return { ok: false, why: `"${agent}" can't be an agent name` }
  const figure = (n: number) => Number.isFinite(n) && n > 0 && n <= 1_000_000 && Math.round(n * 100) === n * 100
  if (!figure(limits.perTradeUsd) || !figure(limits.perDayUsd)) return { ok: false, why: "a limit is a dollar figure from $0.01 to $1,000,000, to the cent" }
  if (limits.perTradeUsd > limits.perDayUsd) return { ok: false, why: "the limit a trade can't be over the limit a day" }
  let existing: string
  try {
    existing = readFileSync(p.configFile, "utf8")
  } catch {
    return { ok: false, why: "there's no config.toml to write to" }
  }
  const lines = existing.split("\n")
  const header = new RegExp(`^\\s*\\[agents\\.${agent.replace(/[-]/g, "\\-")}\\.limits\\]\\s*(#.*)?$`)
  const at = lines.findIndex((l) => header.test(l))
  if (at < 0) return { ok: false, why: `config.toml has no [agents.${agent}.limits] table` }
  let end = lines.findIndex((l, i) => i > at && /^\s*\[/.test(l))
  if (end < 0) end = lines.length
  const set = { perTradeUsd: false, perDayUsd: false }
  for (let i = at + 1; i < end; i++) {
    const key = /^\s*(perTradeUsd|perDayUsd)\s*=/.exec(lines[i]!)?.[1] as keyof typeof set | undefined
    if (!key) continue
    lines[i] = `${key} = ${limits[key]}`
    set[key] = true
  }
  if (!set.perTradeUsd || !set.perDayUsd) return { ok: false, why: `[agents.${agent}.limits] doesn't hold both perTradeUsd and perDayUsd` }
  const next = lines.join("\n")
  if (next === existing) return { ok: true, wrote: false }
  try {
    const parsed = parseConfig(next, p.configFile).config.agents[agent]?.limits
    if (parsed?.perTradeUsd !== limits.perTradeUsd || parsed.perDayUsd !== limits.perDayUsd) return { ok: false, why: "config.toml wouldn't hold the limits as they're written" }
  } catch (error) {
    return { ok: false, why: `config.toml wouldn't hold the limits as they're written: ${(error as Error).message}` }
  }
  await writeAtomic(p.configFile, next, statSync(p.configFile).mode & 0o777)
  return { ok: true, wrote: true }
}

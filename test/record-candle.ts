// Records Candle's real MCP shapes on a separate test machine, for the fake server and the fixtures. It
// reads only, apart from one optional paper trade (no funds move), and writes only to its own output folder.
// Keys are typed (hidden) or piped on stdin, one per line as `<label> <key>`; they never go in an
// argument, and every recording passes the redactor before it's written.
//
// Built here, run there:
//   bun build --compile --target=bun-darwin-arm64 test/record-candle.ts --outfile dist/record-candle-darwin-arm64
//   ./record-candle [--out DIR] [--cli PATH] [--package PATH] [--paper-mint MINT]
//
// For every key and every route it can start (A: `candle mcp`; B: `candle-mcp`), it records the
// handshake, tools/list (descriptions included) and one call each of the core's reads. It adds the reads
// the TEE and card rows are built on: the wallets the key may pay from (by its own
// prefix), staking and fees, and a launch id that was never used. With two or more
// keys and --paper-mint, it also paper-buys a little of that mint with the first key and reads both
// keys' portfolios after, to show whether paper books are per key.
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { CandleMcpChild, childLaunch, type McpRoute } from "../src/core/candle-mcp"
import { apiKeyPrefix } from "../src/shared/api-key"
import { Redactor } from "../src/shared/redact"

const SOL_MINT = "So11111111111111111111111111111111111111112"

const { values: opts } = parseArgs({
  options: {
    out: { type: "string" },
    cli: { type: "string", default: "candle" },
    package: { type: "string", default: "candle-mcp" },
    "paper-mint": { type: "string" },
  },
})

const out = resolve(opts.out ?? `candle-recordings-${new Date().toISOString().replace(/[:.]/g, "-")}`)
mkdirSync(out, { recursive: true, mode: 0o700 })
const redactor = new Redactor()

/**
 * Reads hidden lines until an empty one, through one readline session, so a paste of several lines
 * keeps every line. (The first version read raw stdin with `for await` and returned from inside the
 * loop, which destroyed stdin: the next prompt died with ABORT_ERR, and pasted lines after the first
 * were lost.) Echo is off except for the prompt itself, as the CLI's own
 * `readHiddenLine` does (agentic packages/cli/src/secret-store.ts).
 */
async function readHiddenLines(prompt: string): Promise<string[]> {
  const readline = await import("node:readline")
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  ;(rl as unknown as { _writeToOutput: (text: string) => void })._writeToOutput = (text) => {
    if (text === prompt) process.stdout.write(text)
  }
  const lines: string[] = []
  return new Promise((resolve) => {
    rl.on("SIGINT", () => process.exit(130))
    rl.on("line", (line) => {
      const trimmed = line.trim()
      process.stdout.write(trimmed === "" ? "\n" : `(${lines.length + 1} read)\n`)
      if (trimmed === "") return rl.close()
      lines.push(trimmed)
      rl.prompt()
    })
    rl.on("close", () => resolve(lines))
    rl.setPrompt(prompt)
    rl.prompt()
  })
}

async function readKeys(): Promise<{ label: string; key: string }[]> {
  const lines: string[] = []
  if (process.stdin.isTTY) {
    console.log("Paste one key per line as `<label> <key>` (labels such as first, second, spare1). Input is hidden. An empty line ends.")
    lines.push(...(await readHiddenLines("> ")))
  } else {
    lines.push(...(await new Response(Bun.stdin.stream()).text()).split("\n").map((l) => l.trim()).filter(Boolean))
  }
  return lines.map((line, i) => {
    const parts = line.split(/\s+/)
    const [label, key] = parts.length >= 2 ? [parts[0]!, parts[1]!] : [`key${i + 1}`, parts[0]!]
    if (!/^[a-z0-9_-]{1,32}$/i.test(label)) throw new Error(`label "${label}" must be letters, digits, - or _`)
    redactor.add(key)
    return { label, key }
  })
}

function write(name: string, value: unknown): void {
  writeFileSync(join(out, `${name}.json`), `${JSON.stringify(redactor.value(value), null, 2)}\n`, { mode: 0o600 })
}

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = performance.now()
  const value = await fn()
  return { value, ms: Math.round(performance.now() - started) }
}

async function startChild(route: McpRoute, label: string, key: string): Promise<{ child: CandleMcpChild; configDir: string } | undefined> {
  const configDir = join(out, `.config-${route}-${label}`)
  mkdirSync(configDir, { recursive: true, mode: 0o700 })
  const spec = childLaunch({ route, path: route === "cli" ? opts.cli! : opts.package!, apiKey: key, configDir, parentEnv: process.env })
  const child = new CandleMcpChild(label, spec, { backoffMs: [3_600_000] })
  const { ms } = await timed(() => child.start())
  const status = child.status()
  write(`${route}-${label}-handshake`, { route, status, startMs: ms, stderrTail: child.stderrTail(), tools: child.tools() })
  console.log(`route ${route}, ${label}: ${status.state}${"version" in status ? ` ${status.version}` : ""}${"reason" in status ? ` (${status.reason})` : ""}, ${ms} ms, ${child.tools().length} tools`)
  if (status.state !== "ready") {
    await child.stop()
    rmSync(configDir, { recursive: true, force: true })
    return undefined
  }
  return { child, configDir }
}

async function record(route: McpRoute, label: string, child: CandleMcpChild, name: string, args: Record<string, unknown>, tag = name) {
  const { value, ms } = await timed(() => child.call(name, args, { timeoutMs: 60_000 }))
  write(`${route}-${label}-${tag}`, { tool: name, args, ms, outcome: value })
  console.log(`  ${tag}: ${value.kind}${value.kind === "error" ? ` ${value.code}` : ""}, ${ms} ms`)
  return value
}

const keys = await readKeys()
if (keys.length === 0) {
  console.error("No keys given.")
  process.exit(2)
}
console.log(`Recording into ${out}`)

for (const route of ["cli", "package"] as const) {
  const running: { label: string; child: CandleMcpChild; configDir: string }[] = []
  for (const { label, key } of keys) {
    const started = await startChild(route, label, key)
    if (!started) continue
    running.push({ label, ...started })
    const { child } = started
    await record(route, label, child, "candle_get_market", { chain: "solana", mint: SOL_MINT })
    await record(route, label, child, "candle_resolve_token", { mint: SOL_MINT })
    await record(route, label, child, "candle_get_wallets", {})
    // The tool takes the key's prefix (`keyPrefix` is required: the first recording sent `{}`).
    const keyPrefix = apiKeyPrefix(key)
    if (keyPrefix) await record(route, label, child, "candle_get_profile_wallets", { keyPrefix })
    else console.log("  candle_get_profile_wallets: skipped, the key isn't in the shape its prefix is read from")
    await record(route, label, child, "candle_get_portfolio", {})
    await record(route, label, child, "candle_execution_status", {})
    await record(route, label, child, "candle_get_operation", { clientId: crypto.randomUUID(), kind: "trade" }, "candle_get_operation-not-found")
    await record(route, label, child, "candle_get_operation", { clientId: crypto.randomUUID(), kind: "launch" }, "candle_get_operation-launch-not-found")
    await record(route, label, child, "candle_get_staking", {})
    await record(route, label, child, "candle_get_fees", { limit: 5 })
  }

  const paperMint = opts["paper-mint"]
  if (paperMint && running.length >= 2) {
    const [first, second] = running as [(typeof running)[0], (typeof running)[0]]
    const clientTradeId = crypto.randomUUID()
    await record(route, first.label, first.child, "candle_trade", { mint: paperMint, side: "buy", amount: "0.01", paper: true, clientTradeId }, "candle_trade-paper-buy")
    await record(route, first.label, first.child, "candle_get_operation", { clientId: clientTradeId, kind: "trade" }, "candle_get_operation-paper")
    await record(route, first.label, first.child, "candle_get_portfolio", {}, "candle_get_portfolio-after-paper")
    await record(route, second.label, second.child, "candle_get_portfolio", {}, "candle_get_portfolio-after-other-paper")
  }

  for (const { child, configDir } of running) {
    await child.stop()
    rmSync(configDir, { recursive: true, force: true })
  }
}

console.log(`Done. Copy ${out} into the repo's working copy; it holds account details, so scrub it before anything is committed.`)
process.exit(0)

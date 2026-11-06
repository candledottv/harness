// `candle-harness mcp`, the MCP server a harness runs: the tools (never the transfers), a live trade answering
// APPROVAL_REQUIRED, a swap read back by get_operation, and a core with no view still taking live cards.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { cleanupHomes, startTestCore, type TestCore } from "../../test/core-fixture"

const MOON = "MoonFake11111111111111111111111111111111111"
const MAIN = join(import.meta.dir, "../main.ts")
const cores: TestCore[] = []
const dirs: string[] = []
const clients: Client[] = []
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {})
  for (const c of cores.splice(0)) await c.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
afterAll(cleanupHomes)

function tokenFile(token: string, mode = 0o600): string {
  const dir = mkdtempSync("/tmp/chrn-tok-")
  dirs.push(dir)
  const path = join(dir, "turn.token")
  writeFileSync(path, `${token}\n`, { mode })
  chmodSync(path, mode)
  return path
}

async function setup() {
  const c = await startTestCore()
  cores.push(c)
  const minted = await c.harness()
  const env = { ...(process.env as Record<string, string>), CANDLE_HARNESS_HOME: c.p.configDir }
  return { c, ...minted, env }
}

async function mcpClient(env: Record<string, string>, file: string): Promise<Client> {
  const client = new Client({ name: "test", version: "0" }, { capabilities: {} })
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [MAIN, "mcp", "--token-file", file], env, stderr: "pipe" }))
  clients.push(client)
  return client
}

async function runShim(args: string[], env: Record<string, string>) {
  const proc = Bun.spawn([process.execPath, MAIN, "mcp", ...args], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { stdout, stderr, code }
}

const text = (result: unknown) => JSON.parse(((result as { content: { text: string }[] }).content[0]!).text)

describe("the tools", () => {
  test("the core's tools with Candle's schemas, never the transfers, and the core's instructions", async () => {
    const s = await setup()
    const client = await mcpClient(s.env, tokenFile(s.token))
    const listed = (await client.listTools()).tools
    const names = listed.map((t) => t.name)
    const core = ((await s.client.request("tools.list")).result as { tools: { name: string; inputSchema: unknown }[] }).tools
    expect(names.sort()).toEqual(core.map((t) => t.name).sort())
    expect(names).not.toContain("candle_transfer")
    expect(names).not.toContain("candle_sweep")
    expect(listed.find((t) => t.name === "candle_trade")!.inputSchema).toEqual(core.find((t) => t.name === "candle_trade")!.inputSchema as never)
    expect(client.getInstructions()).toContain("APPROVAL_REQUIRED")
  })

  test("a live trade answers APPROVAL_REQUIRED with its clientTradeId, and the reason reaches the card", async () => {
    const s = await setup()
    const client = await mcpClient(s.env, tokenFile(s.token))
    const answer = text(await client.callTool({ name: "candle_trade", arguments: { mint: MOON, side: "buy", amount: "0.01", reason: "breakout on volume" } }))
    expect(answer.error.code).toBe("APPROVAL_REQUIRED")
    expect(answer.clientTradeId).toMatch(/^[0-9a-f-]{36}$/)
    expect(s.c.core.cards.held(answer.clientTradeId)!.display.why).toBe("breakout on volume")
    const read = text(await client.callTool({ name: "candle_get_operation", arguments: { clientId: answer.clientTradeId, kind: "trade" } }))
    expect(read).toMatchObject({ state: "awaiting_approval", cardId: answer.cardId })
  })

  test("a swap the core issued is read back by get_operation; one it didn't is not held", async () => {
    const s = await setup()
    const client = await mcpClient(s.env, tokenFile(s.token))
    const swap = text(await client.callTool({ name: "candle_swap", arguments: { from: "SOL", to: "USDC", amount: "0.01" } }))
    expect(text(await client.callTool({ name: "candle_get_operation", arguments: { clientId: swap.clientSwapId, kind: "swap" } }))).toMatchObject({ state: "awaiting_approval" })
    expect(text(await client.callTool({ name: "candle_get_operation", arguments: { clientId: "someone-elses", kind: "swap" } })).error.code).toBe("OPERATION_NOT_HELD")
  })

  test("a read runs at once through the core", async () => {
    const s = await setup()
    const client = await mcpClient(s.env, tokenFile(s.token))
    expect(text(await client.callTool({ name: "candle_get_wallets", arguments: {} }))).toMatchObject({ wallets: { solana: { address: expect.any(String) } } })
  })
})

describe("refusing to start", () => {
  test("no token file, or one group or others can read, or a symlink: it exits and says why", async () => {
    const s = await setup()
    const missing = await runShim(["--token-file", "/tmp/chrn-no-such-token"], s.env)
    expect(missing.code).not.toBe(0)
    expect(missing.stderr).toContain("token file")
    const loose = await runShim(["--token-file", tokenFile(s.token, 0o644)], s.env)
    expect(loose.code).not.toBe(0)
    expect(loose.stderr).toContain("0600")
    const real = tokenFile(s.token)
    const link = `${real}.link`
    symlinkSync(real, link)
    const linked = await runShim(["--token-file", link], s.env)
    expect(linked.code).not.toBe(0)
    expect(linked.stderr).toContain("symlink")
    const none = await runShim([], s.env)
    expect(none.code).toBe(2)
    for (const r of [missing, loose, linked, none]) expect(r.stdout).toBe("")
  })

  test("no core: it exits with CORE_NOT_RUNNING on stderr, and never starts one", async () => {
    const s = await setup()
    const file = tokenFile(s.token)
    const env = { ...s.env, CANDLE_HARNESS_HOME: mkdtempSync("/tmp/chrn-empty-") }
    dirs.push(env.CANDLE_HARNESS_HOME)
    const r = await runShim(["--token-file", file], env)
    expect(r.code).toBe(1)
    expect(r.stderr).toContain("CORE_NOT_RUNNING")
  })

  test("a token the core doesn't know: UNAUTHENTICATED on stderr", async () => {
    const s = await setup()
    const r = await runShim(["--token-file", tokenFile("cht_AAAAAAAAAAAA_notreal")], s.env)
    expect(r.code).toBe(1)
    expect(r.stderr).toContain("UNAUTHENTICATED")
  })
})

describe("the token", () => {
  test("never reaches stdout, and is never an argument", async () => {
    const s = await setup()
    const file = tokenFile(s.token)
    const args = [MAIN, "mcp", "--token-file", file]
    expect(args.join(" ")).not.toContain(s.token)
    const proc = Bun.spawn([process.execPath, ...args], { env: s.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
    const send = (m: unknown) => proc.stdin.write(`${JSON.stringify(m)}\n`)
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } } })
    send({ jsonrpc: "2.0", method: "notifications/initialized" })
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" })
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "candle_trade", arguments: { mint: MOON, side: "buy", amount: "0.01" } } })
    let out = ""
    const reader = proc.stdout.getReader()
    const decoder = new TextDecoder()
    while (!out.includes('"id":3')) {
      const { value, done } = await reader.read()
      if (done) break
      out += decoder.decode(value)
    }
    proc.kill()
    await proc.exited
    expect(out).toContain("APPROVAL_REQUIRED")
    expect(out).not.toContain(s.token)
    expect(out).not.toContain(s.tokenId.slice(0, 12) + "_")
  })
})

test("mcp --empty (the doctor's turns): no tools, no core, no token, and it ends with its stdin", async () => {
  const client = new Client({ name: "test", version: "0" }, { capabilities: {} })
  const transport = new StdioClientTransport({ command: process.execPath, args: [MAIN, "mcp", "--empty"], env: { PATH: process.env.PATH ?? "", HOME: "/nonexistent" }, stderr: "pipe" })
  await client.connect(transport)
  expect((await client.listTools()).tools).toEqual([])
  const pid = transport.pid!
  await client.close()
  for (let i = 0; i < 50 && isAlive(pid); i++) await Bun.sleep(20)
  expect(isAlive(pid)).toBe(false)
})

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

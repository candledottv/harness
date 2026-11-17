// Offline counterpart of test/record-candle.ts for an unreleased source revision.
// Uses the real server's tools/list, never tools/call. Global network is denied;
// profile eligibility is a local GET-only stub, not a credential or login bypass.
//   bun scripts/read-mcp-source.ts <candle-monorepo checkout>
// The checkout needs its own dependencies installed. Release pinning remains pin-cli.ts's job.
import { spawnSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { toolFixture } from "./scrub-recordings"

const checkout = resolve(process.argv[2] ?? "")
if (!process.argv[2]) throw new Error("usage: bun scripts/read-mcp-source.ts <candle-monorepo checkout>")
const git = (...args: string[]) => {
  const result = spawnSync("git", ["-C", checkout, ...args], { encoding: "utf8" })
  if (result.status !== 0) throw new Error(`source git check failed: ${result.stderr}`)
  return result.stdout.trim()
}
git("diff", "--exit-code", "HEAD", "--", "packages/cli", "packages/sdk", "packages/mcp")
const commit = git("rev-parse", "HEAD")
const cliVersion = JSON.parse(readFileSync(join(checkout, "packages/cli/package.json"), "utf8")).version as string
const source = { repo: "candledottv/candle-monorepo", commit, cliVersion, method: "in-memory tools/list; local eligibility stub; no tool calls" }
const load = (path: string) => import(pathToFileURL(join(checkout, "packages/mcp/src", path)).href)
const originalFetch = globalThis.fetch
globalThis.fetch = (() => { throw new Error("source recording may not access the network") }) as unknown as typeof fetch
try {
  const { createCandleMcpServer } = await load("server.ts")
  const { registerEligibleProfileTool } = await load("tools.ts")
  const { LAUNCH_DEFINITION } = await load("launch-definition.ts")
  const cfg = { apiUrl: "https://api.test", apiKey: "fixture-only-not-a-key" }
  const server = createCandleMcpServer({}, cfg)
  const client = new Client({ name: "harness-source-recorder", version: "1" })
  try {
    await registerEligibleProfileTool(server, {}, async (url: string, init?: RequestInit) => {
      if (url !== "https://api.test/api/v1/agent/keys/self/public-profile" || init?.method !== "GET") throw new Error("unexpected eligibility request")
      return { ok: true, status: 200, text: async () => JSON.stringify({ canEdit: true }) }
    }, cfg)
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(b)
    await client.connect(a)
    const tools = (await client.listTools()).tools
    const fixture = toolFixture({ status: client.getServerVersion(), tools } as never, new Date().toISOString().slice(0, 10)) as Record<string, unknown>
    fixture.about = `Source tools/list from ${source.repo} at ${commit} (CLI ${cliVersion}), via the real MCP server and an in-memory transport. No external requests or tool calls. Profile discovery used a local GET-only eligibility stub; the four listedAfterKeyCheck tools remain conditional. Scrubbed with scripts/scrub-recordings.ts toolFixture. This is a source contract recording, not evidence of a published CLI release.`
    fixture.source = source
    const root = join(import.meta.dir, "..")
    writeFileSync(join(root, "test/fixtures/candle-tools.json"), `${JSON.stringify(fixture, null, 2)}\n`)
    writeFileSync(join(root, "src/core/launch-quotes.json"), `${JSON.stringify({ source, fixedPairs: LAUNCH_DEFINITION.quoteSelection.fixedPairs }, null, 2)}\n`)
    console.log(`Recorded ${tools.length} tools and fixed launch pairs from ${commit}; no network or tool calls.`)
  } finally {
    await client.close()
    await server.close()
  }
} finally {
  globalThis.fetch = originalFetch
}

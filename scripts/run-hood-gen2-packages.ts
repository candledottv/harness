// Hood generation 2 launch options (BE-4351, the harness sibling of BE-4350, candle-monorepo #4291) recorded from the
// PUBLISHED npm packages (`scripts/hood-gen2-packages.json`): `@candledottv/agent-sdk` 0.6.41, `@candledottv/cli`
// 0.13.50, `@candledottv/mcp` 0.10.48.
//   - SDK: `dryRunLaunch()` (and one `launch()`) run over an intercepted fetch.
//   - CLI: `candle launch --dry-run --json` is spawned from the shipped bin with an offline fetch preload.
//   - MCP: `candle_launch_token` is called over stdio against the shipped bin with the same preload.
// The five gen 2 options go out as the API's TOP-LEVEL keys (snipeExempt, feeWallet, creatorFeeBps, teamAllocation,
// launchRules); a `hoodGen2Options` wrapper is never sent. MCP withholds feeWallet (kept by BE-4350), so it refuses it.
// Packages install from the npm registry when no `<dir>` is passed (the only network use); every Candle API call is
// answered in memory, the launches are dry runs or stubbed responses. No wallet, key or account value: made-up ids only.
//   bun scripts/run-hood-gen2-packages.ts            installs the pins into a temp dir, writes the fixture
//   bun scripts/run-hood-gen2-packages.ts <dir>      reuses a dir that already holds the pinned install
import { strict as assert } from "node:assert"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

const pins = JSON.parse(readFileSync(join(import.meta.dir, "hood-gen2-packages.json"), "utf8")) as Record<string, string>
const PRELOAD = join(import.meta.dir, "hood-gen2-preload.ts")
const workDir = mkdtempSync(join(tmpdir(), "hood-gen2-pkgs-"))
const installDir = process.argv[2] ? resolve(process.argv[2]) : join(workDir, "install")

const API = "https://api.fixture.test"
const KEY = "fixture-only-not-a-key"
const IMAGE = "https://img.fixture.test/a.png"
const ID = "cl-fixture-1"
const A = (n: number) => `0x${String(n).repeat(40)}`
const WRAPPER = "hoodGen2Options"
const TOP_KEYS = ["snipeExempt", "feeWallet", "creatorFeeBps", "teamAllocation", "launchRules"]

type Call = { method: string; path: string; body: Record<string, any> | null }
type Row = { id: string; scenario: string; surface: "sdk" | "cli" | "mcp" | "package-text"; args: Record<string, unknown>; outcome: Record<string, unknown> }
const rows: Row[] = []
const record = (id: string, scenario: string, surface: Row["surface"], args: Row["args"], outcome: Row["outcome"]) => rows.push({ id, scenario, surface, args, outcome })

// Each gen 2 option as the wire fragment, plus the CLI flags that must produce it. `mcp: false` = not offered on MCP.
const hoodCases: { id: string; fragment: Record<string, unknown>; flags: string[]; mcp: boolean }[] = [
  { id: "snipe-exempt", fragment: { snipeExempt: [A(1), A(2)] }, flags: ["--snipe-exempt", `${A(1)},${A(2)}`], mcp: true },
  { id: "snipe-exempt-empty", fragment: { snipeExempt: [] }, flags: ["--snipe-exempt", ""], mcp: true },
  { id: "fee-wallet", fragment: { feeWallet: A(3), creatorFeeBps: 150 }, flags: ["--fee-wallet", A(3), "--creator-fee-bps", "150"], mcp: false },
  { id: "creator-fee-bps", fragment: { creatorFeeBps: 150 }, flags: ["--creator-fee-bps", "150"], mcp: true },
  { id: "creator-fee-bps-zero", fragment: { creatorFeeBps: 0 }, flags: ["--creator-fee-bps", "0"], mcp: true },
  {
    id: "team-allocation",
    fragment: { teamAllocation: { recipient: A(4), percent: 2.5, cliffDays: 30, vestingDays: 90 } },
    flags: ["--team-recipient", A(4), "--team-percent", "2.5", "--team-cliff-days", "30", "--team-vesting-days", "90"],
    mcp: true,
  },
  {
    id: "launch-rules-sniper-fee",
    fragment: { launchRules: { snipeFeeStartBps: 500, snipeFeeDecaySecs: 60 } },
    flags: ["--snipe-fee-start-bps", "500", "--snipe-fee-decay", "60"],
    mcp: true,
  },
  {
    id: "launch-rules-open-cap-allowlist",
    fragment: {
      launchRules: {
        openDelaySecs: 5400,
        maxBuyPerWalletRaw: "500000000000000000",
        capWindowSecs: 3600,
        allowlist: [A(5), A(6)],
        allowlistWindowSecs: 1800,
        devBuyMaxRaw: "100000000000000000",
      },
      buyAmount: "100000000000000000",
    },
    flags: ["--open-in", "90m", "--max-buy-per-wallet", "0.5", "--cap-window", "1h", "--allowlist", "<allowlist-file>", "--allowlist-window", "30m", "--dev-buy-max", "0.1", "--buy", "0.1"],
    mcp: true,
  },
  {
    id: "all-options-together",
    fragment: {
      snipeExempt: [A(1)],
      feeWallet: A(3),
      creatorFeeBps: 150,
      teamAllocation: { recipient: A(4), percent: 2.5, cliffDays: 30, vestingDays: 90 },
      launchRules: { snipeFeeStartBps: 500, snipeFeeDecaySecs: 60 },
    },
    flags: ["--snipe-exempt", A(1), "--fee-wallet", A(3), "--creator-fee-bps", "150", "--team-recipient", A(4), "--team-percent", "2.5", "--team-cliff-days", "30", "--team-vesting-days", "90", "--snipe-fee-start-bps", "500", "--snipe-fee-decay", "60"],
    mcp: false,
  },
]

const originalFetch = globalThis.fetch
try {
  if (!process.argv[2]) {
    mkdirSync(installDir, { recursive: true })
    writeFileSync(join(installDir, "package.json"), `${JSON.stringify({ name: "hood-gen2-published", private: true, type: "module" })}\n`)
    const add = Bun.spawnSync([process.execPath, "add", "--exact", "--ignore-scripts", ...Object.entries(pins).map(([n, v]) => `${n}@${v}`)], { cwd: installDir, stderr: "pipe", stdout: "pipe" })
    if (add.exitCode !== 0) throw new Error(`install of the pinned packages failed: ${add.stderr.toString()}`)
  }
  globalThis.fetch = (() => {
    throw new Error("hood gen 2 package recording may not access the network")
  }) as unknown as typeof fetch

  const pkgDir = (name: string) => join(installDir, "node_modules", name)
  const manifest = (name: string) => JSON.parse(readFileSync(join(pkgDir(name), "package.json"), "utf8"))
  const lockText = existsSync(join(installDir, "bun.lock")) ? readFileSync(join(installDir, "bun.lock"), "utf8") : ""
  const packages = Object.fromEntries(
    Object.entries(pins).map(([name, version]) => {
      assert.equal(manifest(name).version, version, `${name} must be installed at the pinned ${version}`)
      const integrity = lockText.match(new RegExp(`"${name}@${version.replace(/\./g, "\\.")}", "[^"]*", [^\\n]*?"(sha512-[^"]+)"`))?.[1]
      return [name, { version, ...(integrity ? { integrity } : {}) }]
    }),
  )
  const SDK_ENTRY = join(pkgDir("@candledottv/agent-sdk"), manifest("@candledottv/agent-sdk").main)
  const MCP_ENTRY = join(pkgDir("@candledottv/mcp"), manifest("@candledottv/mcp").bin["candle-mcp"])
  const CLI_ENTRY = join(pkgDir("@candledottv/cli"), manifest("@candledottv/cli").bin.candle)
  const { CandleClient } = await import(pathToFileURL(SDK_ENTRY).href)
  assert.equal(typeof CandleClient, "function")

  const allowlistFile = join(workDir, "allowlist.txt")
  writeFileSync(allowlistFile, `${A(5)}\n${A(6)}\n`)
  const configDir = join(workDir, "config")
  mkdirSync(configDir, { recursive: true, mode: 0o700 })

  // ---- SDK ---------------------------------------------------------------------------------------------------
  const sdkClient = (calls: Call[]) =>
    new CandleClient({
      apiUrl: API,
      apiKey: KEY,
      maxRetries: 0,
      fetch: (async (input: unknown, init?: RequestInit) => {
        const call = { method: init?.method ?? "GET", path: String(input).replace(API, ""), body: init?.body ? JSON.parse(String(init.body)) : null }
        calls.push(call)
        return Response.json({ success: true, dryRun: true, wouldLaunch: true, clientLaunchId: ID })
      }) as unknown as typeof fetch,
    })
  const refusal = async (f: () => Promise<unknown>) => {
    try {
      await f()
      return null
    } catch (e) {
      return { code: (e as { code?: string }).code ?? null, message: (e as Error).message.slice(0, 200) }
    }
  }
  const sdkBase = (chain: "hood" | "solana") => ({ name: "T", symbol: "TT", imageUrl: IMAGE, clientLaunchId: ID, chain, ...(chain === "hood" ? { quoteAsset: "eth", dexVersion: "v3" } : {}) })
  const wireBase = (chain: "hood" | "solana") => ({ clientLaunchId: ID, name: "T", symbol: "TT", imageUrl: IMAGE, chain, ...(chain === "hood" ? { quoteAsset: "eth", dexVersion: "v3" } : {}) })
  const sameJson = (got: unknown, want: unknown, what: string) => assert.deepEqual(JSON.parse(JSON.stringify(got)), JSON.parse(JSON.stringify(want)), what)
  const keysOf = (b: Record<string, any> | null) => Object.keys(b ?? {}).sort()
  const noWrapper = (b: Record<string, any> | null) => assert.ok(b && !(WRAPPER in b), "no hoodGen2Options wrapper may be sent")

  for (const c of hoodCases) {
    const calls: Call[] = []
    const client = sdkClient(calls)
    await client.dryRunLaunch({ ...sdkBase("hood"), ...c.fragment })
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.path, "/api/v1/launch/headless/dry-run")
    sameJson(calls[0]!.body, { ...wireBase("hood"), ...c.fragment }, `sdk ${c.id} body`)
    noWrapper(calls[0]!.body)
    record(`sdk-hood-dry-run-${c.id}`, "hood-body", "sdk", { method: "dryRunLaunch", options: Object.keys(c.fragment) }, { path: calls[0]!.path, body: calls[0]!.body, topLevelKeys: TOP_KEYS.filter((k) => k in (calls[0]!.body ?? {})), wrapperSent: false })
  }
  {
    const calls: Call[] = []
    const all = hoodCases.find((c) => c.id === "all-options-together")!.fragment
    await sdkClient(calls).launch({ ...sdkBase("hood"), ...all })
    const post = calls.find((c) => c.path === "/api/v1/launch/headless")
    assert.ok(post)
    sameJson(post.body, { ...wireBase("hood"), ...all }, "sdk launch() body")
    noWrapper(post.body)
    record("sdk-hood-launch-all-options-stubbed", "hood-body", "sdk", { method: "launch (stubbed response, no spend)" }, { path: post.path, body: post.body, wrapperSent: false })
  }
  {
    const calls: Call[] = []
    const c = sdkClient(calls)
    const out = {
      wrapper: await refusal(() => c.dryRunLaunch({ ...sdkBase("hood"), [WRAPPER]: { snipeExempt: [] } })),
      unknownRule: await refusal(() => c.dryRunLaunch({ ...sdkBase("hood"), launchRules: { notARule: 1 } })),
      unknownTeamKey: await refusal(() => c.dryRunLaunch({ ...sdkBase("hood"), teamAllocation: { recipient: A(4), percent: 1, cliffDays: 30, bogus: 1 } })),
      creatorFeeOver: await refusal(() => c.dryRunLaunch({ ...sdkBase("hood"), creatorFeeBps: 10000 })),
      feeStack: await refusal(() => c.dryRunLaunch({ ...sdkBase("hood"), creatorFeeBps: 9800, launchRules: { snipeFeeStartBps: 100, snipeFeeDecaySecs: 60 } })),
    }
    for (const v of Object.values(out)) assert.ok(v, "expected a refusal")
    assert.equal(calls.length, 0)
    record("sdk-hood-refusals-send-nothing", "hood-refusal", "sdk", { cases: Object.keys(out) }, { ...out, requests: calls.length })
  }

  // Solana through the SDK: Hood-only fields refused (explicit null included), creatorFeeBps: null accepted, body unchanged.
  const solanaRefusals: Record<string, Record<string, unknown>> = {
    snipeExempt: { snipeExempt: [A(1)] },
    "snipeExempt-null": { snipeExempt: null },
    teamAllocation: { teamAllocation: { recipient: A(4), percent: 1, cliffDays: 30 } },
    "teamAllocation-null": { teamAllocation: null },
    "launchRules.snipeFeeStartBps": { launchRules: { snipeFeeStartBps: 100 } },
    "launchRules.snipeFeeStartBps-null": { launchRules: { snipeFeeStartBps: null } },
    "launchRules.snipeFeeDecaySecs": { launchRules: { snipeFeeDecaySecs: 60 } },
    "launchRules.snipeFeeDecaySecs-null": { launchRules: { snipeFeeDecaySecs: null } },
    "creatorFeeBps-150": { creatorFeeBps: 150 },
  }
  {
    const calls: Call[] = []
    const c = sdkClient(calls)
    const out: Record<string, unknown> = {}
    for (const [name, extra] of Object.entries(solanaRefusals)) {
      const r = await refusal(() => c.dryRunLaunch({ ...sdkBase("solana"), ...extra }))
      assert.ok(r, `solana ${name} must be refused`)
      out[name] = r
    }
    assert.equal(calls.length, 0)
    record("sdk-solana-hood-only-fields-refused", "solana-refusal", "sdk", { cases: Object.keys(solanaRefusals) }, { refusals: out, requests: calls.length })
  }
  {
    const calls: Call[] = []
    const c = sdkClient(calls)
    await c.dryRunLaunch({ ...sdkBase("solana"), creatorFeeBps: null })
    await c.dryRunLaunch({ ...sdkBase("solana") })
    sameJson(calls[0]!.body, { ...wireBase("solana"), creatorFeeBps: null }, "sdk solana creatorFeeBps null")
    sameJson(calls[1]!.body, wireBase("solana"), "sdk solana baseline")
    record("sdk-solana-creator-fee-bps-null-accepted", "solana-body", "sdk", { creatorFeeBps: null }, { body: calls[0]!.body })
    record("sdk-solana-body-unchanged", "solana-body", "sdk", {}, { body: calls[1]!.body, hoodOnlyKeysPresent: TOP_KEYS.filter((k) => k in (calls[1]!.body ?? {})) })
  }

  // ---- shipped processes (CLI, MCP) --------------------------------------------------------------------------
  let seq = 0
  const baseEnv = (log: string) => ({
    PATH: process.env.PATH ?? "",
    HOME: join(workDir, "home"),
    TZ: "UTC",
    CANDLE_PLAIN: "1",
    CANDLE_NO_UPDATE_NOTIFIER: "1",
    CANDLE_API_URL: API,
    CANDLE_API_KEY: KEY,
    CANDLE_CONFIG_DIR: configDir,
    HOOD_GEN2_LOG: log,
  })
  type Wire = { n: number; method: string; host: string; path: string; body: Record<string, any> | null }
  const readLog = (log: string): Wire[] => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [])
  // The MCP server reads the key's public profile once at start-up; that is not part of a launch call.
  const launchCalls = (log: string) => readLog(log).filter((c) => !c.path.endsWith("/keys/self/public-profile"))
  const wireOf = (calls: Wire[]) => calls.map((c) => ({ method: c.method, path: c.path }))

  const runCli = async (flags: string[]) => {
    const log = join(workDir, `cli-${seq++}.log`)
    const proc = Bun.spawn([process.execPath, "--preload", PRELOAD, CLI_ENTRY, "launch", "--wallet", "embedded", "--name", "T", "--symbol", "TT", "--image-url", IMAGE, "--client-trade-id", ID, "--dry-run", "--json", "--yes", ...flags.map((f) => (f === "<allowlist-file>" ? allowlistFile : f))], {
      env: baseEnv(log), stdout: "pipe", stderr: "pipe", stdin: "ignore",
    })
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    return { exitCode, stdout, stderr, calls: launchCalls(log).filter((c) => !c.path.endsWith("/wallets/embedded")) }
  }
  const hoodFlags = ["--quote-asset", "eth", "--dex-version", "v3"]
  for (const c of hoodCases) {
    const r = await runCli([...hoodFlags, ...c.flags])
    assert.equal(r.exitCode, 0, `cli ${c.id}: ${r.stdout}${r.stderr}`)
    assert.equal(r.calls.length, 1)
    assert.equal(r.calls[0]!.path, "/api/v1/launch/headless/dry-run")
    sameJson(r.calls[0]!.body, { ...wireBase("hood"), ...c.fragment }, `cli ${c.id} body`)
    noWrapper(r.calls[0]!.body)
    record(`cli-hood-dry-run-${c.id}`, "hood-body", "cli", { flags: c.flags.map((f) => (f === "<allowlist-file>" ? f : f)) }, { exitCode: r.exitCode, path: r.calls[0]!.path, body: r.calls[0]!.body, topLevelKeys: TOP_KEYS.filter((k) => k in (r.calls[0]!.body ?? {})), wrapperSent: false })
  }
  {
    const cases: Record<string, string[]> = {
      "team-percent": ["--team-percent", "2"],
      "snipe-exempt": ["--snipe-exempt", A(1)],
      "snipe-fee-start-bps": ["--snipe-fee-start-bps", "100", "--snipe-fee-decay", "60"],
      "creator-fee-bps-150": ["--mode", "exp-a", "--creator-fee-bps", "150"],
    }
    const out: Record<string, unknown> = {}
    for (const [name, flags] of Object.entries(cases)) {
      const r = await runCli(["--quote-asset", "sol", ...flags])
      assert.notEqual(r.exitCode, 0, `cli solana ${name} must be refused`)
      assert.equal(r.calls.length, 0, `cli solana ${name} must send nothing`)
      out[name] = { exitCode: r.exitCode, message: String(JSON.parse(r.stdout || "{}").message ?? r.stderr).split(" Usage:")[0]!.slice(0, 200) }
    }
    record("cli-solana-hood-only-flags-refused", "solana-refusal", "cli", { cases: Object.keys(cases) }, { refusals: out, requests: 0 })
    const ok = await runCli(["--quote-asset", "sol", "--mode", "exp-a", "--creator-fee-bps", "100"])
    assert.equal(ok.exitCode, 0)
    sameJson(ok.calls[0]!.body, { ...wireBase("solana"), quoteAsset: "sol", mode: "exp-a", creatorFeeBps: 100 }, "cli solana creator fee")
    record("cli-solana-creator-fee-bps-accepted", "solana-body", "cli", { flags: ["--mode", "exp-a", "--creator-fee-bps", "100"] }, { body: ok.calls[0]!.body })
    const base = await runCli(["--quote-asset", "sol"])
    assert.equal(base.exitCode, 0)
    sameJson(base.calls[0]!.body, { ...wireBase("solana"), quoteAsset: "sol" }, "cli solana baseline")
    record("cli-solana-body-unchanged", "solana-body", "cli", {}, { body: base.calls[0]!.body, hoodOnlyKeysPresent: TOP_KEYS.filter((k) => k in (base.calls[0]!.body ?? {})) })
  }

  const callMcp = async (args: Record<string, unknown>) => {
    const log = join(workDir, `mcp-${seq++}.log`)
    const client = new Client({ name: "harness-hood-gen2-packages", version: "1" })
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ["--preload", PRELOAD, MCP_ENTRY], env: baseEnv(log), stderr: "ignore" }))
    let reply: any
    try {
      reply = await client.callTool({ name: "candle_launch_token", arguments: args })
    } finally {
      await client.close()
    }
    const text = String(reply.content?.[0]?.text ?? "")
    return { isError: reply.isError === true, text, calls: launchCalls(log) }
  }
  const mcpBase = (chain: "hood" | "solana") => ({ name: "T", symbol: "TT", imageUrl: IMAGE, clientLaunchId: ID, chain, dryRun: true, ...(chain === "hood" ? { quoteAsset: "eth" } : {}) })
  const mcpWire = (chain: "hood" | "solana") => ({ clientLaunchId: ID, name: "T", symbol: "TT", imageUrl: IMAGE, chain, ...(chain === "hood" ? { quoteAsset: "eth" } : {}) })
  for (const c of hoodCases.filter((x) => x.mcp)) {
    const fragment = c.fragment as Record<string, any>
    const { buyAmount, ...rest } = fragment
    void buyAmount // the first buy (`buy`) is withheld on MCP too (M2_TOP_KEYS)
    const args = { ...mcpBase("hood"), ...rest }
    const r = await callMcp(args)
    assert.equal(r.isError, false, `mcp ${c.id}: ${r.text}`)
    assert.equal(r.calls.length, 1)
    assert.equal(r.calls[0]!.path, "/api/v1/launch/headless/dry-run")
    sameJson(r.calls[0]!.body, { ...mcpWire("hood"), ...rest }, `mcp ${c.id} body`)
    noWrapper(r.calls[0]!.body)
    record(`mcp-hood-dry-run-${c.id}`, "hood-body", "mcp", { tool: "candle_launch_token", options: Object.keys(rest) }, { isError: false, path: r.calls[0]!.path, body: r.calls[0]!.body, topLevelKeys: TOP_KEYS.filter((k) => k in (r.calls[0]!.body ?? {})), wrapperSent: false })
  }

  // MCP check mode: a misplaced or unknown gen 2 key is refused with zero HTTP calls.
  {
    const checkBase = { check: true, chain: "hood" }
    const cases: Record<string, Record<string, unknown>> = {
      "wrapper-hoodGen2Options": { [WRAPPER]: { snipeExempt: [A(1)] } },
      "unknown-top-level-key": { snipeExempt: [A(1)], bogusGen2: 1 },
      "unknown-launchRules-key": { launchRules: { snipeFeeStartBps: 1, notARule: 1 } },
      "unknown-teamAllocation-key": { teamAllocation: { recipient: A(4), percent: 1, cliffDays: 30, bogus: 1 } },
      "snipeExempt-nested-in-launchRules": { launchRules: { snipeExempt: [A(1)] } },
      "feeWallet-withheld-on-mcp": { feeWallet: A(3) },
    }
    const out: Record<string, unknown> = {}
    for (const [name, extra] of Object.entries(cases)) {
      const r = await callMcp({ ...checkBase, ...extra })
      assert.equal(r.isError, true, `mcp check ${name} must be refused: ${r.text}`)
      assert.equal(r.calls.length, 0, `mcp check ${name} must make zero HTTP calls`)
      out[name] = { isError: true, httpCalls: 0, mentionsKey: /hoodGen2Options|bogusGen2|notARule|bogus|snipeExempt|feeWallet/.test(r.text) }
      assert.equal((out[name] as { mentionsKey: boolean }).mentionsKey, true)
    }
    record("mcp-check-refuses-misplaced-or-unknown-gen2-key", "check-refusal", "mcp", { cases: Object.keys(cases) }, { refusals: out })
    const ok = await callMcp({ ...checkBase, snipeExempt: [A(1)], creatorFeeBps: 100 })
    assert.equal(ok.calls.length, 1, "a valid check makes its one preflight read")
    assert.ok(ok.calls[0]!.path.endsWith("/launch/preflight"))
    record("mcp-check-valid-gen2-keys-reach-preflight-only", "check-body", "mcp", { check: true, options: ["snipeExempt", "creatorFeeBps"] }, { requests: wireOf(ok.calls) })
  }
  {
    // Execution (non-check) refusals also send nothing.
    const out: Record<string, unknown> = {}
    for (const [name, extra] of Object.entries({ wrapper: { [WRAPPER]: { snipeExempt: [] } }, unknownKey: { bogusGen2: 1 } })) {
      const r = await callMcp({ ...mcpBase("hood"), ...extra })
      assert.equal(r.isError, true)
      assert.equal(r.calls.length, 0)
      out[name] = { isError: true, httpCalls: 0 }
    }
    record("mcp-hood-launch-refuses-wrapper-and-unknown-key", "hood-refusal", "mcp", { cases: Object.keys(out) }, { refusals: out })
  }

  // MCP on Solana.
  {
    const cases: Record<string, Record<string, unknown>> = { ...solanaRefusals }
    const out: Record<string, unknown> = {}
    for (const [name, extra] of Object.entries(cases)) {
      const r = await callMcp({ ...mcpBase("solana"), ...extra })
      assert.equal(r.isError, true, `mcp solana ${name} must be refused: ${r.text}`)
      assert.equal(r.calls.length, 0, `mcp solana ${name} must send nothing`)
      out[name] = { isError: true, httpCalls: 0 }
    }
    record("mcp-solana-hood-only-fields-refused", "solana-refusal", "mcp", { cases: Object.keys(cases) }, { refusals: out })
    const ok = await callMcp({ ...mcpBase("solana"), creatorFeeBps: null })
    assert.equal(ok.isError, false, ok.text)
    sameJson(ok.calls[0]!.body, { ...mcpWire("solana"), creatorFeeBps: null }, "mcp solana creatorFeeBps null")
    record("mcp-solana-creator-fee-bps-null-accepted", "solana-body", "mcp", { creatorFeeBps: null }, { body: ok.calls[0]!.body })
    const base = await callMcp(mcpBase("solana"))
    assert.equal(base.isError, false, base.text)
    sameJson(base.calls[0]!.body, mcpWire("solana"), "mcp solana baseline")
    record("mcp-solana-body-unchanged", "solana-body", "mcp", {}, { body: base.calls[0]!.body, hoodOnlyKeysPresent: TOP_KEYS.filter((k) => k in (base.calls[0]!.body ?? {})) })
  }

  const serialized = JSON.stringify(rows)
  for (const forbidden of [KEY, "BEGIN", "privateKey", workDir]) assert.ok(!serialized.includes(forbidden), `fixture leaked ${forbidden}`)
  writeFileSync(
    join(import.meta.dir, "../test/fixtures/candle-hood-gen2-packages.json"),
    `${JSON.stringify({
      about: "Offline Hood generation 2 launch-option contracts (BE-4351, the harness sibling of BE-4350 / candle-monorepo #4291) recorded from the published npm packages (@candledottv/agent-sdk 0.6.41, @candledottv/mcp 0.10.48, @candledottv/cli 0.13.50), not a monorepo checkout. Hood rows run each gen 2 option through the SDK (dryRunLaunch, one stubbed launch), the shipped CLI (candle launch --dry-run --json) and the shipped MCP server (candle_launch_token over stdio) and record the request body the API would receive: snipeExempt, feeWallet, creatorFeeBps, teamAllocation and launchRules as TOP-LEVEL keys, never a hoodGen2Options wrapper. MCP withholds feeWallet. Refusal rows send zero launch requests. Solana rows pin that the Hood-only fields are refused (explicit null included, except creatorFeeBps: null) and that a Solana body is otherwise unchanged. Made-up ids only; every fetch is intercepted; no launch reached any network.",
      packages,
      rows,
    }, null, 2)}\n`,
  )
  console.log(`Recorded ${rows.length} offline Hood gen 2 package contracts.`)
} finally {
  globalThis.fetch = originalFetch
  rmSync(workDir, { recursive: true, force: true })
}

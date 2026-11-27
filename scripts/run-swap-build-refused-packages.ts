// Swap build refusal contracts (BE-4462, the harness sibling of BE-4461, candle-monorepo #4279) recorded from the
// PUBLISHED `@candledottv/cli` (`scripts/swap-build-refused-packages.json`, bin `candle`), not a monorepo checkout.
// The API change: `POST /api/v1/agent/swap/build` answers 422 `PRESIGN_SIMULATION_REFUSED` when the pre-sign
// guard's simulation executed the built transaction and refused it; an RPC failure or a simulation error returned
// before execution (the guard could not run) stays 500 `SWAP_FAILED`. The CLI (0.13.49+) keeps `stage`, `reason`,
// `refusal`, `detail`, `cause` and `retryable` of the refusal in the `--json` failure's `details`.
// `candle swap --yes --json` is spawned against an offline fetch preload that answers the build with a recorder
// stand-in envelope using a mapped API code; nothing is signed, submitted or sent over a network.
//   bun scripts/run-swap-build-refused-packages.ts          installs the pin into a temp dir, writes the fixture
//   bun scripts/run-swap-build-refused-packages.ts <dir>    reuses a dir that already holds the pinned install
import { strict as assert } from "node:assert"
import { generateKeyPairSync } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const pins = JSON.parse(readFileSync(join(import.meta.dir, "swap-build-refused-packages.json"), "utf8")) as Record<string, string>
const PRELOAD = join(import.meta.dir, "swap-build-refused-preload.ts")
const workDir = mkdtempSync(join(tmpdir(), "swap-build-refused-pkgs-"))
const installDir = process.argv[2] ? resolve(process.argv[2]) : join(workDir, "install")

const API = "https://api.test"
const KEY = "fixture-only-not-a-key"
const PAYER = "7ZL9FvkpCMgdvzfoMSYZSuCXLCYN25dfgtDXej1BBJaB"
const MINT = "9dXSV8VWuYvGfTzqvkBeoFwH9ihVTybDuWo5VaJPCNDL"
const KEYRING_PASSPHRASE = "fixture-passphrase-not-secret"

const SLIPPAGE_DETAIL =
  'The price moved past maxSlippageBps before the transaction could land; retry at once for a fresh quote, or raise maxSlippageBps (default 100, cap 5000). ({"InstructionError":[3,{"Custom":6001}]}; Program <redacted> failed: custom program error: 0x1771)'
const LAMPORTS_DETAIL = "Transfer: insufficient lamports 900000, need 2039280"
const MESSAGE = "The built transaction failed the pre-sign safety check (simulation_failed); nothing was signed or sent."

const refusal = (code: string, extra: Record<string, unknown>) => ({
  success: false,
  error: { code, message: MESSAGE, retryable: true, stage: "not_broadcast", reason: "presign_refused", refusal: "simulation_failed", ...extra },
})

const cases: { id: string; clientTradeId: string; status: number; apiBody: Record<string, unknown> }[] = [
  { id: "cli-swap-build-422-slippage-exceeded", clientTradeId: "cli-build-422-slip", status: 422, apiBody: refusal("PRESIGN_SIMULATION_REFUSED", { detail: SLIPPAGE_DETAIL, cause: "slippage_exceeded" }) },
  { id: "cli-swap-build-422-insufficient-lamports", clientTradeId: "cli-build-422-lamports", status: 422, apiBody: refusal("PRESIGN_SIMULATION_REFUSED", { detail: LAMPORTS_DETAIL, cause: "insufficient_lamports" }) },
  { id: "cli-swap-build-422-no-cause", clientTradeId: "cli-build-422-nocause", status: 422, apiBody: refusal("PRESIGN_SIMULATION_REFUSED", { detail: "InstructionError [2,{\"Custom\":1}]" }) },
  // The guard could not run (RPC failure / BlockhashNotFound before execution): still a 500 SWAP_FAILED, a 5xx outcome.
  { id: "cli-swap-build-500-guard-could-not-run", clientTradeId: "cli-build-500-guard", status: 500, apiBody: refusal("SWAP_FAILED", { detail: "BlockhashNotFound" }) },
]

const rows: { id: string; scenario: string; surface: "cli"; args: Record<string, unknown>; requests: unknown[]; outcome: Record<string, unknown> }[] = []
const scrub = (s: string) => s.replaceAll(PAYER, "<payer>").replaceAll(MINT, "<mint>").replaceAll(KEY, "<key>").replaceAll(workDir, "<tmp>")

try {
  if (!process.argv[2]) {
    mkdirSync(installDir, { recursive: true })
    writeFileSync(join(installDir, "package.json"), `${JSON.stringify({ name: "swap-build-refused-published", private: true, type: "module" })}\n`)
    const add = Bun.spawnSync([process.execPath, "add", "--exact", "--ignore-scripts", ...Object.entries(pins).map(([n, v]) => `${n}@${v}`)], { cwd: installDir, stderr: "pipe", stdout: "pipe" })
    if (add.exitCode !== 0) throw new Error(`install of the pinned packages failed: ${add.stderr.toString()}`)
  }
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
  const CLI_ENTRY = join(pkgDir("@candledottv/cli"), manifest("@candledottv/cli").bin.candle)

  // Throwaway encrypted signer store so the CLI could sign if the build succeeded; it must never get that far.
  const configDir = join(workDir, "config")
  mkdirSync(configDir, { recursive: true, mode: 0o700 })
  {
    const pem = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString()
    const stored = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "")
    const iterations = 1000
    const salt = crypto.getRandomValues(new Uint8Array(16))
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(KEYRING_PASSPHRASE), "PBKDF2", false, ["deriveKey"])
    const key = await crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt"])
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(stored)))
    const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64")
    writeFileSync(join(configDir, "credentials.enc"), JSON.stringify({ wallet_signer_lw_1: { salt: b64(salt), iv: b64(iv), ciphertext: b64(ciphertext), iterations } }), { mode: 0o600 })
  }

  let seq = 0
  for (const c of cases) {
    const log = join(workDir, `cli-${seq++}.log`)
    const proc = Bun.spawn(
      [process.execPath, "--preload", PRELOAD, CLI_ENTRY, "swap", "SOL", MINT, "--amount", "0.05", "--wallet", PAYER, "--rpc-url", "https://rpc.test", "--client-trade-id", c.clientTradeId, "--yes", "--json"],
      {
        env: {
          PATH: process.env.PATH ?? "",
          HOME: join(workDir, "home"),
          TZ: "UTC",
          CANDLE_PLAIN: "1",
          CANDLE_NO_UPDATE_NOTIFIER: "1",
          CANDLE_API_URL: API,
          CANDLE_API_KEY: KEY,
          CANDLE_CONFIG_DIR: configDir,
          CANDLE_KEYRING_PASSPHRASE: KEYRING_PASSPHRASE,
          SWAP_BUILD_REFUSED_SCENARIO: JSON.stringify({ status: c.status, apiBody: c.apiBody }),
          SWAP_BUILD_REFUSED_LOG: log,
        },
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      },
    )
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    const wire = (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []) as { n: number; method: string; host: string; path: string; rpc?: string; unexpected?: boolean }[]
    const json = JSON.parse(scrub(stdout.trim() || "null"))
    assert.ok(json, `${c.id}: no --json output (stderr: ${scrub(stderr).slice(0, 300)})`)
    assert.equal(exitCode, 1, `${c.id}: exit code`)
    // Nothing signed or submitted: no unexpected path, no submit/execute call, no RPC send.
    assert.ok(!wire.some((w) => w.unexpected || /\/swap\/(submit|execute)$/.test(w.path) || w.rpc === "sendTransaction"), `${c.id}: a sign/submit call was made`)
    assert.equal(wire.filter((w) => w.path === "/api/v1/agent/swap/build").length, 1, `${c.id}: exactly one build request`)
    rows.push({
      id: c.id,
      scenario: "cli-package",
      surface: "cli",
      args: { command: "swap SOL <mint> --amount 0.05 --wallet <payer> --yes --json", clientTradeId: c.clientTradeId, apiStatus: c.status, apiBody: JSON.parse(scrub(JSON.stringify(c.apiBody))) },
      requests: wire.map(({ n, method, host, path, rpc }) => ({ n, method, host, path, ...(rpc ? { rpc } : {}) })),
      outcome: { exitCode, json, signedOrSubmitted: false },
    })
  }

  const serialized = JSON.stringify(rows)
  for (const forbidden of [KEY, MINT, PAYER, KEYRING_PASSPHRASE, "BEGIN", workDir]) assert.ok(!serialized.includes(forbidden), `fixture leaked ${forbidden}`)
  writeFileSync(
    join(import.meta.dir, "../test/fixtures/candle-swap-build-refused-packages.json"),
    `${JSON.stringify(
      {
        about: "Offline swap build refusal contracts (BE-4462, the harness sibling of BE-4461 / candle-monorepo #4279) recorded from the published @candledottv/cli, not a monorepo checkout: candle swap --yes --json against recorder stand-in answers using mapped API codes only (422 PRESIGN_SIMULATION_REFUSED with and without cause, and a 500 SWAP_FAILED where the guard could not run). Each row records the exit code, the --json failure with its structured details, and that no sign, submit, execute or RPC send happened. Every fetch is intercepted in memory.",
        packages,
        entryPoints: { cli: manifest("@candledottv/cli").bin.candle },
        rows,
      },
      null,
      2,
    )}\n`,
  )
  console.log(`Recorded ${rows.length} offline swap build refusal contracts (${Object.entries(pins).map(([k, v]) => `${k}@${v}`).join(", ")}).`)
} finally {
  rmSync(workDir, { recursive: true, force: true })
}

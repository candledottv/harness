// Offline `candle tee rebind` onto a key with a signer (BE-4315, harness sibling BE-4316), from an exact clean Candle
// source checkout: how many owner approvals the rebind takes, and where the CLI stops when an API spends the approval
// before it asks for the wallets' owner signatures. Recorded by running the CLI's own `run()` against the CLI's own
// key-signer simulator (`packages/cli/src/commands/__fixtures__/key-signer-sim.ts`), which verifies every owner change
// against the wallet's current owner and issues owner-confirm grants bound to the exact request bytes.
//   1. fixed-api:     signatures asked for before the approval: preview, unsigned 409 (no confirm), signed 403, approved
//                     resend 200. One approval, the wallet is bound and owned by the target signer;
//   2. older-api:     the approval is spent first: preview, unsigned 403, approved resend 409 KEY_SIGNER_SIGNATURE_REQUIRED.
//                     The CLI stops with REBIND_CONFIRM_SPENT, mints no second confirm, changes nothing, and (--json) gives
//                     the code and the advice not to run it again yet;
//   3. owners-changed: on the fixed API a wallet's owner changes while the approval is pending: REBIND_OWNERS_CHANGED, the
//                     approval is not used, no second confirm;
//   4. source:        the two CLI-local codes pinned as source text.
// Every fetch is intercepted: nothing reaches a network, nothing is signed with a real key, and no address, key,
// signature or figure is real.
//   bun scripts/read-rebind-source.ts <candle-monorepo checkout>
// The checkout needs its own dependencies installed.
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { generateKeyPairSync } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const checkout = resolve(process.argv[2] ?? "")
if (!process.argv[2]) throw new Error("usage: bun scripts/read-rebind-source.ts <candle-monorepo checkout>")
const git = (...args: string[]) => {
  const r = spawnSync("git", ["-C", checkout, ...args], { encoding: "utf8" })
  if (r.status !== 0) throw new Error(`source git check failed: ${r.stderr}`)
  return r.stdout.trim()
}
git("diff", "--exit-code", "HEAD", "--", "packages/cli", "packages/sdk", "packages/mcp")
const FILES = [
  "packages/cli/src/commands/tee-rebind.ts",
  "packages/cli/src/client.ts",
  "packages/cli/src/commands/__fixtures__/key-signer-sim.ts",
]
const text = (path: string) => readFileSync(join(checkout, path), "utf8")
const source = {
  repo: "candledottv/candle-monorepo", commit: git("rev-parse", "HEAD"),
  versions: Object.fromEntries(["cli", "mcp", "sdk"].map((p) => [p, JSON.parse(text(`packages/${p}/package.json`)).version])),
  files: FILES,
}
for (const f of FILES) text(f)
const load = (path: string) => import(pathToFileURL(join(checkout, path)).href)
const originalFetch = globalThis.fetch
globalThis.fetch = (() => { throw new Error("rebind recording may not access the network") }) as unknown as typeof fetch

type Row = { id: string; scenario: string; evidence?: string; args: Record<string, unknown>; outcome: Record<string, unknown> }
const rows: Row[] = []
const record = (id: string, scenario: string, args: Record<string, unknown>, outcome: Record<string, unknown>, evidence?: string) =>
  rows.push({ id, scenario, ...(evidence ? { evidence } : {}), args, outcome })

try {
  const { run } = await load("packages/cli/src/index.ts")
  const { SignerSim } = await load("packages/cli/src/commands/__fixtures__/key-signer-sim.ts")
  const { createCapture, createFakeClock, createFakeConfigStore, createFakeStore, createRoutedFetch, createTestDeps } = await load("packages/cli/src/test-support.ts")
  const { pemToStoredSigner, walletSignerRef } = await load("packages/cli/src/secret-store.ts")
  const { humanText } = await load("packages/cli/src/human-output.test-support.ts")

  const FROM = "FromKey1", TO = "ToKey123", DEVICE_TOKEN = "cndl_dvc_owner"
  const pair = () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
    return { pem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(), publicKeyDer: publicKey.export({ format: "der", type: "spki" }).toString("base64") }
  }
  const wallet = (id: string, over: Record<string, unknown>) => ({ id, address: `Addr${id}`, label: id.toLowerCase(), privyWalletId: `pw-${id}`, boundKeyPrefix: FROM, owner: over.recorded, ...over })
  const phase = (b: any) => (b.dryRun === true ? "preview" : b.owner ? "signed" : "unsigned")
  const machine = (sim: any, opts: { secrets: string[]; lines: string[]; store?: Record<string, string> }) => {
    const { fetch } = createRoutedFetch(sim.routes())
    const stdout = createCapture(), stderr = createCapture()
    const store = createFakeStore({ device_token: DEVICE_TOKEN, ...(opts.store ?? {}) })
    const config = createFakeConfigStore({})
    const clock = createFakeClock(1_000)
    const secrets = [...opts.secrets], lines = [...opts.lines]
    const deps = createTestDeps({
      fetch, store, stdout, stderr, now: clock.now, sleep: clock.sleep, env: {},
      readConfig: config.readConfig, writeConfig: config.writeConfig, clearConfig: config.clearConfig, updateProfile: config.updateProfile,
      promptSecret: async () => { throw new Error("Fingerprint must use the visible prompt") },
      promptLine: async (t: string) => (t.startsWith("Type the full fingerprint") ? (secrets.shift() ?? "") : (lines.shift() ?? "")),
      writeFile: async () => {},
    })
    return { deps, stdout, stderr }
  }
  /** A sim with one wallet on FROM that the legacy signer owns, and a key TO with an active signer. */
  const setup = (mode: "gate-first" | "signatures-first") => {
    const sim = new SignerSim(() => 0)
    const legacy = pair(), target = pair()
    sim.addKey({ keyPrefix: FROM })
    sim.addKey({ keyPrefix: TO, label: "tr-2", active: sim.signer(target.publicKeyDer, "q-to") })
    sim.quorumFor(legacy.publicKeyDer, "q-leg")
    sim.wallets.push(wallet("W1", { recorded: "q-leg" }))
    sim.ownerConfirm = mode
    const fingerprint = sim.keys.get(TO).active.fingerprint as string
    const h = machine(sim, { secrets: [fingerprint], lines: ["confirm"], store: { [walletSignerRef("W1")]: pemToStoredSigner(legacy.pem) } })
    return { sim, h, legacy, fingerprint }
  }
  const stderrOf = (h: any) => humanText(h.stderr.text) as string
  const walletOf = (sim: any) => ({ boundTo: sim.wallets[0].boundKeyPrefix === TO ? "target-key" : "original-key", owner: sim.wallets[0].owner })

  // 1. Fixed API: signatures before the approval, so one approval finishes.
  {
    const { sim, h } = setup("signatures-first")
    const exit = await run(["tee", "rebind", "W1", "--to-key", TO], h.deps)
    assert.equal(exit, 0)
    assert.deepEqual(sim.rebinds.map(phase), ["preview", "unsigned", "signed", "signed"])
    assert.equal(sim.confirms.length, 1)
    assert.equal(sim.confirms[0].redeemed, true)
    assert.ok("W1" in JSON.parse(sim.confirms[0].body).owner)
    assert.equal(h.stderr.text.match(/Code: /g)?.length, 1)
    assert.equal(sim.wallets[0].boundKeyPrefix, TO)
    assert.equal(sim.wallets[0].owner, "q-to")
    record("fixed-api-one-approval", "fixed-api", { argv: ["tee", "rebind", "<wallet>", "--to-key", "<key>"], api: "signatures asked for before the approval" },
      { exitCode: exit, requests: sim.rebinds.map(phase), confirmsIssued: sim.confirms.length, confirmsRedeemed: sim.confirms.filter((c: any) => c.redeemed).length, approvalPrompts: h.stderr.text.match(/Code: /g)?.length, signedWallets: Object.keys(JSON.parse(sim.confirms[0].body).owner).length, wallet: { boundTo: "target-key", owner: "target-signer" } })
  }

  // 2. Older API: the approval is spent before the signatures are asked for.
  {
    const { sim, h, fingerprint, legacy } = setup("gate-first")
    const exit = await run(["tee", "rebind", "W1", "--to-key", TO], h.deps)
    assert.equal(exit, 1)
    assert.deepEqual(sim.rebinds.map(phase), ["preview", "unsigned", "unsigned"])
    assert.deepEqual(sim.confirms.map((c: any) => c.redeemed), [true])
    assert.equal(h.stderr.text.match(/Code: /g)?.length, 1)
    const err = stderrOf(h)
    assert.ok(err.includes(humanText("Approved, but the server then asked for the wallets' owner signatures")))
    assert.ok(err.includes(humanText("nothing changed and nothing more was sent")))
    assert.ok(err.includes(humanText("Do not run it again yet")))
    assert.ok(err.includes(humanText("Once the API carries the BE-4315 fix")))
    assert.ok(!h.stderr.text.slice(h.stderr.text.indexOf("Approved. Sending the request again.")).includes("Run the same command again"))
    assert.deepEqual(walletOf(sim), { boundTo: "original-key", owner: "q-leg" })
    record("older-api-confirm-spent", "older-api", { argv: ["tee", "rebind", "<wallet>", "--to-key", "<key>"], api: "approval spent before the signatures are asked for" },
      { exitCode: exit, requests: sim.rebinds.map(phase), confirmsIssued: sim.confirms.length, confirmsRedeemed: sim.confirms.filter((c: any) => c.redeemed).length, approvalPrompts: h.stderr.text.match(/Code: /g)?.length,
        says: ["Approved, but the server then asked for the wallets' owner signatures", "nothing changed and nothing more was sent", "Do not run it again yet", "Once the API carries the BE-4315 fix"],
        wallet: { boundTo: "original-key", owner: "legacy-signer" } })

    const j = machine(sim, { secrets: [fingerprint], lines: ["confirm"], store: { [walletSignerRef("W1")]: pemToStoredSigner(legacy.pem) } })
    const before = sim.confirms.length
    const jexit = await run(["tee", "rebind", "W1", "--to-key", TO, "--json"], j.deps)
    assert.equal(jexit, 1)
    const doc = JSON.parse(j.stdout.text.trim().split("\n").at(-1) as string)
    assert.equal(doc.code ?? doc.error?.code, "REBIND_CONFIRM_SPENT")
    assert.ok(String(doc.suggestion).startsWith("Do not run it again yet"))
    record("older-api-confirm-spent-json", "older-api", { argv: ["tee", "rebind", "<wallet>", "--to-key", "<key>", "--json"], api: "approval spent before the signatures are asked for" },
      { exitCode: jexit, code: "REBIND_CONFIRM_SPENT", suggestionStartsWith: "Do not run it again yet", newConfirmsIssued: sim.confirms.length - before, wallet: { boundTo: "original-key", owner: "legacy-signer" } },
      "each further run on the older API issues and spends one more approval and stops at the same place: the advice is to wait for the fix")
  }

  // 3. Fixed API, a wallet's owner changes while the approval is pending.
  {
    const sim = new SignerSim(() => 0)
    const target = pair()
    sim.addKey({ keyPrefix: FROM })
    sim.addKey({ keyPrefix: TO, label: "tr-2", active: sim.signer(target.publicKeyDer, "q-to") })
    sim.wallets.push(wallet("W1", { recorded: "q-to", owner: "q-to" }))
    sim.ownerConfirm = "signatures-first"
    sim.onApprove = () => { sim.wallets[0].owner = "q-elsewhere" }
    const h = machine(sim, { secrets: [sim.keys.get(TO).active.fingerprint], lines: ["confirm"] })
    const exit = await run(["tee", "rebind", "W1", "--to-key", TO], h.deps)
    assert.equal(exit, 1)
    assert.deepEqual(sim.rebinds.map(phase), ["preview", "unsigned", "unsigned"])
    assert.deepEqual(sim.confirms.map((c: any) => c.redeemed), [false])
    assert.equal(h.stderr.text.match(/Code: /g)?.length, 1)
    assert.ok(stderrOf(h).includes(humanText("refused before using it")))
    assert.equal(sim.wallets[0].boundKeyPrefix, FROM)
    record("fixed-api-owners-changed", "owners-changed", { argv: ["tee", "rebind", "<wallet>", "--to-key", "<key>"], api: "signatures asked for before the approval; a wallet's owner changes while it is pending" },
      { exitCode: exit, requests: sim.rebinds.map(phase), confirmsIssued: sim.confirms.length, confirmsRedeemed: sim.confirms.filter((c: any) => c.redeemed).length, approvalPrompts: h.stderr.text.match(/Code: /g)?.length, says: ["refused before using it"], wallet: { boundTo: "original-key", owner: "changed-elsewhere" } })
  }

  // 4. Source text: the two CLI-local codes and the field the client reads off the refusal.
  {
    const rebind = text("packages/cli/src/commands/tee-rebind.ts")
    const codes = [...rebind.matchAll(/export const (REBIND_[A-Z_]+) = "([A-Z_]+)"/g)].map((m) => ({ name: m[1], code: m[2] }))
    assert.deepEqual(codes, [{ name: "REBIND_CONFIRM_SPENT", code: "REBIND_CONFIRM_SPENT" }, { name: "REBIND_OWNERS_CHANGED", code: "REBIND_OWNERS_CHANGED" }])
    assert.ok(/first\.code !== "KEY_SIGNER_SIGNATURE_REQUIRED"/.test(rebind))
    assert.ok(/first\.ownerConfirmed === "spent"/.test(rebind) && /first\.ownerConfirmed === "unspent"/.test(rebind))
    const client = text("packages/cli/src/client.ts")
    assert.ok(/ownerConfirmed\?: "spent" \| "unspent"/.test(client))
    record("source-cli-local-codes", "source", { file: "packages/cli/src/commands/tee-rebind.ts" }, { codes, stopsOn: "KEY_SIGNER_SIGNATURE_REQUIRED after an approved resend", spent: "REBIND_CONFIRM_SPENT", unspent: "REBIND_OWNERS_CHANGED" }, "pinned as source text: the codes are CLI-local, the server never sends them")
  }

  const out = JSON.stringify(rows)
  for (const secret of ["BEGIN", "cndl_", DEVICE_TOKEN]) assert.ok(!out.includes(secret), `a fixture carries ${secret}`)
  writeFileSync(join(import.meta.dir, "../test/fixtures/candle-rebind-source.json"), `${JSON.stringify({
    about: "Offline `candle tee rebind` onto a key with a signer (BE-4315, harness sibling BE-4316): one owner approval on the fixed API, and the CLI-local stops REBIND_CONFIRM_SPENT (an older API used the approval before asking for the owner signatures) and REBIND_OWNERS_CHANGED. Recorded by running the CLI's own run() against its own key-signer simulator, from the published release commit (CLI 0.13.47, MCP 0.10.45, SDK 0.6.39); every fetch is intercepted.",
    source, rows,
  }, null, 2)}\n`)
  console.log(`Recorded ${rows.length} offline rebind contracts from ${source.commit}.`)
} finally { globalThis.fetch = originalFetch }

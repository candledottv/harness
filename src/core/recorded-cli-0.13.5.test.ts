// The contract with Candle at CLI 0.13.5 and its MCP server 0.10.25, recorded against production on
// 2026-11-01 and scrubbed into test/fixtures/candle-recorded/cli-0.13.5/. The core reads production's
// answers the way it reads the fake's: close-empty's preview, close and read-back, the TEE wallet reads at
// 0.10.25, and a key's Candle cap and the day's use.
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import fixture from "../../test/fixtures/candle-tools.json"
import { keyCapUse } from "../setup/doctor"
import { parseExecutionStatus } from "./agent-status"
import { parseProfileWallets } from "./agent-wallets"
import { classificationDrift } from "./classify"
import { mapCliRow } from "./cli-cards"
import { readPreview } from "./empty-accounts"

const dir = join(import.meta.dir, "../../test/fixtures/candle-recorded/cli-0.13.5")
const teeDir = join(import.meta.dir, "../../test/fixtures/candle-recorded/tee")
const clicmd = (name: string): { command: string; exit: number; stdout: Record<string, unknown>; stderr?: string } => JSON.parse(readFileSync(join(dir, `clicmd-${name}.json`), "utf8"))
const recording = (d: string, name: string): { outcome: { kind: string; result?: unknown } } => JSON.parse(readFileSync(join(d, `${name}.json`), "utf8"))
const run = (c: ReturnType<typeof clicmd>) => ({ exitCode: c.exit, json: c.stdout, stderr: c.stderr ?? "", timedOut: false })

describe("close-empty as production answered it", () => {
  test("the preview without --yes: CONFIRMATION_REQUIRED, and the count and SOL read from the CLI's words", () => {
    const preview = clicmd("close-empty-preview")
    expect(preview.exit).toBe(1)
    expect(preview.stdout).toMatchObject({ ok: false, code: "CONFIRMATION_REQUIRED" })
    // A line per account follows the two the core reads; it reads past them.
    expect(preview.stderr!.split("\n").filter((l) => l.startsWith("  "))).toHaveLength(4)
    expect(readPreview(run(preview), 1)).toEqual({ count: 4, totalSol: "0.00595376", transactions: 1, feeSol: "0.000005", netSol: "0.00594876", at: 1 })
  })

  test("nothing to close: exit 0 with the whole preview on stdout, read as none", () => {
    const nothing = clicmd("close-empty-nothing")
    expect(nothing.exit).toBe(0)
    expect(readPreview(run(nothing), 1)).toMatchObject({ count: 0, netSol: "0" })
  })

  test("the close went through, and read back under its id it's the same close, nothing sent again", () => {
    const close = clicmd("close-empty-run")
    expect(mapCliRow("wallets close-empty", run(close)).state).toBe("succeeded")
    expect(close.stdout).toMatchObject({ status: "completed", remaining: 0, failed: [], unattempted: [], notClosed: [] })
    expect(close.stderr).toContain(`Operation: ${close.stdout.clientTradeId}`)
    const back = clicmd("close-empty-read-back")
    expect(mapCliRow("wallets close-empty", run(back)).state).toBe("succeeded")
    const job = back.stdout.job as { status: string; submitState: string; reconciled: boolean; result: { signatures: string[] } }
    expect(job).toMatchObject({ status: "completed", submitState: "done", reconciled: true })
    expect(job.result.signatures).toEqual(close.stdout.signatures as string[])
    expect(back.stderr).toBe("")
  })
})

describe("the TEE wallet reads at server 0.10.25", () => {
  test("every field recorded at 0.10.22 is still there (0.10.25 only adds)", () => {
    const paths = (v: unknown, at = ""): string[] =>
      v !== null && typeof v === "object" ? Object.entries(v as object).flatMap(([k, x]) => paths(x, `${at}.${Array.isArray(v) ? "#" : k}`)) : [at]
    const names = readdirSync(dir).filter((n) => n.startsWith("cli-agent-") && !n.endsWith("handshake.json"))
    expect(names.length).toBeGreaterThanOrEqual(20)
    for (const name of names) {
      const before = new Set(paths(recording(teeDir, name.replace(".json", "")).outcome).filter((p) => !p.includes(".prices.")))
      const after = new Set(paths(recording(dir, name.replace(".json", "")).outcome))
      expect(`${name}: ${[...before].filter((p) => !after.has(p)).join(", ")}`).toBe(`${name}: `)
    }
  })

  test("the core still parses the status and profile reads; agent-a's key still holds the TEE wallet", () => {
    const status = recording(dir, "cli-agent-a-candle_execution_status").outcome
    expect(parseExecutionStatus(status.result, 1)).toBeDefined()
    const wallets = parseProfileWallets(recording(dir, "cli-agent-a-candle_get_profile_wallets").outcome.result)
    expect(wallets?.rows).toHaveLength(1)
    expect(parseProfileWallets(recording(dir, "cli-agent-b-candle_get_profile_wallets").outcome.result)?.rows).toEqual([])
  })

  test("the tool list is 0.10.29's 87, the four profile and post tools marked as 0.10.25 listed them, and the table agrees", () => {
    expect(fixture.serverInfo.version).toBe("0.10.29")
    expect(fixture.tools).toHaveLength(87)
    expect(fixture.tools.filter((t) => "listedAfterKeyCheck" in t).map((t) => t.name)).toEqual(["candle_update_profile", "candle_upload_profile_image", "candle_create_post", "candle_delete_post"])
    expect(classificationDrift(fixture.tools.map((t) => t.name))).toEqual([])
    // Both keys could edit their profiles, so both listed all 61 of 0.10.25's, each still in the list.
    for (const k of ["a", "b"]) {
      const h = JSON.parse(readFileSync(join(dir, `cli-agent-${k}-handshake.json`), "utf8")) as { toolNames: string[] }
      expect(h.toolNames).toHaveLength(61)
      expect(h.toolNames.filter((n) => !fixture.tools.some((t) => t.name === n))).toEqual([])
    }
  })
})

describe("a key's Candle cap and the account's reads", () => {
  test("keys list: the doctor reads the cap and the day's use; setting the same cap again leaves the day as it was", () => {
    const before = (clicmd("keys-list-agent-b").stdout.keys as Record<string, unknown>[])[0]!
    const after = (clicmd("keys-list-agent-b-after-limit").stdout.keys as Record<string, unknown>[])[0]!
    // Production read: the reserved figure, and the booked one beside it, agreeing.
    expect(keyCapUse(before)).toEqual({ limit: 100, used: 4, booked: 4, reset: "daily" })
    expect(keyCapUse(after)).toEqual(keyCapUse(before))
    expect(after.emberWindow).toEqual(before.emberWindow)
    expect(clicmd("keys-limit").stdout).toMatchObject({ ok: true, txLimit: { reset: "daily" } })
  })

  test("no vault is exit 1, VAULT_MISSING; a vault is ok with its factors", () => {
    const none = clicmd("vault-status-none")
    expect(none.exit).toBe(1)
    expect(none.stdout).toMatchObject({ ok: false, code: "VAULT_MISSING", details: { pathSource: "flag" } })
    expect(clicmd("vault-status").stdout).toMatchObject({ ok: true, envelopes: [{ factor: "passphrase" }] })
  })

  test("an unknown profile is PROFILE_UNRESOLVED; a known one names its device token and key", () => {
    expect(clicmd("auth-status-unknown-profile")).toMatchObject({ exit: 1, stdout: { ok: false, code: "PROFILE_UNRESOLVED" } })
    expect(clicmd("auth-status").stdout).toMatchObject({ rows: [{ check: "Device token", state: "PASS" }, { check: "API key", state: "PASS" }] })
  })

  test("tee rename: at a terminal it renames on Candle and in the vault; with stdout in a file it refuses before asking", () => {
    expect(clicmd("tee-rename").stdout).toMatchObject({ ok: true, renamed: [{ server: "renamed", vault: "renamed" }] })
    expect(clicmd("tee-rename-stdout-not-terminal")).toMatchObject({ exit: 1, stdout: { code: "VAULT_UNLOCK_FAILED" } })
  })

  test("keys update on a key that already has the embedded wallet changes nothing, and says so", () => {
    expect(clicmd("keys-update-unchanged").stdout).toMatchObject({ direction: "unchanged", from: "allowed", to: "allowed" })
  })
})

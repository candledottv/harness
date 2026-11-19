// Own-balance transfers on Hyperliquid (BE-3765, SendAsset only: main perps <-> a builder dex), as Candle's
// source takes them: the transfer check every package ships, `candle perps transfer`, the MCP tool and the
// SDK method, recorded offline from one exact commit (scripts/read-transfer-source.ts), and how candle_cli
// routes the command. Perps <-> spot is BE-3864 and is not covered. Since BE-3910 the recording is the
// release head #3977 (cccd02f7): CLI 0.13.31, MCP 0.10.36, SDK 0.6.25, the versions that publish the
// transfer commands. This harness change stays a draft PR until npm carries CLI 0.13.31.
import { describe, expect, test } from "bun:test"
import perps from "../../test/fixtures/candle-perps-source.json"
import transfer from "../../test/fixtures/candle-transfer-source.json"
import tools from "../../test/fixtures/candle-tools.json"
import { PRE_BUILD_CODES } from "./cli-trade"
import { catalogueFor } from "./cli-catalogue"
import { classify } from "./classify"
import { rowFor, SOURCE, TRANSFER_CLI_VERSION, TRANSFER_LATER } from "./cli-table"
import { resolveCall } from "./cli-tool"

type Row = { id: string; surface: string; evidence?: string; args: Record<string, any>; requests?: { method: string; host?: string; path: string; body?: Record<string, any> }[]; outcome: any }
const rows = transfer.rows as Row[]
const row = (id: string) => {
  const found = rows.find((r) => r.id === id)
  if (!found) throw new Error(`missing recording ${id}`)
  return found
}
const ids = (prefix: string) => rows.filter((r) => r.id.startsWith(prefix))
const ctx = { defaultAgent: "momentum", agents: new Set(["momentum"]) }
const resolve = (subcommand: string, args: string[]) => resolveCall({ command: "perps", subcommand, args }, ctx)
const SIGN = (q: { path: string }) => q.path.endsWith("/sign")

test("the recording names the exact release build and agrees with the other source fixtures", () => {
  expect(transfer.source).toMatchObject({ repo: "candledottv/candle-monorepo", commit: "cccd02f77719331cb0bcb24d08e3cf6a77fbf805", versions: { cli: "0.13.31", mcp: "0.10.36", sdk: "0.6.25" } })
  // The other source fixtures are re-read by main at #4047's merge (8a08b366); this transfer
  // recording stays pinned at the release head cccd02f7, the versions that publish the transfer commands.
  for (const other of [SOURCE, tools, perps]) expect(other.source.commit).toBe("8a08b366d541a7b9f439fd6e1a290cb57375d417")
  // One transfer check, copied into the three packages: the recorder refuses to run if they differ.
  expect(transfer.source.transferCheck.files).toEqual(["packages/sdk/src/hyperliquid-transfer.ts", "packages/mcp/src/hyperliquid-transfer.ts", "packages/cli/src/hyperliquid-transfer.ts"])
  expect(transfer.source.transferCheck.sha256).toMatch(/^[0-9a-f]{64}$/)
  // The pin this draft PR waits on: the CLI version the release head publishes.
  expect(TRANSFER_CLI_VERSION).toBe(transfer.source.versions.cli)
  expect(rows).toHaveLength(72)
  expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length)
})

test("nothing in the recording is a real address, key or account figure", () => {
  const text = JSON.stringify(transfer)
  for (const hex of text.match(/0x[0-9a-fA-F]{40}\b/g) ?? []) expect(hex).toMatch(/^0x0{39}[0-9]$/)
  expect(text).not.toContain("fixture-only-not-a-key")
  expect(text).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/)
  // Neither the CLI nor the SDK is allowed a signature or a venue call except the stand-in rows, which the recorder answers itself.
  for (const r of rows) {
    if (["mcp-to-dex-full-flow-synthetic-venue", "cli-to-dex-full-flow-synthetic-venue", "cli-from-dex-all-full-flow-synthetic-venue", "cli-positions-read-back", "cli-withdraw-sweep-read-back"].includes(r.id)) continue
    expect((r.requests ?? []).some((q) => q.host === "api.hyperliquid.xyz"), r.id).toBe(false)
  }
  expect(row("mcp-to-dex-full-flow-synthetic-venue").evidence).toContain("stand-in")
})

describe("the transfer check, through its SDK, MCP and CLI copies", () => {
  test("an honest move into a builder dex, out of it, and out of it for all, passes", () => {
    for (const id of ["honest-to-dex", "honest-from-dex", "honest-all-any-amount"]) expect(row(`check-${id}`).outcome.refusal).toBeNull()
  })

  test("another destination, another token, a sub-account, another dex or direction, a changed amount or id, a testnet chain, a foreign domain and a differing action are each refused", () => {
    const refused: Record<string, string> = {
      "foreign-destination": "destination is not this wallet",
      "foreign-destination-in-action-only": "action differs from signed message",
      "other-token": "token, subaccount or dex differs",
      "sub-account": "token, subaccount or dex differs",
      "another-dex": "transfer identity differs",
      "wrong-direction": "transfer identity differs",
      "amount-differs": "amount differs",
      "other-transfer-id": "transfer identity differs",
      "testnet-chain": "message shape or nonce differs",
      "untrusted-domain": "untrusted domain",
      "action-differs-from-message": "action differs from signed message",
      "no-nonce": "invalid nonce",
      "missing-typed-data": "missing or malformed typed data or action",
      "spot-mode-on-a-dex-build": "transfer identity differs",
    }
    for (const [id, why] of Object.entries(refused)) expect(row(`check-refused-${id}`).outcome.refusal).toBe(why)
    expect(ids("check-refused-")).toHaveLength(Object.keys(refused).length)
  })
})

describe("candle perps transfer", () => {
  test("before the prompt it shows the transfer id, the amount and both balances, and a declined prompt builds nothing", () => {
    expect(row("cli-to-dex-prompt").outcome.disclosure).toEqual(["Transfer t1", "Amount 5 USDC", "From Main perps", "To builder dex xyz"])
    expect(row("cli-from-dex-prompt").outcome.disclosure).toEqual(["Transfer t2", "Amount 5 USDC", "From builder dex xyz", "To Main perps"])
    expect(row("cli-from-dex-all-prompt").outcome.disclosure).toEqual(["Transfer t3", "Amount all free USDC", "From builder dex xyz", "To Main perps"])
    for (const id of ["cli-to-dex-prompt", "cli-from-dex-prompt", "cli-from-dex-all-prompt"]) {
      expect(row(id).outcome.stop).toBe("before-prompt")
      expect(row(id).requests!.some((q) => q.path === "/api/v1/agent/perps/transfer")).toBe(false)
    }
  })

  test("with --yes the same lines come first, the request names the wallet and never a destination, and it stops before the relay is asked to sign", () => {
    for (const id of ["cli-to-dex-yes", "cli-from-dex-yes", "cli-from-dex-all-yes"]) {
      const r = row(id)
      expect(r.outcome.stop).toBe("before-relay")
      const built = r.requests!.find((q) => q.path === "/api/v1/agent/perps/transfer")!
      expect(built.body).toMatchObject({ walletId: "wallet", dex: "xyz" })
      expect(built.body).not.toHaveProperty("destination")
      expect(built.body).not.toHaveProperty("fromSubAccount")
      expect(r.requests!.at(-1)!.path.endsWith("/sign")).toBe(true)
    }
    expect(row("cli-to-dex-yes").requests!.find((q) => q.path === "/api/v1/agent/perps/transfer")!.body).toMatchObject({ mode: "toDex", amountUsdc: "5" })
    expect(row("cli-from-dex-yes").requests!.find((q) => q.path === "/api/v1/agent/perps/transfer")!.body).toMatchObject({ mode: "fromDex", amountUsdc: "5" })
    // --all sends all: true and no amount.
    const all = row("cli-from-dex-all-yes").requests!.find((q) => q.path === "/api/v1/agent/perps/transfer")!.body!
    expect(all).toMatchObject({ mode: "fromDex", all: true })
    expect(all).not.toHaveProperty("amountUsdc")
  })

  test("--no-submit builds and checks, and signs nothing", () => {
    expect(row("cli-no-submit-builds-and-checks-only")).toMatchObject({ outcome: { exitCode: 0, submitted: false, status: "built" } })
    expect(row("cli-no-submit-builds-and-checks-only").requests!.some(SIGN)).toBe(false)
  })

  test("a build for another destination, another token or a sub-account is refused before the relay, with nothing signed", () => {
    expect(ids("cli-hostile-")).toHaveLength(3)
    for (const r of ids("cli-hostile-")) {
      expect(r.outcome.body.code).toBe("PERPS_BUILD_REFUSED")
      expect(r.outcome.body.message).toContain("Nothing was signed.")
      expect(r.requests!.some(SIGN)).toBe(false)
    }
    expect(row("cli-hostile-foreign-destination").outcome.body.message).toContain("destination is not this wallet")
  })

  test("perps to spot, two directions or none, --all into a dex, --all with an amount, spot as a dex, a bad dex, amount or id are refused with nothing requested", () => {
    const messages: Record<string, string> = {
      "to-spot": "Perps to spot transfers (--to-spot, --from-spot) are not available in this release.",
      "from-spot": "Perps to spot transfers (--to-spot, --from-spot) are not available in this release.",
      "to-spot-with-dex": "Name exactly one direction: --to-dex or --from-dex.",
      "both-directions": "Name exactly one direction: --to-dex or --from-dex.",
      "no-direction": "Name exactly one direction: --to-dex or --from-dex.",
      "all-into-a-dex": "--all moves money INTO a builder dex; name an amount instead.",
      "all-with-an-amount": "--all takes no amount.",
      "spot-as-a-dex-name": "--to-dex/--from-dex name a builder dex: 1 to 16 letters or digits, and not spot.",
      "dex-name-with-a-dash": "--to-dex/--from-dex name a builder dex: 1 to 16 letters or digits, and not spot.",
      "zero-amount": "The amount must be a positive USDC decimal with at most 6 decimals.",
      "seven-decimals": "The amount must be a positive USDC decimal with at most 6 decimals.",
      "no-amount": "The amount must be a positive USDC decimal with at most 6 decimals.",
      "bad-id": "--id must be 1 to 128 letters, digits, '.', '_', ':' or '-'.",
    }
    for (const [id, message] of Object.entries(messages)) {
      const r = row(`cli-local-${id}`)
      expect(r.requests, id).toEqual([])
      expect(r.outcome).toMatchObject({ exitCode: 2, body: { ok: false, code: "USAGE", message } })
    }
    expect(ids("cli-local-")).toHaveLength(Object.keys(messages).length)
  })

  test("the API's refusals (an unknown dex, a dex not collateralised in USDC, more than the source can release, nothing to move) come through with their code and nothing is signed", () => {
    const codes: Record<string, string> = {
      "unknown-dex": "PERPS_TRANSFER_DEX_REFUSED",
      "non-usdc-collateral-dex": "PERPS_TRANSFER_DEX_REFUSED",
      "amount-above-source-balance": "PERPS_TRANSFER_EXCEEDS_SOURCE",
      "nothing-to-move": "PERPS_TRANSFER_NOTHING_TO_MOVE",
    }
    for (const [id, code] of Object.entries(codes)) {
      const r = row(`cli-refused-${id}`)
      expect(r.outcome).toMatchObject({ exitCode: 1, code })
      expect(r.evidence).toContain("response-stub")
      expect(r.requests!.some(SIGN)).toBe(false)
    }
  })

  test("it is coming as a card, so the user runs it in their own terminal; its status is a read", () => {
    expect(rowFor("perps transfer")).toMatchObject({ rule: "card", route: "later", identity: "agent", note: TRANSFER_LATER })
    expect(rowFor("perps transfer status")).toMatchObject({ rule: "read", route: "cli", identity: "agent" })
    for (const args of [["--to-dex", "xyz", "5"], ["--from-dex", "xyz", "--all"], ["--from-dex", "xyz", "5"]]) {
      const r = resolve("transfer", args)
      expect(r.ok && r.call.route).toBe("later")
    }
    const entry = catalogueFor(false).find((e) => e.path === "perps transfer")!
    expect(entry).toMatchObject({ availability: "coming", why: TRANSFER_LATER, documented: true })
    expect(catalogueFor(true).find((e) => e.path === "perps transfer")!.availability).toBe("coming")
    const status = resolve("transfer", ["status", "t1"])
    expect(status.ok && { rule: status.call.rule, route: status.call.route }).toEqual({ rule: "read", route: "cli" })
  })

  test("the agent never passes --yes or --no-submit to it", () => {
    expect(resolve("transfer", ["--to-dex", "xyz", "5", "--yes"])).toMatchObject({ ok: false, code: "FLAG_NOT_ALLOWED" })
    expect(resolve("transfer", ["--to-dex", "xyz", "5", "--no-submit"])).toMatchObject({ ok: false, code: "FLAG_NOT_ALLOWED" })
  })
})

describe("candle_perps_transfer and the SDK's perpsTransfer()", () => {
  test("the tool is in the recorded list with the builder-dex modes only, and no destination, token or sub-account field", () => {
    const tool = tools.tools.find((t) => t.name === "candle_perps_transfer")!
    const schema = tool.inputSchema as unknown as { properties: Record<string, { enum?: string[] }> }
    expect(schema.properties.mode!.enum).toEqual(["toDex", "fromDex"])
    expect(Object.keys(schema.properties).sort()).toEqual(["all", "amountUsdc", "clientTransferId", "dex", "mode", "submit", "wallet"])
  })

  test("it is classified with the perps writes, refused here, since the Candle Harness runs perps writes through candle_cli", () => {
    expect(classify("candle_perps_transfer", {}, "live")).toMatchObject({ class: "refused", code: "NOT_YET_SUPPORTED" })
  })

  test("to a dex, from a dex and all of it build the same request on both surfaces and check it without signing", () => {
    for (const id of ["to-dex", "from-dex", "from-dex-all"]) {
      for (const surface of ["mcp", "sdk"]) {
        const r = row(`${surface}-${id}-submit-false`)
        expect(r.outcome).toMatchObject({ isError: false, body: { status: "built", submitted: false } })
        expect(r.requests!.some(SIGN)).toBe(false)
        const body = r.requests!.find((q) => q.path === "/api/v1/agent/perps/transfer")!.body!
        // The MCP tool names the wallet walletId and the SDK's build request names it wallet; the API takes either.
        expect(body.walletId ?? body.wallet).toBe("wallet")
        expect(body).not.toHaveProperty("destination")
        expect(body).toMatchObject({ dex: "xyz" })
      }
      expect(row(`mcp-${id}-submit-false`).outcome.body.id).toBe(row(`sdk-${id}-submit-false`).outcome.body.id)
    }
    expect(row("mcp-from-dex-all-submit-false").requests!.find((q) => q.path === "/api/v1/agent/perps/transfer")!.body).toMatchObject({ all: true, mode: "fromDex" })
    expect(row("sdk-from-dex-all-submit-false").requests!.find((q) => q.path === "/api/v1/agent/perps/transfer")!.body).not.toHaveProperty("amountUsdc")
  })

  test("the full MCP flow (build, local check, relay, venue, acknowledgement) runs against stand-ins, and only then does the venue see the signed action", () => {
    const r = row("mcp-to-dex-full-flow-synthetic-venue")
    expect(r.outcome).toMatchObject({ isError: false, body: { id: "t1", status: "submitted" } })
    const paths = r.requests!.map((q) => `${q.host === "api.hyperliquid.xyz" ? "venue:" : ""}${q.path}`)
    expect(paths.indexOf("/api/v1/agent/wallets/wallet/sign")).toBeGreaterThan(paths.indexOf("/api/v1/agent/perps/transfer"))
    expect(paths.indexOf("venue:/exchange")).toBeGreaterThan(paths.indexOf("/api/v1/agent/wallets/wallet/sign"))
    expect(paths.at(-1)).toBe("/api/v1/agent/perps/transfer/submitted")
  })

  test("perps to spot, a destination, spot as a dex, --all into a dex or with an amount, a zero amount, a hostile build and a missing signer never sign", () => {
    const codes: Record<string, string> = {
      "to-spot": "MCP_VALIDATION",
      "from-spot": "MCP_VALIDATION",
      "destination-input": "MCP_VALIDATION",
      "spot-as-a-dex-name": "MCP_VALIDATION",
      "all-into-a-dex": "MCP_VALIDATION",
      "all-with-an-amount": "MCP_VALIDATION",
      "zero-amount": "MCP_VALIDATION",
      "foreign-destination-build": "PERPS_BUILD_REFUSED",
      "amount-above-what-was-asked": "PERPS_BUILD_REFUSED",
      "no-signer": "SIGNER_UNAVAILABLE",
    }
    for (const [id, code] of Object.entries(codes)) {
      const r = row(`mcp-refused-${id}`)
      expect(r.outcome, id).toEqual({ isError: true, code })
      expect(r.requests!.some(SIGN), id).toBe(false)
    }
    // The input refusals happen before any request at all.
    for (const id of ["to-spot", "from-spot", "destination-input", "spot-as-a-dex-name", "all-into-a-dex", "all-with-an-amount", "zero-amount"]) expect(row(`mcp-refused-${id}`).requests).toEqual([])
  })

  test("the API's refusals (an unknown dex, more than the source can release) pass through with their code", () => {
    expect(row("mcp-refused-api-unknown-dex").outcome).toEqual({ isError: true, code: "PERPS_TRANSFER_DEX_REFUSED" })
    expect(row("mcp-refused-api-amount-above-source-balance").outcome).toEqual({ isError: true, code: "PERPS_TRANSFER_EXCEEDS_SOURCE" })
  })

  test("the SDK refuses a bad amount or direction before any request, and a hostile build after one, never signing", () => {
    for (const id of ["all-into-a-dex", "zero-amount"]) {
      expect(row(`sdk-refused-${id}`).requests).toEqual([])
      expect(row(`sdk-refused-${id}`).outcome.message).toBe("perpsTransfer: invalid amount or all direction")
    }
    expect(row("sdk-refused-foreign-destination-build").outcome.message).toBe("perpsTransfer: refused build: destination is not this wallet")
    expect(row("sdk-refused-other-dex-in-build").outcome.message).toBe("perpsTransfer: refused build: transfer identity differs")
    for (const r of ids("sdk-refused-")) expect(r.requests!.some(SIGN)).toBe(false)
  })
})

describe("the happy path and the read-backs (the release recording, BE-3910)", () => {
  const pathsOf = (id: string) => row(id).requests!.map((q) => `${q.host === "api.hyperliquid.xyz" ? "venue:" : ""}${q.path}`)
  const at = (paths: string[], needle: string) => paths.findIndex((p) => p === needle || p.endsWith(needle))

  test("with --yes the whole flow runs on stand-ins: build, check, relay, venue, acknowledgement, and the move is announced", () => {
    for (const [id, notice] of [
      ["cli-to-dex-full-flow-synthetic-venue", "Moved 5 USDC: Main perps -> builder dex xyz."],
      ["cli-from-dex-all-full-flow-synthetic-venue", "Moved 5 USDC: builder dex xyz -> Main perps."],
    ] as const) {
      const r = row(id)
      expect(r.outcome).toMatchObject({ exitCode: 0, notice })
      expect(r.evidence).toContain("stand-in")
      const paths = pathsOf(id)
      expect(at(paths, "/agent/perps/transfer")).toBeLessThan(at(paths, "/wallets/wallet/sign"))
      expect(at(paths, "/wallets/wallet/sign")).toBeLessThan(at(paths, "venue:/exchange"))
      expect(at(paths, "venue:/exchange")).toBeLessThan(at(paths, "/perps/transfer/submitted"))
    }
  })

  test("the read-backs: the transfer's status, the main perps balance it moved, and the balances a withdrawal sweep leaves behind", () => {
    const status = row("cli-status-read-back")
    expect(status.outcome).toMatchObject({ exitCode: 0, body: { id: "t1", status: "submitted", amountUsdc: "5", mode: "toDex" } })
    expect(status.requests).toEqual([{ method: "GET", host: "api.test", path: "/api/v1/agent/perps/transfer/t1" }])
    expect(row("cli-positions-read-back").outcome).toMatchObject({ exitCode: 0, withdrawable: "Withdrawable now 12 USDC" })
    const sweep = row("cli-withdraw-sweep-read-back")
    expect(sweep.outcome).toMatchObject({ exitCode: 0, retained: 'Retained balances [{"dex":"xyz","amountUsdc":"40"}]' })
    // The sweep's own move is submitted before the withdrawal asks again, and no quote is ever reached.
    const paths = pathsOf("cli-withdraw-sweep-read-back")
    expect(at(paths, "venue:/exchange")).toBeLessThan(paths.lastIndexOf("/api/v1/agent/perps/withdraw"))
    expect(paths.some((p) => p.endsWith("/withdraw/authorize"))).toBe(false)
  })

  test("every refusal code the transfer flow can answer with is mapped in PRE_BUILD_CODES, and none is unknown", () => {
    // Everything that refuses before a signature exists, from the source's own routes and checks.
    const beforeSignature = [
      "PERPS_BUILD_REFUSED", "PERPS_EMBEDDED_DISABLED", "PERPS_TRANSFER_UNSUPPORTED_NETWORK", "PERPS_TRANSFER_UNVERIFIED",
      "PERPS_TRANSFER_DEX_REFUSED", "PERPS_TRANSFER_NOTHING_TO_MOVE", "PERPS_TRANSFER_EXCEEDS_SOURCE", "SIGNER_UNAVAILABLE",
    ]
    for (const code of beforeSignature) expect(PRE_BUILD_CODES.has(code), code).toBe(true)
    // These can only follow a signature, so they are never a pre-build refusal.
    for (const code of ["PERPS_VENUE_REFUSED", "PERPS_SUBMIT_FAILED"]) expect(PRE_BUILD_CODES.has(code), code).toBe(false)
    // No unknown codes: everything the recording observed refuse is one of the known sets.
    const known = new Set([...PRE_BUILD_CODES, "PERPS_VENUE_REFUSED", "PERPS_SUBMIT_FAILED", "PERPS_TRANSFER_NOT_FOUND", "MCP_VALIDATION", "INVALID_RESPONSE"])
    const observed = new Set<string>()
    for (const r of rows) {
      for (const code of [r.outcome?.body?.code, r.outcome?.code]) if (typeof code === "string" && code !== "INVALID_RESPONSE") observed.add(code)
      if (r.outcome?.body?.code === "PERPS_BUILD_REFUSED") observed.add("PERPS_BUILD_REFUSED")
    }
    expect(observed.has("USAGE")).toBe(true)
    for (const code of observed) expect(known.has(code), code).toBe(true)
  })
})

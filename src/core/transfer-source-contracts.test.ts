// Own-balance transfers on Hyperliquid (BE-3765, SendAsset only: main perps <-> a builder dex), as Candle's
// source takes them: the transfer check every package ships, `candle perps transfer`, the MCP tool and the
// SDK method, recorded offline from one exact commit (scripts/read-transfer-source.ts), and how candle_cli
// routes the command. Perps <-> spot is BE-3864 and is not covered. The commit is a staging build: the
// published CLI 0.13.30, MCP 0.10.35 and SDK 0.6.24 predate it.
import { describe, expect, test } from "bun:test"
import perps from "../../test/fixtures/candle-perps-source.json"
import transfer from "../../test/fixtures/candle-transfer-source.json"
import tools from "../../test/fixtures/candle-tools.json"
import { catalogueFor } from "./cli-catalogue"
import { classify } from "./classify"
import { rowFor, SOURCE, TRANSFER_LATER } from "./cli-table"
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

test("the recording names the exact staging build and agrees with the other source fixtures", () => {
  expect(transfer.source).toMatchObject({ repo: "candledottv/candle-monorepo", commit: "36d4bf2642244e82deaa690d8d1277d60d8b9021", versions: { cli: "0.13.32", mcp: "0.10.37", sdk: "0.6.26" } })
  expect(transfer.source.commit).toBe(SOURCE.source.commit)
  expect(transfer.source.commit).toBe(tools.source.commit)
  expect(transfer.source.commit).toBe(perps.source.commit)
  // One transfer check, copied into the three packages: the recorder refuses to run if they differ.
  expect(transfer.source.transferCheck.files).toEqual(["packages/sdk/src/hyperliquid-transfer.ts", "packages/mcp/src/hyperliquid-transfer.ts", "packages/cli/src/hyperliquid-transfer.ts"])
  expect(transfer.source.transferCheck.sha256).toMatch(/^[0-9a-f]{64}$/)
  expect(rows).toHaveLength(67)
  expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length)
})

test("nothing in the recording is a real address, key or account figure", () => {
  const text = JSON.stringify(transfer)
  for (const hex of text.match(/0x[0-9a-fA-F]{40}\b/g) ?? []) expect(hex).toMatch(/^0x0{39}[0-9]$/)
  expect(text).not.toContain("fixture-only-not-a-key")
  expect(text).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/)
  // Neither the CLI nor the SDK is allowed a signature or a venue call except the one MCP full-flow row, which the recorder answers itself.
  for (const r of rows) {
    if (r.id === "mcp-to-dex-full-flow-synthetic-venue") continue
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

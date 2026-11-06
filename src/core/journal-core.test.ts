// The Journal's methods through a real core: `journal.query` and `journal.rows`
// answer a view, are refused to a harness, write nothing to the journal, and send no secret the
// redactor knows, even from a row on disk from before the key was.
import { afterAll, afterEach, expect, test } from "bun:test"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { AGENT_KEY, cleanupHomes, startTestCore, type TestCore } from "../../test/core-fixture"
import type { JournalPage } from "./journal-query"

const cores: TestCore[] = []
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close().catch(() => {})
})
afterAll(cleanupHomes)

test("a view reads the journal in words; a harness is refused; nothing is written; nothing secret leaves", async () => {
  // A row as a copied or older state folder could hold it: the agent's key in a refusal's message.
  const account = "acct_journalcoretest01"
  const c = await startTestCore(
    {},
    {
      before: (p) => {
        mkdirSync(p.stateDir, { recursive: true, mode: 0o700 })
        writeFileSync(join(p.stateDir, "account"), `${account}\n`, { mode: 0o600 })
        writeFileSync(p.journal, `${JSON.stringify({ seq: 1, at: "2026-10-01T09:00:00.000Z", type: "cli.refused", account, mode: "live", command: "keys list", message: `it said ${AGENT_KEY}` })}\n`, { mode: 0o600 })
      },
    },
  )
  cores.push(c)
  const view = await c.view()
  const page = (await view.request("journal.query", { kinds: ["cards", "core"], limit: 100 })).result as JournalPage
  expect(page.entries.some((e) => e.text.startsWith("refused your candle keys list"))).toBe(true)
  expect(page.entries.some((e) => e.text.startsWith("the core started"))).toBe(true)
  expect(JSON.stringify(page)).not.toContain(AGENT_KEY)
  const old = page.entries.find((e) => e.text.startsWith("refused your"))!
  const rows = (await view.request("journal.rows", { seqs: old.seqs })).result as { rows: { message: string }[] }
  expect(rows.rows).toHaveLength(1)
  expect(JSON.stringify(rows)).not.toContain(AGENT_KEY)

  // Reading writes nothing: the file is as it was.
  const before = readFileSync(c.p.journal)
  await view.request("journal.query", { text: "nothing like this" })
  await view.request("journal.rows", { seqs: [1] })
  expect(readFileSync(c.p.journal).equals(before)).toBe(true)

  const { client } = await c.harness()
  expect((await client.request("journal.query", {})).error?.data).toMatchObject({ code: "FORBIDDEN_FOR_ROLE" })
  expect((await client.request("journal.rows", { seqs: [1] })).error?.data).toMatchObject({ code: "FORBIDDEN_FOR_ROLE" })
  expect((await view.request("journal.query", { kinds: ["nope"] })).error?.message).toContain("kinds")
})

test("a mint the core can't name now is named by the journal's own pick of it (a restart left paper rows as a short mint)", async () => {
  const account = "acct_journalcoretest02"
  const mint = "PickFake111111111111111111111111111111111111".slice(0, 43)
  const row = (seq: number, at: string, fields: Record<string, unknown>) => JSON.stringify({ seq, at, account, mode: "paper", ...fields })
  const c = await startTestCore(
    {},
    {
      before: (p) => {
        mkdirSync(p.stateDir, { recursive: true, mode: 0o700 })
        writeFileSync(join(p.stateDir, "account"), `${account}\n`, { mode: 0o600 })
        writeFileSync(
          p.journal,
          `${row(1, "2026-10-30T19:53:36.000Z", { type: "view.picked", mint, chain: "solana", symbol: "PICK", from: "graduated, by the arrows", by: "c_x" })}\n` +
            `${row(2, "2026-10-30T19:57:09.000Z", { type: "paper.call", agent: "momentum", clientId: "c_x", role: "view", tool: "candle_trade", args: { mint, side: "buy", amount: "0.01", paper: true }, isError: false, answer: JSON.stringify({ api: { success: true, paper: true, side: "buy", mint, quoteAsset: "sol", amountRaw: "10000000", tokenAmount: 12.1 } }) })}\n`,
          { mode: 0o600 },
        )
      },
    },
  )
  cores.push(c)
  const view = await c.view()
  const page = (await view.request("journal.query", { kinds: ["trades"], limit: 100 })).result as JournalPage
  const paper = page.entries.find((e) => e.text.includes("paper buy"))!
  expect(paper.text).toContain("paper buy PICK")
  expect(paper.text).not.toContain("Pick…")
})

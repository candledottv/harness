import { expect, test } from "bun:test"
import { rowFor } from "./cli-table"
import { paneCommand, paneHeadline, paneOutcome, planPane, paneSteps, paneTitle, paneTitleLine, typedPath, wrapForPane } from "./pane-plan"

const finalArgs = (args: string[], o: { json: boolean; rpcUrl: boolean }) => [...args, ...(o.json ? ["--json"] : []), ...(o.rpcUrl ? ["--rpc-url", "https://rpc.example"] : [])]
const TEE = "TeeFake111111111111111111111111111111111111"

test("a needsPrompt row: no factor step, the command in human mode, the RPC where it's taken", () => {
  const row = rowFor("tee disable")!
  const p = planPane({ row, rule: "less-access", identity: "agent", agent: "momentum", words: ["tee", "disable", TEE], rpcUrl: false, finalArgs })
  expect(p.pane.steps).toEqual([{ stage: "command", argv: ["tee", "disable", TEE] }])
  const withRpc = planPane({ row, rule: "less-access", identity: "agent", agent: "momentum", words: ["tee", "disable", TEE], rpcUrl: true, finalArgs })
  expect(withRpc.pane.steps[0]!.argv).toEqual(["tee", "disable", TEE, "--rpc-url", "https://rpc.example"])
  expect(paneCommand(withRpc)).toBe(`candle tee disable ${TEE}`)
  expect(p.pane).toMatchObject({ row: "tee disable", rule: "less-access", identity: "agent", agent: "momentum", factorFirst: false })
  expect(paneCommand(p)).toBe(`candle tee disable ${TEE}`)
  expect(paneTitle(p)).toBe(`candle tee disable ${TEE} · the agent can't see this pane`)
  expect(paneHeadline(p)).toBe("LESS ACCESS · candle tee disable TeeF…1111")
  expect(paneTitleLine(p)).toBe(`LESS ACCESS · candle tee disable ${TEE}`)
  expect(paneSteps(row, p)[0]).toContain("passphrase")
})

test("an owner row that never unlocks takes the factor first; a capture row keeps --json; profile remove gets --yes", () => {
  const create = planPane({ row: rowFor("keys create")!, rule: "owner", identity: "owner", words: ["keys", "create", "--name", "a"], rpcUrl: false, finalArgs })
  expect(create.pane.steps).toEqual([
    { stage: "factor", argv: ["vault", "status", "--unlock", "--json"] },
    { stage: "command", argv: ["keys", "create", "--name", "a", "--json"] },
  ])
  expect(create.pane.capture).toBe("new-key")
  expect(create.pane.agent).toBeUndefined()
  const remove = planPane({ row: rowFor("profile remove")!, rule: "owner", identity: "owner", words: ["profile", "remove", "old"], rpcUrl: false, finalArgs })
  expect(remove.pane.steps.at(-1)!.argv).toEqual(["profile", "remove", "old", "--yes"])
  expect(remove.pane.addsYes).toBe(true)
})

test("paths the user names are listed, never valued", () => {
  const p = planPane({ row: rowFor("vault backup")!, rule: "owner", identity: "owner", words: ["vault", "backup"], rpcUrl: false, finalArgs })
  expect(p.pane.askPaths).toEqual([{ flag: "--to", prompt: expect.any(String) }])
  expect(p.pane.steps.at(-1)!.argv).toEqual(["vault", "backup"])
  expect(paneSteps(rowFor("vault backup")!, p)).toContain("you'll name --to in the pane")
})

test("outcomes go by exit status; only the factor step reads a code", () => {
  const plain = { fundsOut: false }
  expect(paneOutcome({ stage: "command", exit: 0 }, plain).outcome).toBe("finished")
  expect(paneOutcome({ stage: "command", exit: 1 }, plain).outcome).toBe("didnt_finish")
  expect(paneOutcome({ stage: "command", exit: 2 }, plain).outcome).toBe("usage")
  expect(paneOutcome({ stage: "command", exit: 3 }, plain)).toMatchObject({ outcome: "pending", words: expect.stringContaining("may still land") })
  expect(paneOutcome({ stage: "command", exit: 7 }, plain).outcome).toBe("didnt_finish")
  expect(paneOutcome({ stage: "factor", exit: 1, code: "VAULT_UNLOCK_FAILED" }, plain)).toMatchObject({ outcome: "refused_before", words: expect.stringContaining("Nothing was run") })
  expect(paneOutcome({ stage: "factor", exit: 1, code: "VAULT_MISSING" }, plain).words).toContain("candle vault init")
  // A factor step stopped with nothing written is a failure like any code.
  expect(paneOutcome({ stage: "factor", exit: 143, signal: "SIGTERM", stopped: true }, plain)).toMatchObject({ outcome: "stopped", words: expect.stringContaining("Nothing was run") })
  expect(paneOutcome({ stage: "paths", stopped: true }, plain).outcome).toBe("stopped")
})

test("a stopped funds-out step takes exit 3's words; anything else stopped doesn't", () => {
  expect(paneOutcome({ stage: "command", stopped: true, signal: "SIGTERM" }, { fundsOut: true }).words).toContain("may still land")
  expect(paneOutcome({ stage: "command", stopped: true, signal: "SIGTERM" }, { fundsOut: false }).words).not.toContain("may still land")
})

test("a funds-out step that exits with an error never says nothing went out, since it may have failed after sending", () => {
  const sent = paneOutcome({ stage: "command", exit: 1 }, { fundsOut: true })
  expect(sent.outcome).toBe("didnt_finish")
  expect(sent.words).toBe("didn't finish (exit 1): refused, answered no, or failed partway. Check the wallet or the signature before sending again.")
  expect(paneOutcome({ stage: "command", exit: 1 }, { fundsOut: false }).words).toBe("didn't finish: refused, or answered no at the CLI's prompt.")
})

test("a batch rename: its --dry-run is a preview step before the command, and what it says", () => {
  const row = rowFor("tee rename")!
  const words = ["tee", "rename", "--pairs-from", "/state/renames/x.txt"]
  const p = planPane({ row, rule: "owner", identity: "owner", words, rpcUrl: false, finalArgs, factorFirst: false, preview: true, renames: [{ address: TEE, name: "hot" }] })
  expect(p.pane.steps).toEqual([
    { stage: "preview", argv: [...words, "--dry-run"] },
    { stage: "command", argv: words },
  ])
  expect(p.pane.renames).toEqual([{ address: TEE, name: "hot" }])
  expect(paneSteps(row, p)[0]).toStartWith("the CLI's preview of every rename first")
  // The preview changes nothing: a refusal, a no, or a usage fault there says so.
  expect(paneOutcome({ stage: "preview", stopped: true }, { fundsOut: false })).toMatchObject({ outcome: "stopped", words: expect.stringContaining("Nothing changed") })
  expect(paneOutcome({ stage: "preview", exit: 1 }, { fundsOut: false })).toMatchObject({ outcome: "refused_before", words: expect.stringContaining("nothing was renamed") })
  expect(paneOutcome({ stage: "preview", exit: 2 }, { fundsOut: false })).toMatchObject({ outcome: "usage" })
})

test("a path typed in the pane: a leading ~ is the user's home, as their shell would make it; nothing else is expanded", () => {
  expect(typedPath("  ~/backups/vault.enc ", "/h/u")).toBe("/h/u/backups/vault.enc")
  expect(typedPath("~", "/h/u/")).toBe("/h/u")
  expect(typedPath("~other/x", "/h/u")).toBe("~other/x")
  expect(typedPath("icloud", "/h/u")).toBe("icloud")
  expect(typedPath("/tmp/~/x", "/h/u")).toBe("/tmp/~/x")
  expect(typedPath("~/x", undefined)).toBe("~/x")
})

test("the launcher's own words wrap at spaces to the pane's width, colour codes taking none", () => {
  const B = "\x1b[1m"
  const R = "\x1b[0m"
  const text = `${B}No vault on this machine, so there's no factor to ask for.${R}\r\nDone.\r\n`
  expect(wrapForPane(text, 30)).toBe(`${B}No vault on this machine, so\r\nthere's no factor to ask for.${R}\r\nDone.\r\n`)
  for (const line of wrapForPane(text, 30).split("\r\n")) expect(line.replace(/\x1b\[[0-9;]*m/g, "").length).toBeLessThanOrEqual(30)
  expect(wrapForPane(text, undefined)).toBe(text)
})

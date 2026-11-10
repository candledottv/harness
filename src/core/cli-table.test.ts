// Every CLI command with its rule, checked against what was read from the CLI's own source.
import { describe, expect, test } from "bun:test"
import { allowedFlags, CLI_ROWS, FORBIDDEN_FLAGS, LP_AGENT_SCOPES, PANE_RULES, rowFor, runsInPane, SOURCE, sourceFor, unlocksFor } from "./cli-table"
import { OWNER_STOPS } from "./owner-rows"

const baseOf = (path: string) => {
  const [command, sub] = path.split(" ")
  return sub !== undefined && sourceFor(command!, sub) ? sourceFor(command!, sub) : sourceFor(command!, null)
}

describe("the table and the source", () => {
  test("it was read from the pinned CLI source", () => {
    // candledottv/cli at cli-v0.13.18.
    expect(SOURCE.source).toMatchObject({ repo: "candledottv/cli", commit: "750bf49a1c08265af41d53ced141d0dd87ca9d38", cliVersion: "0.13.18" })
    expect(SOURCE.commands.length).toBe(163)
    expect((SOURCE as { unread?: string[] }).unread).toEqual([])
  })

  test("every command the CLI routes resolves to exactly one row, and no row is invented", () => {
    for (const c of SOURCE.commands) {
      const path = c.subcommand ? `${c.command} ${c.subcommand}` : c.command
      expect(`${path}: ${CLI_ROWS.filter((r) => r.path === path).length}`).toBe(`${path}: 1`)
    }
    for (const row of CLI_ROWS) expect(`${row.path}: ${baseOf(row.path) !== undefined}`).toBe(`${row.path}: true`)
  })

  test("every row's identity matches the source where the source says one; transfer is an agent-key command", () => {
    // Reviewed by hand: vault restore reads with an API key, and it's the profile's own, since an
    // agent key scoped `selected` may not see every linked wallet. tee sweep signs
    // from this machine's vault, and reads the wallet's state with the profile's own key, which Candle
    // answers for a wallet bound to another key: the owner's step.
    // A plan is bought, renewed and read for the person's own profile, whose state file the CLI keeps
    // per profile (and auto-renew with it), though the CLI would take any key.
    const differs = new Set(["vault restore", "tee sweep", "plan buy", "plan renew", "plan status"])
    for (const row of CLI_ROWS) {
      const parts = row.path.split(" ")
      const source = parts.length === 3 ? sourceFor(parts[0]!, parts[1]!) : baseOf(row.path)
      if ((source?.identity === "agent" || source?.identity === "owner") && !differs.has(row.path)) {
        expect(`${row.path}: ${row.identity}`).toBe(`${row.path}: ${source.identity}`)
      }
    }
    expect(rowFor("vault restore")!.identity).toBe("owner")
    expect(rowFor("tee sweep")!.identity).toBe("owner")
    expect(CLI_ROWS.find((r) => r.path === "transfer")!.identity).toBe("agent")
  })

  test("the rows the source can't decide (both, or neither) state their identity; this list is reviewed by hand", () => {
    const explicit = CLI_ROWS.filter((row) => {
      const parts = row.path.split(" ")
      const source = parts.length === 3 ? sourceFor(parts[0]!, parts[1]!) : baseOf(row.path)
      return source?.identity === "both" || source?.identity === "none"
    }).map((row) => `${row.path}=${row.identity}`)
    expect(explicit).toContain("auth status=owner")
    expect(explicit).toContain("doctor=owner")
    expect(explicit).toContain("keys access=owner")
    expect(explicit).toContain("portfolio=agent")
    // tee enable binds the wallet to the key it runs with.
    expect(explicit).toContain("tee enable=agent")
    // 0.13.5: keyless reads run as the agent, so no profile of the person's is touched; the CLI's own spend limits are the person's.
    for (const p of ["scan=agent", "token clusters=agent", "token history=agent", "spend limit=owner", "spend max-per-call=owner", "spend pause=owner", "spend resume=owner"]) expect(explicit).toContain(p)
    // 0.13.9: keyless reads as the agent; auto-renew is a flag in the person's own profile. (0.13.18 drops the staging tool accounts create.)
    for (const p of ["agent positions=agent", "token comments=agent", "plan auto-renew=owner", "plan auto-renew on=owner", "plan auto-renew off=owner"]) expect(explicit).toContain(p)
    // 0.13.11: a signer's state reads by --key, as its siblings run.
    expect(explicit).toContain("tee signer status=agent")
    expect(explicit.length).toBe(69)
  })

  test("the CLI route lets the agent read and narrow access only", () => {
    for (const row of CLI_ROWS.filter((r) => r.route === "cli")) {
      expect(`${row.path}: ${["read", "less-access", "mcp"].includes(row.rule)}`).toBe(`${row.path}: true`)
    }
  })

  test("no row ever takes a forbidden flag, an --accept- flag or a path flag from the agent", () => {
    for (const entry of SOURCE.commands) {
      const allowed = allowedFlags(entry)
      for (const flag of [...allowed.value, ...allowed.boolean]) {
        expect(FORBIDDEN_FLAGS.has(flag)).toBe(false)
        expect(flag.startsWith("--accept-")).toBe(false)
        expect(entry.flags?.path ?? []).not.toContain(flag)
      }
    }
  })
})

// The rows 0.13.18 adds or changes (0.13.15 to 0.13.18).
describe("the read at 0.13.18", () => {
  test("every new row has its rule, from the source, and accounts create is gone", () => {
    const paths = ["keys limits", "keys stop", "keys resume", "keys rotate", "quant ask", "wallets allowlist", "wallets authorize"]
    expect(Object.fromEntries(paths.map((p) => [p, `${rowFor(p)!.rule} ${rowFor(p)!.route} ${rowFor(p)!.identity}`]))).toEqual({
      "keys limits": "less-access cli agent",
      "keys stop": "less-access cli owner",
      "keys resume": "owner pane owner",
      "keys rotate": "owner later owner",
      "quant ask": "read cli agent",
      "wallets allowlist": "read cli agent",
      "wallets authorize": "ceremony pane agent",
    })
    expect(CLI_ROWS.some((r) => r.path === "accounts create")).toBe(false)
    expect(rowFor("keys rotate")!.held).toContain("fresh one with candle keys create")
    expect(rowFor("keys resume")!.pane!.factorFirst).toBe(true)
    expect(rowFor("wallets authorize")!.pane!.factorFirst).toBe(false)
  })

  test("the changed flags: keys create --no-store, close-empty --preview, portfolio --no-vault, launch's allowlist", () => {
    expect(sourceFor("keys", "create")!.flags!.boolean).toContain("--no-store")
    expect(sourceFor("wallets", "close-empty")!.flags!.boolean).toContain("--preview")
    expect(sourceFor("portfolio", null)!.flags!.boolean).toContain("--no-vault")
    expect(sourceFor("launch", null)!.flags!.path).toContain("--allowlist")
  })
})

// The rows 0.13.9 adds or changes.
describe("the read at 0.13.9", () => {
  test("every new row has its rule, from the source", () => {
    const paths = ["agent positions", "lab edges", "lab replay", "lab runners", "lab status", "plan auto-renew", "plan auto-renew off", "plan auto-renew on", "plan buy", "plan renew", "plan status", "tee signer remove", "token comment", "token comments", "token edit", "token post", "token post delete", "token update"]
    expect(Object.fromEntries(paths.map((p) => [p, `${rowFor(p)!.rule} ${rowFor(p)!.route}`]))).toEqual({
      "agent positions": "mcp cli",
      "lab edges": "mcp cli",
      "lab replay": "mcp cli",
      "lab runners": "mcp cli",
      "lab status": "mcp cli",
      "plan auto-renew": "owner pane",
      "plan auto-renew off": "less-access cli",
      "plan auto-renew on": "owner pane",
      "plan buy": "owner pane",
      "plan renew": "owner pane",
      "plan status": "read cli",
      "tee signer remove": "owner pane",
      "token comment": "card later",
      "token comments": "read cli",
      "token edit": "card card",
      "token post": "card later",
      "token post delete": "card later",
      "token update": "card later",
    })
    // The lab is hacc_lab's, and the token edit Candle's own card.
    for (const p of ["lab edges", "lab replay", "lab runners", "lab status"]) expect(rowFor(p)!.mcpTool).toBe("hacc_lab")
    expect(rowFor("agent positions")!.mcpTool).toBe("candle_get_agent_positions")
    expect(rowFor("token edit")!.via).toBe("candle_token_edit")
  })

  test("a plan payment unlocks the vault and needs a terminal, so the CLI asks for the factor; paying or turning auto-renew on stops when paused", () => {
    for (const p of ["plan buy", "plan renew"]) {
      expect(unlocksFor(p)).toBe("always")
      expect(sourceFor("plan", p.split(" ")[1]!)!.tty).toEqual(["stdin", "stdout"])
      expect(rowFor(p)!.pane!.factorFirst).toBe(false)
      expect(OWNER_STOPS.has(p)).toBe(true)
    }
    expect(OWNER_STOPS.has("plan auto-renew on")).toBe(true)
    expect(OWNER_STOPS.has("plan auto-renew off")).toBe(false)
    // --signer-out names a file: never the agent's.
    expect(allowedFlags(sourceFor("plan", "buy")!).value.has("--signer-out")).toBe(false)
  })

  test("the reader's new reads: token edit's links, lab's flags by report kind, launch's fee wallet", () => {
    expect(sourceFor("token", "edit")!.flags!.value).toEqual(["--chain", "--clear", "--description", "--discord", "--idempotency-key", "--telegram", "--website", "--x"])
    expect(sourceFor("lab", "runners")!.flags!.value).toEqual(["--hours", "--min-wallets"])
    expect(sourceFor("lab", "edges")!.flags!.value).toEqual(["--days", "--min-n"])
    expect(sourceFor("launch", null)!.flags!.value).toContain("--fee-wallet")
  })
})

// The rows 0.13.5 adds or changes.
describe("the read at 0.13.5", () => {
  test("every new row has its rule, from the source", () => {
    const rules = Object.fromEntries(
      ["keys limit", "quant terms", "scan", "spend", "spend limit", "spend max-per-call", "spend pause", "spend resume", "token about", "token claim", "token clusters", "token events", "token flag", "token forensics", "token history", "token section", "token vamp-candidates"].map((p) => [p, `${rowFor(p)!.rule} ${rowFor(p)!.route}`]),
    )
    expect(rules).toEqual({
      "keys limit": "owner pane",
      "quant terms": "ceremony pane",
      scan: "mcp cli",
      spend: "never later",
      "spend limit": "never later",
      "spend max-per-call": "never later",
      "spend pause": "never later",
      "spend resume": "never later",
      "token about": "read cli",
      "token claim": "card later",
      "token clusters": "read cli",
      "token events": "mcp cli",
      "token flag": "card later",
      "token forensics": "mcp cli",
      "token history": "read cli",
      "token section": "card later",
      "token vamp-candidates": "mcp cli",
    })
    expect(rowFor("scan")!.mcpTool).toBe("candle_token_card")
    for (const p of ["token claim", "token section", "token flag"]) expect(rowFor(p)!.held).toContain("token-pages:write")
  })

  test("the paid reads unlock the vault to pay, so the core sends them to Candle's MCP tools, which don't pay", () => {
    for (const [p, tool] of [["token forensics", "candle_token_forensics"], ["token vamp-candidates", "candle_vamp_candidates"]] as const) {
      expect(unlocksFor(p)).toBe("always")
      expect(rowFor(p)).toMatchObject({ rule: "mcp", mcpTool: tool })
    }
  })

  test("keys limit takes the factor first and is withdrawn by the kill switch; quant terms is typed at the CLI's prompt", () => {
    expect(rowFor("keys limit")!.pane).toMatchObject({ factorFirst: true })
    expect(OWNER_STOPS.has("keys limit")).toBe(true)
    expect(rowFor("quant terms")!.pane).toMatchObject({ factorFirst: false, confirms: ["you'll type accept"] })
    expect(sourceFor("quant", "terms")!.tty).toEqual(["stdin"])
  })

  test("the changed rows: launch's whole flag list, --check a read, and the new terminal needs of auth login and setup", () => {
    const launch = sourceFor("launch", null)!
    expect(launch.flags!.value).toContain("--staker-allocation-bps")
    // 27 at 0.13.5, 0.13.9's three --fee-wallet flags, and 0.13.18's six for an allowlisted launch's caps and window.
    expect(launch.flags!.value.length).toBe(36)
    // 0.13.11 adds --require-fee-wallet.
    expect(launch.flags!.boolean).toEqual(["--check", "--dry-run", "--require-fee-wallet", "--yes"])
    expect(rowFor("launch")!.byFlags!(new Map([["--check", true]]))).toEqual({ rule: "read", route: "cli" })
    expect(rowFor("launch")!.byFlags!(new Map())).toBeUndefined()
    expect(sourceFor("auth", "login")!.tty).toEqual(["stdin", "stdout"])
    expect(sourceFor("setup", null)!.tty).toEqual(["stdin", "stdout"])
    // Paths, so never the agent's: an image goes up by image upload's card first.
    expect(sourceFor("agent", "profile")!.flags!.path).toEqual(["--avatar-file", "--banner-file"])
    expect(allowedFlags(sourceFor("agent", "profile")!).value.has("--avatar-file")).toBe(false)
  })
})

// The CLI read at 0.12.0 for the prompt pane, checked against a reading of the CLI's source by hand.
describe("the read at 0.12.0: the vault, the terminal and the presets", () => {
  test("rows that unlock the vault themselves, and rows that never do, as the CLI's source shows them", () => {
    const themselves = ["vault new-key", "vault rename", "vault reconcile-exposure", "vault promote", "vault promote-batch", "vault fund", "vault demote", "external new", "vault transfer", "tee sweep", "external sweep", "vault phrase", "vault factor add", "vault factor remove", "vault export-key", "sign", "sign message", "vault list", "vault backup", "vault verify-backup", "vault import-legacy", "vault retire-legacy", "external list"]
    const never = ["keys create", "keys access", "keys update", "keys signer approve", "keys signer move", "tee rebind", "wallets trust", "wallets allow-launch", "keys self", "keys wallets scope", "tee signer new", "tee new", "profile add", "profile use", "auth logout", "secrets set", "wallets import"]
    expect(themselves.filter((p) => unlocksFor(p) === "never" || unlocksFor(p) === undefined)).toEqual([])
    expect(never.filter((p) => unlocksFor(p) !== "never")).toEqual([])
    // Only when a vault exists, and for tee rename only when a wallet it names is a TEE wallet.
    expect(unlocksFor("tee enable")).toBe("if-vault")
    expect(unlocksFor("tee rename")).toBe("if-tee-and-vault")
    expect(unlocksFor("vault factor list")).toBe("never")
  })

  test("the three rows that take a piped stdout don't check it; keys create checks it only for its embedded-wallet confirm", () => {
    expect(sourceFor("vault", "status")!.tty).toEqual(["stdin", "stderr"])
    expect(sourceFor("vault", "list")!.tty).toEqual(["stdin", "stderr"])
    expect(sourceFor("keys", "create")!.tty).toContain("stdout")
    // Most owner rows check stdout, so their --json can't be captured.
    for (const p of ["keys access", "wallets trust", "tee rebind", "vault promote"]) expect(`${p}: ${baseOf(p)!.tty.includes("stdout")}`).toBe(`${p}: true`)
  })

  test("every row the core runs itself reaches no vault unlock, but behind a flag that sends it to the pane", () => {
    // Reviewed by hand: vault status unlocks only with --unlock, tee status only with --verify; perps
    // withdraw's status word returns before the withdrawal's unlock.
    const behindAFlag = new Set(["vault status", "tee status", "perps withdraw status"])
    const inCore = CLI_ROWS.filter((r) => ["read", "less-access", "card"].includes(r.rule) && r.route !== "later" && !runsInPane(r, r.rule))
    expect(inCore.filter((r) => unlocksFor(r.path) !== "never" && !behindAFlag.has(r.path)).map((r) => r.path)).toEqual([])
    expect(runsInPane(rowFor("vault status")!, "ceremony")).toBe(true)
    expect(runsInPane(rowFor("tee status")!, "owner")).toBe(true)
  })

  test("tee disable and tee fund find the wallet's key in the vault, so they run in the pane, though one narrows and one reads", () => {
    for (const p of ["tee disable", "tee fund"]) {
      expect(unlocksFor(p)).not.toBe("never")
      const row = rowFor(p)!
      expect(runsInPane(row, row.rule)).toBe(true)
      expect(row.pane).toMatchObject({ factorFirst: false })
      expect(row.pane!.needsPrompt).toContain("passphrase")
    }
    expect(rowFor("tee disable")!.rule).toBe("less-access")
  })

  test("the factor step comes first for exactly the owner rows the CLI runs without unlocking, and never twice", () => {
    const first = CLI_ROWS.filter((r) => r.pane?.factorFirst).map((r) => r.path)
    expect(first.sort()).toEqual(
      ["auth logout", "keys access", "keys create", "keys limit", "keys resume", "keys signer", "keys signer approve", "keys signer move", "keys update", "plan auto-renew", "plan auto-renew on", "profile add", "profile remove", "profile rename", "profile set", "profile use", "tee rebind", "tee rename", "tee signer", "tee signer new", "tee signer remove", "wallets allow-launch", "wallets trust"].sort(),
    )
    // tee rename unlocks only for a TEE wallet with a vault, where the core drops the step.
    for (const row of CLI_ROWS.filter((r) => r.pane?.factorFirst)) expect(`${row.path}: ${unlocksFor(row.path)}`).toBe(`${row.path}: ${row.path === "tee rename" ? "if-tee-and-vault" : "never"}`)
    // tee new asks for its own store's passphrase.
    expect(rowFor("tee new")!.pane!.factorFirst).toBe(false)
    // A browser, a signed release, a secret typed in the pane: no factor step.
    for (const p of ["auth login", "setup", "update", "vault init", "secrets set", "wallets import"]) expect(`${p}: ${rowFor(p)!.pane!.factorFirst}`).toBe(`${p}: false`)
  })

  test("every owner, ceremony and funds-out row the pane runs has a pane, and nothing later does", () => {
    for (const row of CLI_ROWS) {
      if (PANE_RULES.has(row.rule) && row.route === "pane") expect(`${row.path}: ${row.pane !== undefined}`).toBe(`${row.path}: true`)
      if (row.route === "later") expect(`${row.path}: ${row.pane}`).toBe(`${row.path}: undefined`)
    }
  })

  test("the pane's specs: three captures, --yes for profile remove only, and only the source's own paths asked for", () => {
    const captures = Object.fromEntries(CLI_ROWS.filter((r) => r.pane?.capture).map((r) => [r.path, r.pane!.capture]))
    expect(captures).toEqual({ "keys create": "new-key", "vault status": "code", "vault list": "addresses" })
    expect(CLI_ROWS.filter((r) => r.pane?.addsYes).map((r) => r.path)).toEqual(["profile remove"])
    for (const row of CLI_ROWS.filter((r) => r.pane?.askPaths)) {
      const flags = baseOf(row.path)!.flags!
      for (const ask of row.pane!.askPaths!) expect(`${row.path} ${ask.flag}: ${[...flags.path, ...flags.pathPositionals].includes(ask.flag)}`).toBe(`${row.path} ${ask.flag}: true`)
    }
  })

  test("the corrections at 0.12.0", () => {
    const of = (p: string) => rowFor(p)!
    // Not an owner row: the bare word prints its usage, and its one subcommand narrows.
    expect(of("keys self")).toMatchObject({ rule: "less-access", route: "cli" })
    expect(of("keys wallets scope")).toMatchObject({ rule: "never", identity: "agent" })
    expect(of("keys wallets scope").byFlags!(new Map([["--scope", "selected"]]))).toEqual({ rule: "less-access", route: "cli" })
    expect(of("tee enable")).toMatchObject({ rule: "owner", identity: "agent" })
    expect(of("tee signer new")).toMatchObject({ rule: "owner", identity: "agent" })
    for (const p of ["vault list", "vault factor remove", "vault backup", "vault verify-backup", "vault import-legacy", "vault retire-legacy", "external list", "profile add", "profile use", "profile rename", "profile set", "auth logout", "profile remove"]) {
      expect(`${p}: ${of(p).rule}`).toBe(`${p}: owner`)
    }
    expect(of("tee status").byFlags!(new Map([["--verify", true]]))).toEqual({ rule: "owner", route: "pane" })
    for (const p of ["auth login", "setup", "update"]) expect(`${p}: ${of(p).rule}`).toBe(`${p}: ceremony`)
    // Funds out go only by the owner's vault-signed routes: held, with why.
    expect(of("transfer")).toMatchObject({ rule: "funds-out", route: "later" })
    expect(of("transfer").held).toContain("Withdraw key")
  })

  test("the presets are read from the source: Write's exact scopes, and the LP agent's key is Write plus lp:write", () => {
    // docs.candle.tv/developers/agent-access, "Access levels".
    expect(SOURCE.presets.readwrite).toEqual({ label: "Write", scopes: ["launch:write", "launch:read", "activity:write", "swap:write", "account:read"] })
    expect(SOURCE.presets.read).toEqual({ label: "Read", scopes: ["account:read"] })
    expect(SOURCE.presets.readwritetransfer.scopes).toEqual([...SOURCE.presets.readwrite.scopes.slice(0, 4), "transfer:write", "account:read", "transfer:bound"])
    expect(LP_AGENT_SCOPES.join(",")).toBe("launch:write,launch:read,activity:write,swap:write,account:read,lp:write")
    // No preset holds lp:write, so the LP key is a custom list.
    for (const preset of Object.values(SOURCE.presets)) expect(preset.scopes).not.toContain("lp:write")
  })
})

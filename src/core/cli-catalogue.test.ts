// The commands pane's catalogue: every row of the parity table, in the CLI's own groups, described in
// the CLI's own words.
import { describe, expect, test } from "bun:test"
import { CATALOGUE, helpLine, searchCatalogue } from "./cli-catalogue"
import { CLI_ROWS, SOURCE } from "./cli-table"
import { paneRowNow } from "./owner-rows"

const entry = (path: string) => CATALOGUE.find((e) => e.path === path)!

describe("the catalogue", () => {
  test("holds every command the CLI routes and every row of the table, once each", () => {
    const paths = CATALOGUE.map((e) => e.path)
    expect(new Set(paths).size).toBe(paths.length)
    expect(paths.length).toBe(CLI_ROWS.length)
    for (const c of SOURCE.commands) expect(paths).toContain(c.subcommand ? `${c.command} ${c.subcommand}` : c.command)
  })

  test("is grouped as the CLI's help groups it, in the help's order", () => {
    expect(SOURCE.groups).toEqual(["Start here", "Trade", "Account", "Custody, on this machine", "Your own services", "Maintain"])
    const order = CATALOGUE.map((e) => SOURCE.groups.indexOf(e.group))
    expect(order.every((g) => g >= 0)).toBe(true)
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(entry("keys revoke").group).toBe("Account")
    expect(entry("tee status").group).toBe("Custody, on this machine")
    expect(entry("tui").group).toBe("Start here")
  })

  test("describes each row in the CLI's own words, one line", () => {
    expect(entry("keys revoke").description).toBe("Revoke an API key permanently")
    expect(entry("keys create").description).toBe("Create an API key")
    // The bare command is its summary.
    expect(SOURCE.help.swap!.summary).toStartWith("Quote, confirm and swap on Solana or Hood, bridge between them; ")
    expect(entry("swap").description).toBe("Quote, confirm and swap on Solana or Hood, bridge between them")
    // Not cut inside a parenthesis, and a computed tail goes.
    expect(entry("tee rebinds").description).toBe("List TEE wallet rebinds for this account (owner only)")
    expect(entry("vault factor").description).toBe("Manage the factors that open the vault")
    // A second word indented under a subcommand, and alternatives in one row.
    expect(entry("keys signer move").description).toStartWith("On the machine holding a wallet's current signer")
    expect(entry("keys wallets set").description).toStartWith("Replace the profile's wallet set")
    expect(entry("agent post create").description).toBe(entry("agent post delete").description)
    expect(entry("perps reduce-only on").description).toBe(entry("perps reduce-only").description)
    expect(entry("vault factor list").description).toStartWith("Manage the factors that open the vault")
    for (const e of CATALOGUE) {
      expect(e.description.length).toBeGreaterThan(0)
      expect(e.description).not.toContain("\n")
      expect(e.description.split("(").length).toBe(e.description.split(")").length)
    }
  })

  test("every row is documented by the CLI's help, so a row for a word the help dropped stands out", () => {
    expect(CATALOGUE.filter((e) => !e.documented).map((e) => e.path)).toEqual([])
    expect(helpLine(SOURCE.help, "keys signer move").exact).toBe(true)
    expect(helpLine(SOURCE.help, "perps deposit status").exact).toBe(true)
    expect(helpLine(SOURCE.help, "perps thresholds set").exact).toBe(true)
    expect(helpLine(SOURCE.help, "keys signer vanish").exact).toBe(false)
    expect(helpLine(SOURCE.help, "nonsense").exact).toBe(false)
  })

  test("says what the agent meets and whether it can do it now", () => {
    expect(entry("keys revoke")).toMatchObject({ rule: "less-access", ruleLabel: "narrows access", availability: "now" })
    expect(entry("keys list")).toMatchObject({ ruleLabel: "read", availability: "now" })
    expect(entry("portfolio")).toMatchObject({ rule: "mcp", ruleLabel: "read", availability: "now" })
    expect(entry("lp add")).toMatchObject({ ruleLabel: "card", availability: "coming" })
    expect(entry("keys create")).toMatchObject({ ruleLabel: "owner step", availability: "now" })
    expect(entry("vault promote")).toMatchObject({ ruleLabel: "owner step", availability: "now" })
    expect(entry("vault init")).toMatchObject({ ruleLabel: "in the terminal", availability: "now" })
    expect(entry("vault phrase")).toMatchObject({ ruleLabel: "in the terminal", availability: "now" })
    expect(entry("vault transfer")).toMatchObject({ ruleLabel: "funds out", availability: "now" })
    expect(entry("tee sweep")).toMatchObject({ ruleLabel: "funds out", availability: "now" })
    expect(entry("transfer")).toMatchObject({ ruleLabel: "funds out", availability: "coming" })
    expect(entry("transfer").why).toContain("Withdraw key")
    expect(entry("completion")).toMatchObject({ rule: "never", availability: "never" })
    expect(entry("keys access").partly).toContain("now")
  })

  test("every row whose rule depends on its flags says how", () => {
    for (const row of CLI_ROWS.filter((r) => r.byFlags)) expect(`${row.path}: ${Boolean(row.partly)}`).toBe(`${row.path}: true`)
  })

  test("a row the agent never runs puts nothing on the line, and says why; unless a narrowing of it runs", () => {
    for (const e of CATALOGUE.filter((e) => e.availability === "never")) {
      expect(e.note?.length).toBeGreaterThan(0)
      if (e.path === "keys wallets scope") expect(e.request).toBe("limit a profile to assigned wallets ")
      else expect(e.request).toBeUndefined()
    }
  })

  test("a held row says why it's coming (transfer, which needs a Withdraw key)", () => {
    expect(entry("transfer")).toMatchObject({ availability: "coming" })
    expect(entry("transfer").why).toContain("Withdraw key")
  })

  test("every row that runs in the prompt pane is now, with its rule in words", () => {
    expect(entry("keys create").how).toBe("owner: the factor first")
    expect(entry("tee rename").how).toBe("owner: the factor first")
    expect(entry("vault list").how).toBe("the CLI asks for the factor")
    expect(entry("vault promote").how).toBe("the CLI asks for the factor")
    expect(entry("tee disable").how).toBe("the CLI asks for the factor")
    expect(entry("tee fund").how).toBe("the CLI asks for the factor")
    expect(entry("vault phrase").how).toBe("you complete it in the pane")
    expect(entry("auth login").how).toBe("you complete it in the pane")
    expect(entry("tee new").how).toBe("you complete it in the pane")
    expect(entry("vault transfer").how).toBe("moves funds")
    expect(entry("tee sweep").how).toBe("moves funds")
    // Rows that don't run in the pane as listed have no such words: a read, a narrowing, a card.
    for (const path of ["keys revoke", "vault status", "tee status", "stake add", "portfolio"]) expect(`${path}: ${entry(path).how}`).toBe(`${path}: undefined`)
    for (const row of CLI_ROWS.filter((r) => paneRowNow(r.rule, r.route))) {
      const e = entry(row.path)
      expect(`${row.path}: ${e.availability} ${e.how !== undefined}`).toBe(`${row.path}: now true`)
    }
  })

  test("a pane row carries the CLI's own prompts and what it shows, in the card's words", () => {
    expect(entry("keys access").asks).toEqual(["to widen it, you'll type the key's prefix"])
    expect(entry("vault phrase").shows).toBe("Shows your 24 words.")
    expect(entry("keys create").asks).toBeUndefined()
  })

  test("every row still coming says why", () => {
    for (const e of CATALOGUE.filter((e) => e.availability === "coming")) expect(`${e.path}: ${(e.why?.length ?? 0) > 0}`).toBe(`${e.path}: true`)
    expect(entry("perps open").why).toContain("later release")
  })

  test("every other row's request is plain English: the CLI's line, lower-cased where it starts a sentence", () => {
    expect(entry("keys revoke").request).toBe("revoke an API key permanently ")
    expect(entry("stake add").request).toBe("stake decimal CNDL in the selected wallet ")
    for (const e of CATALOGUE.filter((e) => e.availability !== "never")) expect(e.request).toMatch(/^(?:[^A-Z]|[A-Z][^a-z])/)
  })
})

describe("searching", () => {
  test("an empty search is everything, in order", () => {
    expect(searchCatalogue("")).toEqual(CATALOGUE)
  })

  test("every word must match, in the path, the description, the group or the rule, any case", () => {
    expect(searchCatalogue("revoke").map((e) => e.path)).toEqual(expect.arrayContaining(["keys revoke", "wallets revoke"]))
    expect(searchCatalogue("KEYS revoke").map((e) => e.path)).toContain("keys revoke")
    expect(searchCatalogue("keys revoke").map((e) => e.path)).not.toContain("wallets revoke")
    expect(searchCatalogue("narrows").every((e) => e.ruleLabel === "narrows access" || e.description.toLowerCase().includes("narrow"))).toBe(true)
    expect(searchCatalogue("custody").length).toBeGreaterThan(10)
    expect(searchCatalogue("factor first").map((e) => e.path)).toEqual(expect.arrayContaining(["keys create", "tee rename"]))
    expect(searchCatalogue("moves funds").map((e) => e.path)).toEqual(expect.arrayContaining(["vault transfer", "tee sweep", "external sweep"]))
    expect(searchCatalogue("zzzz-nothing")).toEqual([])
  })
})

// The trader prompt: the rules it must carry.
import { expect, test } from "bun:test"
import { researchLine, traderPrompt } from "./prompt"

const base = { agent: "momentum", mode: "live" as const, researchDir: "/tmp/research", stepCap: 30 }
const prompt = traderPrompt(base)

test("the agent doesn't restate the card: one sentence for what it proposed and why", () => {
  expect(prompt).toContain("The card shows the amounts, the price, the wallet, the limits and the expiry.")
  // A ticker can name hundreds of tokens, so be sure before proposing.
  expect(prompt).toContain("one name can match hundreds of tokens. Trade only a mint you got from a tool this turn.")
  // An agent once found one token by a popular name in three feeds and proposed it. Always confirm a name:
  // Hacc's search is fuzzy, across both chains, and never sure it found every copy.
  expect(prompt).toContain("even if your search found just one: searches are fuzzy and none can promise it found every copy")
  expect(prompt).toContain("Go straight to a card only for a mint they pasted, a token they confirmed earlier in this conversation, or one they hold")
  // A token the wallets hold exactly one of by that name is the one meant; two still ask.
  expect(prompt).toContain("when their wallets hold exactly one token by that name or ticker (candle_get_portfolio), that holding is the token they mean")
  expect(prompt).toContain("If they hold two or more by that name, ask which.")
  expect(prompt).toContain("say in one sentence what you proposed and why, and don't repeat the card's figures or the trade id")
  // A live turn after the first wording still listed the price, market cap, liquidity and expiry.
  expect(prompt).toContain("The token pane shows its price, market cap, liquidity and safety check, so leave those out too")
  expect(prompt).toContain("No lists or headings after a proposal.")
})

test("the rules it already carried stay", () => {
  expect(prompt).toContain('say "I\'ve proposed …", never "I bought …"')
  expect(prompt).toContain("Give each proposal a short reason; it shows on the card.")
  expect(prompt).toContain("Never state an address, mint, price, balance or figure you didn't get from a tool in this turn.")
  expect(prompt).toContain("A turn stops after 30 tool calls")
})

test("funds out only when the person asks this turn, to the destination they named", () => {
  expect(prompt).toContain("Never propose one unless their own message this turn asks for it, naming where it goes and how much")
  expect(prompt).toContain("Name the destination as they did, by its label or its address in full; never pick one for them.")
})

test("the research line names what this engine has", () => {
  // Claude Code's: its own web and file tools.
  expect(prompt).toContain("Your research folder is /tmp/research. You can search the web, fetch pages, and read and write notes there, and nowhere else. A turn stops after 30 tool calls")
  // Codex with the shell off: writes with its own tools, reads through the core's.
  expect(researchLine("/r", { webSearch: true, webFetch: false, files: "write" })).toBe(
    "Your research folder is /r. You can search the web, and write notes there with your file tools and read them with research_read and research_list, and nowhere else.",
  )
  // Pi: fetch only.
  expect(researchLine("/r", { webSearch: false, webFetch: true, files: "own" })).toBe(
    "Your research folder is /r. You can fetch a web page by its URL, and read and write notes there, and nowhere else. There's no web search here.",
  )
  // An engine whose own file tools aren't held on this platform.
  expect(researchLine("/r", { webSearch: false, webFetch: false, files: "none" })).toBe(
    "Your research folder is /r. You can read what's there with research_read and research_list, and nowhere else. There's no web access here. You have no tools to write notes here.",
  )
})

test("only the person switches the engine: asked to, the agent says how", () => {
  expect(prompt).toContain("Only the person picks which engine and model you run on, since it spends their subscription or credit: ctrl-g, or the chip on your pane's border. You can't switch; asked to, tell them that.")
})

test("the prompt calls what the agent runs on an engine, as the screen does", () => {
  expect(prompt).not.toMatch(/which harness|whichever harness/)
})

test("the research line follows the agent's tool settings and shell", () => {
  const claude = { webSearch: true, webFetch: true, files: "own" as const, shellList: true }
  expect(researchLine("/r", claude, { shell: "off", deny: ["web_search", "write"] })).toBe(
    "Your research folder is /r. You can fetch a web page by its URL, and read notes there, and nowhere else. There's no web search here. You have no tools to write notes here.",
  )
  expect(researchLine("/r", claude, { shell: "off", allow: ["candle_*"], deny: [] })).toBe("Your research folder is /r. There's no web access here. You have no file tools here.")
  const list = researchLine("/r", claude, { shell: ["ls", "git log"], deny: [] })
  expect(list).toContain("You have a shell, started in your research folder, for ls, git log only: one plain command at a time, with no ;, &&, |, redirects or $(…).")
  expect(list).toContain("Never run the candle CLI, or anything that trades, signs or moves funds, in the shell")
  // Codex can't hold a list: the agent isn't told of a shell it doesn't have.
  const codex = researchLine("/r", { webSearch: true, webFetch: false, files: "write", shellList: false }, { shell: ["ls"], deny: [] })
  expect(codex).not.toContain("shell")
  expect(researchLine("/r", { webSearch: true, webFetch: false, files: "write", shellList: false }, { shell: "everything", deny: [] })).toContain("You have a shell, started in your research folder. Never run the candle CLI")
})

test("Hacc's data line sits beside Candle's tools when given, and is absent when not", () => {
  const line = "Hacc, Candle's market data engine, is yours through the same server: hacc_signals (the signal tape). This account is on Pro."
  const withData = traderPrompt({ agent: "momentum", mode: "live", researchDir: "/tmp/research", stepCap: 30, data: line })
  expect(withData).toContain(`Use them for every fact about tokens, prices, wallets and positions.\n- ${line}\n- A live trade`)
  expect(prompt).not.toContain("Hacc")
})

test("where triggers are offered, a turn can start from one and later work is a trigger; where they aren't, the agent acts only on a message", () => {
  const offered = traderPrompt({ ...base, triggers: true })
  expect(offered).toContain("a trigger they approved wakes you")
  expect(offered).toContain("propose it with harness_triggers")
  expect(offered).not.toContain("You act only when the person messages you")
  const free = traderPrompt(base)
  expect(free).toContain("You act only when the person messages you")
  expect(free).not.toContain("harness_triggers")
})

test("how the agent writes for the pane: Markdown, names over ids, no closing disclaimers, a question for the next step", () => {
  const p = traderPrompt({ agent: "momentum", mode: "live", researchDir: "/tmp/research", stepCap: 30 })
  expect(p).toContain("The pane renders Markdown")
  expect(p).toContain("Give an id only when the person needs it to act")
  expect(p).toContain("No closing disclaimers or repeated caveats")
  expect(p).toContain("end with one direct question offering it")
  expect(p).toContain("unless you say it's from memory")
})

test("the code runner is named in the research line only where it's on: off says nothing of it", () => {
  const can = { webSearch: true, webFetch: true, files: "own" as const }
  expect(researchLine("/r", can)).not.toMatch(/research_run|run a script/)
  expect(researchLine("/r", can, { shell: "off", deny: [], run: "off" })).not.toMatch(/research_run|run a script/)
  expect(researchLine("/r", can, { shell: "off", deny: [], run: ["python3", "node"] })).toContain("run a script with research_run, on the candle MCP server: python3, node, held to your research folder with no network.")
})

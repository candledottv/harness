// A stand-in for Candle's MCP server with two tools, fake data, no network and no keys, for the engine
// live tests that check what a harness offers and calls. Run: bun test/fake-candle-mcp-mini.ts [proposals.jsonl]
import { appendFileSync } from "node:fs"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"

export const FAKE_TOKENS = [
  { symbol: "MOON", mint: "MoonFake11111111111111111111111111111111111", priceSol: 0.0042, change24h: 38.5, volumeSol: 1520 },
  { symbol: "PEPE", mint: "PepeFake11111111111111111111111111111111111", priceSol: 0.0011, change24h: -4.2, volumeSol: 860 },
]

const proposalsLog = process.argv[2]
const server = new McpServer({ name: "candle", version: "0.0.0-fake" })

server.registerTool(
  "get_trending",
  { description: "Tokens trending on Candle right now, with their mint addresses, price in SOL and 24h change.", inputSchema: {} },
  async () => ({ content: [{ type: "text", text: JSON.stringify({ tokens: FAKE_TOKENS }) }] }),
)

server.registerTool(
  "propose_trade",
  {
    description: "Propose a trade. It becomes an approval card the user approves or rejects; nothing executes until then.",
    inputSchema: { mint: z.string(), side: z.enum(["buy", "sell"]), sol: z.number().positive() },
  },
  async ({ mint, side, sol }) => {
    if (proposalsLog) appendFileSync(proposalsLog, `${JSON.stringify({ mint, side, sol, at: new Date().toISOString() })}\n`)
    return { content: [{ type: "text", text: JSON.stringify({ card: "pending", mint, side, sol }) }] }
  },
)

await server.connect(new StdioServerTransport())

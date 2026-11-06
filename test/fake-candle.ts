// The fake `candle`: `candle mcp` is the fake MCP server, anything else the fake CLI, as the real
// binary serves both (the core starts `candle mcp` and runs `candle <command>` for candle_cli).
if (process.argv[2] === "mcp") await import("./fake-candle-mcp")
else await import("./fake-candle-cli")
export {}

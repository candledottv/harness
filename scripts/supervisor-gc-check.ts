// A code bot that dies on start must not take the core down at the next garbage
// collection. The real Supervisor runs a bot whose bot.ts doesn't parse, in a plain Bun process (not the test
// runner, which reports such errors differently), with a full GC every 50 ms while it crashes and restarts. A
// FileHandle left open and closed by GC is an uncaught error in Bun 1.4.4: it's printed ("A FileHandle object was
// closed during garbage collection") and this process exits 1, at once or at its end. With none, it exits 0.
//
// `ps` answers in a few milliseconds on an idle Mac, often before a bot that doesn't parse has exited, so the window
// only opens now and then. `slowPsMs` (default 150) waits that long before the start's `ps` read, as a busy machine's
// `ps` does, so the window opens on every start; 0 leaves the core's own `ps` read alone.
//
//   bun scripts/supervisor-gc-check.ts [ms] [slowPsMs]
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Journal, JournalRow } from "../src/core/journal"
import { Supervisor } from "../src/core/supervisor"

const runMs = Number(process.argv[2] ?? 3_000)
const slowPsMs = Number(process.argv[3] ?? 150)
const dir = mkdtempSync(join(tmpdir(), "chrn-gc-"))
const folder = join(dir, "bot")
const state = join(dir, "state")
mkdirSync(folder)
mkdirSync(state)
writeFileSync(join(folder, "bot.ts"), "const x = ;\n")

const rows: JournalRow[] = []
const journal = { append: async (row: Record<string, unknown>) => void rows.push(row as JournalRow) } as unknown as Journal
const spec = { folder, command: [process.execPath, "bot.ts"], agent: "momentum" }
const sup = new Supervisor({
  statePath: join(state, "supervisor.json"),
  logsDir: join(state, "bot-logs"),
  socketPath: join(state, "core.sock"),
  journal,
  mode: () => "live",
  now: Date.now,
  parentEnv: { PATH: process.env.PATH, HOME: process.env.HOME },
  redact: (t) => t,
  names: () => ["broken"],
  wanted: () => ({ start: true, keep: true, spec }),
  issueToken: async () => ({ token: "chb_gccheck0000_ssssssssssssssssssssssssssssss" }),
  onChange: () => {},
  tuning: { backoffMs: [50, 100, 150], crashLimit: 1_000, stopGraceMs: 1_000 },
  ...(slowPsMs > 0 ? { identify: async () => void (await Bun.sleep(slowPsMs)) } : {}),
})
const gc = setInterval(() => Bun.gc(true), 50)
await sup.start()
await Bun.sleep(runMs)
await sup.stopAll("test")
clearInterval(gc)
for (let i = 0; i < 5; i++) {
  Bun.gc(true)
  await Bun.sleep(20)
}
const crashes = rows.filter((r) => r.type === "bot.process" && r.what === "crashed").length
rmSync(dir, { recursive: true, force: true })
console.log(`${crashes} crashes and restarts under GC`)
// Not process.exit: an uncaught error already seen leaves Bun's own exit code (1) in place.
if (crashes === 0) process.exitCode = 2

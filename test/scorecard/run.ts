// The scorecard, live: every case on one real engine and model, each in a fresh
// core against the fake Candle and the fake Hacc. Writes test/scorecard/results/<engine>[ <model>].json
// and prints the case table. Costs a little of the harnesses' subscriptions, or an OpenRouter key.
//   bun test/scorecard/run.ts claude-code
//   bun test/scorecard/run.ts pi openrouter/deepseek/deepseek-v4.1-flash
//   bun test/scorecard/run.ts codex --only ticker,planted
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { isEngineId } from "../../src/engine/engine"
import { cleanupHomes } from "../core-fixture"
import { CASES } from "./cases"
import { type CaseResult, runCase, signOut } from "./run-case"

const args = process.argv.slice(2)
const only = args.includes("--only") ? args[args.indexOf("--only") + 1]!.split(",") : undefined
const [engine, model] = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--only")
if (!engine || !isEngineId(engine)) {
  console.error("usage: bun test/scorecard/run.ts <claude-code|codex|grok|opencode|pi> [model] [--only id,id]")
  process.exit(2)
}
const spec = { engine, ...(model ? { model } : {}), openrouter: model?.startsWith("openrouter/") ?? false }
const raw = process.env.SCORECARD_RAW ? [] as string[] : undefined

const results: CaseResult[] = []
for (const c of CASES.filter((c) => !only || only.includes(c.id))) {
  const r = await runCase(c, spec, raw ? { onRaw: (l) => raw.push(l) } : {})
  results.push(r)
  const failed = r.checks.filter((k) => !k.pass)
  console.log(`${r.pass ? "PASS" : "FAIL"} ${c.id} (${Math.round(r.notes.ms / 1000)}s)${r.error ? `: couldn't run: ${r.error}` : failed.map((k) => `\n  ✗ ${k.name}: ${k.why}`).join("")}`)
  for (const t of r.turns) console.log(`  > ${t.user}\n  < ${t.reply.replace(/\n/g, "\n    ")}`)
}
cleanupHomes()
signOut()

const dir = join(import.meta.dir, "results")
mkdirSync(dir, { recursive: true })
const name = `${engine}${model ? ` ${model.replace(/\//g, "_")}` : ""}${only ? ` only-${only.join("-")}` : ""}.json`
const ran = results.find((r) => r.ran)?.ran
writeFileSync(join(dir, name), `${JSON.stringify({ engine, model: model ?? null, ran: ran ?? null, at: new Date().toISOString(), results }, null, 2)}\n`)
if (raw && process.env.SCORECARD_RAW) writeFileSync(process.env.SCORECARD_RAW, raw.join("\n"))
console.log(`\n${engine}${model ? ` · ${model}` : ""}: ${results.filter((r) => r.pass).length} of ${results.length} passed → results/${name}`)

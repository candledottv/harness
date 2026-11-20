// Preload for the published-package run (BE-3863): `bun --preload scripts/perps-unified-preload.ts <shipped entry point>`.
// Replaces the network with the offline unified-account stand-ins before the shipped CLI or MCP server starts, pins the clock,
// and appends every request to a log. Anything outside the stand-ins is refused by `makeFetcher`.
import { appendFileSync } from "node:fs"
import { NOW, VENUES, makeFetcher, type VenueName } from "./perps-unified-stub"

const scenario = JSON.parse(process.env.PERPS_UNIFIED_STUB ?? "null") as {
  venue: VenueName
  unifiedAccounts: boolean | "omit"
  setupReady?: boolean
  positionsBody?: Record<string, unknown>
} | null
const log = process.env.PERPS_UNIFIED_LOG
if (!scenario || !log) throw new Error("PERPS_UNIFIED_STUB and PERPS_UNIFIED_LOG are required")

const sink = { push: (req: unknown) => void appendFileSync(log, `${JSON.stringify(req)}\n`) } as never
const offline = makeFetcher(sink, {
  venue: VENUES[scenario.venue],
  unifiedAccounts: scenario.unifiedAccounts,
  setupReady: scenario.setupReady,
  positionsBody: scenario.positionsBody,
})
globalThis.fetch = offline
Date.now = () => NOW

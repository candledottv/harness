// The chains the account was last known to use, kept across a core restart (`state/chains-used.json`, 0600), so a
// core that has just started shows the chain chip and the headings at once, not a one-chain screen until its first
// portfolio read.
import { readFileSync } from "node:fs"
import { chmod, rename, writeFile } from "node:fs/promises"
import { randomBytes } from "node:crypto"
import { type ChainSlug, maybeChain } from "../shared/chains"

/** What the last core knew, read once at start: only chains this build knows, Solana always among them. */
export function readChainsKnown(path: string): ChainSlug[] {
  try {
    const raw = (JSON.parse(readFileSync(path, "utf8")) as { chains?: unknown }).chains
    const known = Array.isArray(raw) ? raw.map((c) => maybeChain(c)?.slug).filter((c): c is ChainSlug => c !== undefined) : []
    return [...new Set<ChainSlug>(["solana", ...known])]
  } catch {
    return ["solana"]
  }
}

/** Kept for the next core: written whole, 0600. */
export async function saveChainsKnown(path: string, chains: readonly ChainSlug[], now: number): Promise<void> {
  const temp = `${path}.tmp-${randomBytes(6).toString("base64url")}`
  await writeFile(temp, `${JSON.stringify({ chains, at: new Date(now).toISOString() })}\n`, { mode: 0o600, flag: "wx" })
  await chmod(temp, 0o600)
  await rename(temp, path)
}

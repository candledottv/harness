// That this machine has had a vault. With no vault, owner steps run in the
// prompt pane without the factor, approved by the person there. Once the core has seen a vault, it
// keeps this mark (state/vault-seen.json, 0600), so a vault that vanishes can't turn the factor off:
// with the mark and no vault, owner steps are refused, naming `candle vault restore`. Only the person's
// own typed `forget vault`, from a main view, with no vault there, removes it. The file is read fresh
// every time, so nothing cached outlives a change.
import { existsSync } from "node:fs"
import { chmod, rename, rm, writeFile } from "node:fs/promises"
import { randomBytes } from "node:crypto"

/** What an owner step is refused with when the vault is gone after the mark. */
export const VAULT_GONE =
  "This machine had a vault, and the CLI can't find it now, so owner steps are refused rather than run without your factor. Restore it from its backup with candle vault restore. If you removed it on purpose, type forget vault in the Candle Harness."

/** What the card's steps, and the pane's header, say when there's no vault. */
export const NO_VAULT_STEP = "no vault: approved by you in the pane"

export class VaultMark {
  constructor(private readonly deps: { file: string; now: () => number }) {}

  seen(): boolean {
    return existsSync(this.deps.file)
  }

  /** Records a vault the core read. True when the mark is new. */
  async note(): Promise<boolean> {
    if (this.seen()) return false
    const temp = `${this.deps.file}.tmp-${randomBytes(6).toString("base64url")}`
    await writeFile(temp, `${JSON.stringify({ seenAt: new Date(this.deps.now()).toISOString() })}\n`, { mode: 0o600, flag: "wx" })
    await chmod(temp, 0o600)
    await rename(temp, this.deps.file)
    return true
  }

  /** The person's `forget vault`. True when there was a mark to remove. */
  async forget(): Promise<boolean> {
    if (!this.seen()) return false
    await rm(this.deps.file, { force: true })
    return true
  }
}

// An agent's default wallet, followed by address: config.toml names an agent's default wallet as the person
// wrote it, most often a name. A rename (`tee rename`, or a name of the Candle Harness's own) would leave that line
// naming no wallet, so every trade naming none would be refused, though a renamed wallet's default should
// follow its address. So the address a line was last found at is kept here, by agent and with the line it
// was found for, in state/default-wallets.json (0600). While the line is unchanged it pays
// from that address, whatever the wallet is called now or whoever takes its old name; once the person edits
// the line, it's found again. The person's config.toml is never written.
import { readFileSync, renameSync, writeFileSync } from "node:fs"

export interface DefaultPin {
  /** The line as config.toml has it (`agents.<agent>.wallet`). */
  setting: string
  address: string
}

// Shaped like an address, nothing more: what pays is checked against the wallets read, never against this.
const ADDRESS = /^(?:[A-Za-z0-9]{32,44}|0x[0-9a-fA-F]{40})$/

/** The pins as kept, or none: a file that's missing or unreadable pins nothing, and each is found again. */
export function readDefaultPins(file: string): Record<string, DefaultPin> {
  try {
    const body = JSON.parse(readFileSync(file, "utf8")) as { pins?: Record<string, unknown> }
    const out: Record<string, DefaultPin> = {}
    for (const [agent, raw] of Object.entries(body.pins ?? {})) {
      const pin = raw as Partial<DefaultPin> | null
      if (typeof pin?.setting === "string" && typeof pin.address === "string" && ADDRESS.test(pin.address)) out[agent] = { setting: pin.setting, address: pin.address }
    }
    return out
  } catch {
    return {}
  }
}

/** The address `setting` was last found at for this agent, when the line is still the one it was found for. */
export function pinnedAddress(pins: Record<string, DefaultPin>, agent: string, setting: string | undefined): string | undefined {
  const pin = pins[agent]
  return setting !== undefined && pin?.setting === setting ? pin.address : undefined
}

export class DefaultPins {
  private readonly pins: Record<string, DefaultPin>

  constructor(private readonly file: string) {
    this.pins = readDefaultPins(file)
  }

  get(agent: string, setting: string | undefined): string | undefined {
    return pinnedAddress(this.pins, agent, setting)
  }

  /** Kept at once: it's written rarely (a line found for the first time, or after an edit), and a rename may follow straight after. */
  set(agent: string, setting: string, address: string): void {
    if (!ADDRESS.test(address)) return
    const was = this.pins[agent]
    if (was?.setting === setting && was.address === address) return
    this.pins[agent] = { setting, address }
    const temp = `${this.file}.tmp`
    try {
      writeFileSync(temp, `${JSON.stringify({ pins: this.pins })}\n`, { mode: 0o600 })
      renameSync(temp, this.file)
    } catch {
      // Not kept: the line is found by its name again next time, as before.
    }
  }
}

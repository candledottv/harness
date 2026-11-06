// What the core has fetched since it started: every call through an agent's key, the
// bytes of Candle's MCP answers, Hacc's reads and bytes, and its stream's frames and bytes. Totals only,
// never rows or keys; `core.usage` answers them to a view, and the resource sampler reads them once a
// minute and takes the differences. Kept off the `status` topic, so counting never pushes a frame to a view.

export interface UsageTotals {
  /** When the core started counting (its start), in ms. */
  since: number
  /** Calls through each agent's key (MCP tool calls and the CLI's runs, as the budget counts them), and the bytes of its MCP answers. */
  candle: Record<string, { calls: number; bytes: number }>
  /** Hacc's HTTP reads: requests made and bytes of their answers. */
  hacc: { requests: number; bytes: number }
  /** Hacc's signal stream: frames and their bytes. */
  stream: { frames: number; bytes: number }
}

export class Usage {
  private readonly candle = new Map<string, { calls: number; bytes: number }>()
  private readonly hacc = { requests: 0, bytes: 0 }
  private readonly stream = { frames: 0, bytes: 0 }

  constructor(private readonly since: number) {}

  private of(agent: string) {
    let u = this.candle.get(agent)
    if (!u) this.candle.set(agent, (u = { calls: 0, bytes: 0 }))
    return u
  }

  candleCall(agent: string, n = 1): void {
    this.of(agent).calls += n
  }

  candleBytes(agent: string, bytes: number): void {
    this.of(agent).bytes += bytes
  }

  haccRead(bytes: number): void {
    this.hacc.requests++
    this.hacc.bytes += bytes
  }

  streamFrame(bytes: number): void {
    this.stream.frames++
    this.stream.bytes += bytes
  }

  totals(): UsageTotals {
    return {
      since: this.since,
      candle: Object.fromEntries([...this.candle].map(([a, u]) => [a, { ...u }])),
      hacc: { ...this.hacc },
      stream: { ...this.stream },
    }
  }
}

/** A string's size on the wire. */
export const utf8Bytes = (s: string): number => Buffer.byteLength(s, "utf8")

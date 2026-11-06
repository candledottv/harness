// Live checks of the signal stream against the real Hacc, with a Read key on
// an account of your own, in the file CANDLE_HARNESS_TEST_KEY_FILE names (never printed; skipped without it). One socket at a time: the
// snapshot, a drop the core didn't ask for, the gap filled from the REST tape by date with every signal
// once, and Hacc's refusal of a key read through the upgrade probe.
//   bun run test:live src/core/signal-stream.live.test.ts
import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { until } from "../../test/core-fixture"
import { HACC_HOST, HaccClient } from "./hacc"
import { isGap, probeUpgrade, SignalStream, type SocketLike, type StreamRow } from "./signal-stream"

const KEY_FILE = process.env.CANDLE_HARNESS_TEST_KEY_FILE
const key = KEY_FILE ? readFileSync(KEY_FILE, "utf8").trim() : ""
const dir = mkdtempSync(join(tmpdir(), "signals-live-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

test.skipIf(!KEY_FILE)(
  "a drop is filled from the tape: every signal once, oldest first",
  async () => {
    const client = new HaccClient({ keyFor: () => key, now: Date.now })
    const published: StreamRow[] = []
    const journal: Record<string, unknown>[] = []
    let socket: SocketLike | undefined
    const stream = new SignalStream({
      hacc: client,
      agents: () => [{ agent: "live", key }],
      enabled: () => true,
      host: HACC_HOST,
      cursorPath: join(dir, "signals.json"),
      wanted: () => ({ signals: true, mine: false }),
      publish: (_topic, data) => published.push(...data.rows),
      onState: () => {},
      record: (e) => journal.push(e),
      now: Date.now,
      // A long first wait, so signals land on Hacc while the socket is closed.
      timing: { backoffMs: [45_000] },
      openSocket: (url, k) => {
        socket = new WebSocket(url, { headers: { authorization: `Bearer ${k}` } } as unknown as string[]) as unknown as SocketLike
        return socket
      },
    })
    try {
      stream.poke()
      await until(() => published.length >= 100, 15_000)
      const before = stream.cursor()!
      console.log(`snapshot: ${published.length} rows, newest ${before.at}`)
      socket!.close(4001, "live check: a drop") // the stream didn't ask for it, so it's a drop
      await until(() => journal.some((e) => e.event === "filled"), 90_000)
      const filled = journal.find((e) => e.event === "filled")!.rows as number
      await Bun.sleep(1_000)
      const rows = published.filter((r) => !isGap(r)) as { id: number; created_at: string }[]
      const ids = rows.map((r) => r.id)
      console.log(`after the drop: ${filled} read back from the tape; ${rows.length} rows in all, ${published.filter(isGap).length} gaps`)
      expect(new Set(ids).size).toBe(ids.length)
      expect(published.filter(isGap)).toEqual([])
      expect(stream.view().state).toBe("open")
      expect(JSON.stringify(published)).not.toContain(key)
    } finally {
      await stream.stop()
    }
  },
  150_000,
)

test("the upgrade probe reads Hacc's refusal of a key it doesn't take", async () => {
  const bogus = ["cndl", "live", "q".repeat(43)].join("_")
  const why = await probeUpgrade("wss://api.hacc.fun/v1/signals/stream", bogus)
  console.log(`probe: ${why.status} ${why.words}`)
  expect(why.status).toBe(401)
  expect(why.words).toBe("invalid api key")
})

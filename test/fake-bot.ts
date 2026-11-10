// A code bot for tests: the shipped client, used from a process of its own as a person's bot would use it. It reads
// CANDLE_HARNESS_SOCKET and CANDLE_HARNESS_BOT_TOKEN, makes a round trip on paper (a buy, half of it sold, the rest
// sold) and prints one JSON line per step, then exits. `FAKE_BOT_MINT` names the token.
import { HarnessClient, HarnessRefused } from "../client/harness-client"

const mint = process.env.FAKE_BOT_MINT ?? "MoonFake11111111111111111111111111111111111"
const say = (step: string, value: unknown) => console.log(JSON.stringify({ step, value }))

const harness = await HarnessClient.connect()
say("hello", harness.who)
say("self", await harness.self())
const bought = await harness.buy({ mint, amountUsd: 1 })
say("buy", bought)
const { positions } = await harness.positions()
say("positions", positions)
const position = positions.find((p) => p.mint === mint)
if (position) {
  say("sell-half", await harness.sell({ position: position.id, percent: 50 }))
  say("sell-rest", await harness.sell({ position: position.id }))
}
say("fills", (await harness.fills()).fills)
try {
  await harness.buy({ mint, amountUsd: 1_000 })
} catch (error) {
  say("over", error instanceof HarnessRefused ? { code: error.code, message: error.message } : String(error))
}
harness.close()

// The CLI's keyring passphrase, which the core passes to every candle run where there's no keychain, is registered
// with the redactor: nothing the core writes or sends carries it.
import { afterAll, afterEach, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { cleanupHomes, startTestCore, type TestCore } from "../../test/core-fixture"

const cores: TestCore[] = []
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close().catch(() => {})
})
afterAll(() => cleanupHomes())

test("CANDLE_KEYRING_PASSPHRASE is redacted from the journal", async () => {
  const passphrase = "keyring-pass-for-the-test-7Qx"
  const c = await startTestCore({ env: { ...process.env, CANDLE_KEYRING_PASSPHRASE: passphrase } })
  cores.push(c)
  await c.core.journal.append({ type: "bot.log", mode: "live", words: `a bot printed ${passphrase} by mistake` })
  expect(JSON.stringify(c.core.journal.rows().at(-1))).not.toContain(passphrase)
  expect(readFileSync(c.p.journal, "utf8")).not.toContain(passphrase)
})

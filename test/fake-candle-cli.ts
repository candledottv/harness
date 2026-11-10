// A stand-in for the user's `candle` CLI: no network, no keys. It records each run (arguments and
// environment) to $CANDLE_CONFIG_DIR/fake-cli-runs.jsonl, which the tests point at a temporary folder,
// and answers by its first argument:
//   sleep    never finishes (for the timeout)
//   exit3    exits 3, as a trade command does when a trade may have landed
//   badjson  prints something that isn't JSON
//   --version  the version: fake-cli.json's `version`, else 0.13.18 (the CLI the Candle Harness was checked against)
//   keys list  fake-cli.json's `keysList` as JSON, or its `keysListFail` (stderr and an exit code)
//   keys create  fake-cli.json's `keysCreate`; with its `ownerConfirm`, Candle's browser confirm first, as
//            0.13.20 shows it (cli/src/owner-confirm.ts): with --json one pending line on stderr, written in
//            two parts, else the summary, link and code in words; then approved (the key), denied or expired
//   with fake-cli.json's `tee` set, the TEE reads in the shapes recorded from Candle
//   (fixtures/candle-recorded/tee/clicmd-*): `tee status`, `keys wallets`, `swap status`, and
//   `wallets` (the key's TEE wallets, each signer "stored" unless `tee.signers` says otherwise);
//   and `swap <from> <to> … --wallet <address> --client-trade-id <id>` as the CLI runs it
//   (cli/src/commands/swap.ts): the id looked up first and printed if found, then claimed in
//   operations/<id>, then `tee.swapOutcome` (a fill unless set). Jobs it makes are kept in
//   fake-cli-jobs.json, where `swap status` finds them
//   `stake add|remove|finish … --wallet <address> --client-stake-id <id> --yes` from a TEE wallet as
//   cli/src/commands/stake.ts runs it: the id claimed in operations/<id>, the signed transaction saved
//   there before the submit, and a rerun under the same id resubmitting it (`resumed: true`); then
//   `tee.stakeOutcome` (confirmed unless set)
//   `image upload <path> [--banner]` as cli/src/commands/image.ts: the file read, then a made-up URL
//   naming its SHA-256, unless `uploadOutcome` says otherwise
//   `launch … --dry-run` and `launch`, and `lp add|remove|claim` (with `lpEnabled`),
//   for the card rows held until checked live: in shapes from the CLI's source, never recorded
//   with fake-cli.json's `vault` set, the prompt pane's rows: `vault status --unlock`
//   at a hidden prompt on stderr, in raw mode, where Ctrl-C is a byte it ignores until a SIGTERM, as
//   the real one was recorded (fixtures/candle-recorded/vault/clicmd-vault-status-unlock*); and `tee
//   disable` and `tee fund`, which ask the same way, then do what `paneOutcome` says; funds out:
//   `vault transfer`, `vault fund`, `tee sweep`, `external sweep` and `vault demote`, which unlock,
//   print where it goes in groups of four, and take a typed `confirm` (anything else is exit 1, nothing
//   sent), then do what `paneOutcome` says; and `vault list --json`, `vaultList` once unlocked
//   `wallets --json` with no key (the owner's profile): fake-cli.json's `ownerWallets`, when set
//   `wallets close-empty` as 0.13.5 runs it, from fake-cli.json's `closeEmpty`
//   lp       LP_NOT_ENABLED, as Candle answered every key on 2026-10-27, unless fake-cli.json's
//            `lpEnabled` is set (then `{ pools: [] }`: the served shape was never recorded)
//   anything else: exit 0, and with --json, `{ "ok": true, "argv": [...], "apiKey": ... }`, echoing the
//   key it was given, so a test can show the core redacts it before anything reaches the agent
// fake-cli.json is read from $CANDLE_CONFIG_DIR, when there is one.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import CLI_SOURCE from "../src/core/cli-source.json"

const argv = process.argv.slice(2)
const dir = process.env.CANDLE_CONFIG_DIR
// The open descriptors too, where /proc shows them: a pane's `candle` must hold none above 2.
const fds =
  process.platform === "linux"
    ? readdirSync("/proc/self/fd").flatMap((n) => {
        try {
          return [{ fd: Number(n), target: readlinkSync(`/proc/self/fd/${n}`) }]
        } catch {
          return [] // the listing's own handle, closed by now
        }
      })
    : undefined
if (dir) appendFileSync(join(dir, "fake-cli-runs.jsonl"), `${JSON.stringify({ argv, env: process.env, ...(fds ? { fds } : {}), tty: { stdin: process.stdin.isTTY === true, stdout: process.stdout.isTTY === true } })}\n`)

interface FakeCliScript {
  version?: string
  keysList?: unknown
  keysListFail?: { stderr: string; exitCode: number }
  tee?: {
    /** The account's TEE wallets, each bound to one key by its prefix. */
    wallets: { id: string; address: string; label?: string; boundKeyPrefix: string; active?: boolean; lamports?: string }[]
    /** Jobs `swap status` finds, by client id: the rail (`--kind`) and Candle's job row. */
    jobs?: Record<string, { kind: "trade" | "swap"; job: Record<string, unknown> }>
    /** `candle wallets --json`'s `signers` by wallet id; "stored" for each of the key's wallets when unset. */
    signers?: Record<string, string>
    /**
     * What a TEE `swap` run does after its claim:
     *   filled         a fill, in the submit's shape (the default)
     *   pending        a swap submitted, its settlement pending
     *   exit3          broadcast, outcome unseen: exit 3, the job left built with its signature
     *   requestFailed  it landed, and the answer was lost: REQUEST_FAILED, exit 1
     *   refused        Candle's build refused it (SPEND_LIMIT_EXCEEDED), exit 1, a job built and never sent
     *   usage          USAGE, exit 2, before any claim
     *   sleep          never finishes
     */
    swapOutcome?: "filled" | "pending" | "exit3" | "requestFailed" | "refused" | "usage" | "sleep"
    /**
     * What a TEE `stake` run does after its claim:
     *   confirmed          submitted and confirmed (the default)
     *   requestFailed      signed and saved, then the submit's answer lost: REQUEST_FAILED, exit 1
     *   signerUnavailable  SIGNER_UNAVAILABLE before anything was built, exit 1
     *   sleep              never finishes
     */
    stakeOutcome?: "confirmed" | "requestFailed" | "signerUnavailable" | "sleep"
  }
  lpEnabled?: boolean
  /**
   * `wallets close-empty`: each wallet's empty token accounts by address (none unless named);
   * `off` answers as a deployment with Candle's TEE close switched off; `outcome: "recovering"` closes and exits 3.
   */
  closeEmpty?: { accounts?: Record<string, number>; off?: boolean; outcome?: "recovering" }
  /** What `image upload` does: ok (the default), or requestFailed (the answer lost, exit 1). */
  uploadOutcome?: "ok" | "requestFailed"
  /** This machine's vault, for the prompt pane's rows: missing, or opened by `passphrase`. */
  vault?: { missing?: boolean; passphrase?: string; silentExit0?: boolean }
  /**
   * What `tee disable` and `tee fund` do once unlocked: exit 0 (the default), 1, 2 or 3; sleep (until a
   * SIGTERM); or canary (print `canary`'s made-up phrase and key on the terminal, then exit 0).
   */
  paneOutcome?: 0 | 1 | 2 | 3 | "sleep" | "canary"
  canary?: { phrase: string; key: string }
  /** `vault phrase show`'s made-up 24 words, shown once unlocked and `understood` is typed. */
  phrase?: string
  /** `auth status --json`'s key prefix; null for a profile holding no key of its own. */
  authKeyPrefix?: string | null
  /** `auth status --json`'s whole answer and exit, as recorded (fixtures/candle-recorded/cli-0.13.5/clicmd-auth-status*): over authKeyPrefix. */
  authStatus?: { exit: number; body: unknown }
  /** How long `auth status` takes before it answers, as on a slow machine. */
  authStatusDelayMs?: number
  /**
   * What `keys create … --json` mints (cli/src/commands/keys.ts): a key of the real shape with this
   * prefix, built at run time. `storeError` answers as the CLI does when its own store failed (exit 1,
   * the key printed anyway).
   */
  keysCreate?: { prefix: string; storeError?: string; refuse?: { code: string; status: number; message: string }; ownerConfirm?: "approved" | "denied" | "expired" }
  /** `candle wallets --json` with the owner's profile (no CANDLE_API_KEY), as recorded. */
  ownerWallets?: unknown
  /** `vault list --json`'s body once unlocked (the recorded shape). */
  vaultList?: unknown
  /** `profile list --json`'s rows (cli/src/profiles.ts `profileTable`). */
  profileList?: unknown
  /**
   * `auth login`: Candle's device-code screen, as recorded, then after `waitMs` the profile is
   * signed in (kept in fake-cli-signed.json, so `auth status` as that profile answers signed in) and it exits 0.
   * `refuse` exits 1 with those words and signs nothing in.
   */
  authLogin?: { waitMs?: number; refuse?: string; code?: string }
  /**
   * The fake Candle MCP servers' scripts (test/fake-candle-mcp.ts) that share this account's state, for a run in tmux
   * end to end: `tee rename <address> <label>` relabels the wallet there, and `keys update <prefix>
   * --embedded-wallet allow|deny` sets the embedded wallet's permission in each.
   */
  mcpScripts?: string[]
}
const scriptFile = dir ? join(dir, "fake-cli.json") : undefined
const script: FakeCliScript = scriptFile && existsSync(scriptFile) ? JSON.parse(readFileSync(scriptFile, "utf8")) : {}

const json = argv.includes("--json")
if (argv[0] === "--version") {
  process.stdout.write(`${script.version ?? "0.13.18"}\n`)
  process.exit(0)
}
if (argv[0] === "keys" && argv[1] === "list" && (script.keysList !== undefined || script.keysListFail)) {
  if (script.keysListFail) {
    process.stderr.write(`${script.keysListFail.stderr}\n`)
    process.exit(script.keysListFail.exitCode)
  }
  process.stdout.write(`${JSON.stringify(script.keysList)}\n`)
  process.exit(0)
}
/** Prints one JSON line and exits, as the CLI does under --json. */
function answer(body: unknown, code: number): never {
  process.stdout.write(`${JSON.stringify(body)}\n`)
  process.exit(code)
}
/** Candle's browser confirm as CLI 0.13.20 shows and ends it (cli/src/owner-confirm.ts, client.ts apiRequest). */
async function ownerConfirm(outcome: "approved" | "denied" | "expired", summary: string): Promise<void> {
  const challenge = { userCode: "WDJB-MJHT", verificationUriComplete: "https://candle.tv/dev/agent/confirm?code=WDJB-MJHT", expiresIn: 300, step: "keys.create", summary }
  if (argv.includes("--json")) {
    const line = `${JSON.stringify({ ok: false, pending: true, code: "OWNER_CONFIRM_REQUIRED", ownerConfirm: challenge })}\n`
    process.stderr.write(line.slice(0, 40))
    await Bun.sleep(20)
    process.stderr.write(line.slice(40))
  } else {
    process.stderr.write(`This needs your approval in the browser: ${summary}\nOpen ${challenge.verificationUriComplete}\nCode: ${challenge.userCode}\nOnly approve if you just ran this command.\nWaiting for approval (expires in 5 minutes)...\n`)
  }
  await Bun.sleep(50)
  if (outcome === "denied") answer({ ok: false, code: "OWNER_CONFIRM_DENIED", message: "Denied in the browser; nothing changed." }, 1)
  if (outcome === "expired") answer({ ok: false, code: "OWNER_CONFIRM_EXPIRED", message: "The confirmation expired; nothing changed. Run the command again." }, 1)
  if (!argv.includes("--json")) process.stderr.write("Approved. Sending the request again.\n")
}
/**
 * A hidden prompt as the CLI's: the prompt on stderr, the terminal in raw mode, Enter ends it. Ctrl-C is
 * a byte, ignored: only a signal ends it.
 */
async function hiddenPrompt(prompt: string): Promise<string> {
  process.stderr.write(prompt)
  if (!process.stdin.isTTY) return ((await Bun.stdin.text()).split("\n")[0] ?? "").trim()
  process.stdin.setRawMode(true)
  return new Promise((resolve) => {
    let line = ""
    // One listener a prompt, dropped when it ends, so a second prompt in the same run reads its own line.
    const onData = (chunk: Buffer) => {
      for (const b of chunk) {
        if (b === 0x0d || b === 0x0a) {
          process.stdin.off("data", onData)
          process.stdin.setRawMode(false)
          process.stdin.pause()
          process.stderr.write("\n")
          resolve(line)
          return
        }
        if (b === 0x03) continue
        line += String.fromCharCode(b)
      }
    }
    process.stdin.on("data", onData)
    process.stdin.resume()
  })
}
const UNLOCK_FAILED = { ok: false, code: "VAULT_UNLOCK_FAILED", message: "Could not open the vault: wrong passphrase, or the file is corrupt." }
const VAULT_MISSING = { ok: false, code: "VAULT_MISSING", message: "No vault on this machine. Run candle vault init." }
/** Unlocks as the CLI does: false, with the refusal printed, when it doesn't open. */
async function unlock(): Promise<boolean> {
  if (script.vault?.missing) {
    process.stdout.write(json ? `${JSON.stringify(VAULT_MISSING)}\n` : `${VAULT_MISSING.message}\n`)
    return false
  }
  const typed = await hiddenPrompt("Vault passphrase (input hidden): ")
  if (typed !== script.vault?.passphrase) {
    process.stdout.write(json ? `${JSON.stringify(UNLOCK_FAILED)}\n` : `${UNLOCK_FAILED.message}\n`)
    return false
  }
  process.stderr.write("Deriving the vault key (Argon2id, 64 MiB)\n")
  return true
}
if (script.vault && argv[0] === "vault" && argv[1] === "status" && argv.includes("--unlock")) {
  // `silentExit0`: an exit 0 with nothing written, which must never count as unlocked.
  if (script.vault.silentExit0) process.exit(0)
  if (!(await unlock())) process.exit(1)
  answer({ ok: true, path: "~/.config/candle/vault.enc", version: 2, unlocked: { entries: [] } }, 0)
}
// `vault status --json` with no unlock: the facts, or VAULT_MISSING (cli/src/commands/vault-status.ts).
if (script.vault && argv[0] === "vault" && argv[1] === "status") {
  if (script.vault.missing) answer(VAULT_MISSING, 1)
  answer({ ok: true, path: "~/.config/candle/vault.enc", version: 2, generation: 7, envelopes: [{ id: "fake-envelopeId-1", factor: "passphrase" }] }, 0)
}
// The profile a run acts as: --profile, else CANDLE_PROFILE (the CLI's own order, profiles.ts).
// With neither, the CLI's own pick: profileList's active row, as resolveProfileName picks activeProfile.
const listedActive = Array.isArray(script.profileList) ? (script.profileList as { name?: string; active?: boolean }[]).find((r) => r.active)?.name : undefined
const actingProfile = argv.includes("--profile") ? argv[argv.indexOf("--profile") + 1] : (process.env.CANDLE_PROFILE ?? listedActive)
const signedFile = dir ? join(dir, "fake-cli-signed.json") : undefined
const signed: string[] = signedFile && existsSync(signedFile) ? JSON.parse(readFileSync(signedFile, "utf8")) : []
if (argv[0] === "profile" && argv[1] === "list" && script.profileList !== undefined) answer(script.profileList, 0)
if (argv[0] === "auth" && argv[1] === "login" && script.authLogin) {
  const code = script.authLogin.code ?? "WXYZ-4821"
  const api = argv.includes("--api-url") ? argv[argv.indexOf("--api-url") + 1] : "https://api.candle.example"
  process.stdout.write(`Authorize this device\n\n  API          ${api}\n  Device code  ${code}\n  Approve at   https://candle.example/dev/agent/device?code=${code}\n\n`)
  await Bun.sleep(script.authLogin.waitMs ?? 300)
  if (script.authLogin.refuse) {
    process.stderr.write(`${script.authLogin.refuse}\n`)
    process.exit(1)
  }
  if (signedFile && actingProfile) writeFileSync(signedFile, JSON.stringify([...signed, actingProfile]))
  process.stdout.write(`Signed in as ${actingProfile}.\n`)
  process.exit(0)
}
if (argv[0] === "auth" && argv[1] === "status" && actingProfile && signed.includes(actingProfile)) {
  answer({ backend: "keychain", profile: actingProfile, deviceTokenPrefix: "FakeDvc9", keyPrefix: "FakeKey9", account: "WalletFake999999999999999999999999999999999", rows: [{ check: "Device token", state: "PASS", detail: "valid" }] }, 0)
}
if (argv[0] === "auth" && argv[1] === "status" && script.authStatusDelayMs) Bun.sleepSync(script.authStatusDelayMs)
if (argv[0] === "auth" && argv[1] === "status" && script.authStatus) answer(script.authStatus.body, script.authStatus.exit)
if (argv[0] === "auth" && argv[1] === "status" && script.authKeyPrefix !== undefined) {
  answer({ signedIn: true, profile: "default", ...(script.authKeyPrefix ? { keyPrefix: script.authKeyPrefix } : {}) }, 0)
}
// `vault init`: the passphrase twice at hidden prompts, as cli/src/commands/vault-init.ts asks,
// then the vault exists (kept in fake-cli.json, so `vault status` and every unlock find it). One already there is refused.
if (argv[0] === "vault" && argv[1] === "init" && script.vault) {
  if (!script.vault.missing) answer({ ok: false, code: "VAULT_EXISTS", message: "A vault already exists on this machine." }, 1)
  const first = await hiddenPrompt("New vault passphrase (input hidden): ")
  const again = await hiddenPrompt("Repeat it: ")
  if (first.length < 8 || first !== again) answer({ ok: false, code: "PASSPHRASE_MISMATCH", message: first.length < 8 ? "The passphrase must be at least 8 characters." : "The passphrases didn't match." }, 1)
  if (scriptFile) writeFileSync(scriptFile, JSON.stringify({ ...script, vault: { passphrase: first } }))
  process.stdout.write("Vault created at ~/.config/candle/vault.enc (passphrase factor).\n")
  process.exit(0)
}
/** Changes the fake Candle's own state, as the real CLI's call to Candle would. */
const editMcp = (edit: (s: Record<string, unknown>) => void) => {
  for (const path of script.mcpScripts ?? []) {
    const body = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>) : {}
    edit(body)
    writeFileSync(path, JSON.stringify(body))
  }
}
if (argv[0] === "tee" && argv[1] === "rename" && script.mcpScripts && argv[2] && argv[3]) {
  let found = false
  editMcp((s) => {
    for (const w of (s.teeWallets as { address: string; label?: string }[] | undefined) ?? []) if (w.address === argv[2]) ((w.label = argv[3]), (found = true))
  })
  if (!found) answer({ ok: false, code: "WALLET_NOT_FOUND", message: `No linked wallet ${argv[2]}.` }, 1)
  process.stdout.write(`Renamed ${argv[2]} to ${argv[3]}.\n`)
  process.exit(0)
}
if (argv[0] === "keys" && argv[1] === "update" && script.mcpScripts && argv.includes("--embedded-wallet")) {
  const to = argv[argv.indexOf("--embedded-wallet") + 1]
  // Allowing widens the key: the real CLI asks for its prefix back at a terminal, unless --yes.
  if (to === "allow" && !argv.includes("--yes") && (await hiddenPrompt(`Type ${argv[2]} to allow it the embedded wallet: `)) !== argv[2]) answer({ ok: false, code: "CONFIRMATION_FAILED", message: "Nothing changed." }, 1)
  editMcp((s) => (s.embeddedWalletPermission = to === "allow" ? "allowed" : "denied"))
  answer({ success: true, keyPrefix: argv[2], embeddedWallet: to === "allow" ? "allowed" : "denied" }, 0)
}
if (argv[0] === "keys" && argv[1] === "create" && script.keysCreate) {
  // A `#` in the prefix is the key's number on the account, so a run in tmux can make several.
  const listed = (script.keysList as { keys?: Record<string, unknown>[] } | undefined)?.keys
  const prefix = script.keysCreate.prefix.replace("#", String((listed?.length ?? 0) + 1))
  const key = `${["cndl", "live", ""].join("_")}${prefix}${"k".repeat(43 - prefix.length)}`
  const flag = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined)
  const scopes = flag("--scopes")?.split(",") ?? (flag("--access") === "read" ? ["account:read"] : ["launch:write", "launch:read", "activity:write", "swap:write", "account:read"])
  const body = { key, keyPrefix: prefix, scopes, environment: "live", embeddedWallet: "denied" }
  if (script.keysCreate.ownerConfirm) await ownerConfirm(script.keysCreate.ownerConfirm, `Create an API key labelled ${flag("--label") ?? "(none)"}`)
  // Candle refusing the key, in the CLI's --json error envelope (render.ts errorEnvelope), as a new account's is.
  if (script.keysCreate.refuse) answer({ ok: false, ...script.keysCreate.refuse }, 1)
  if (script.keysCreate.storeError) answer({ ...body, stored: false, storeError: script.keysCreate.storeError }, 1)
  // With a key list, the new key joins it, so the owner's `keys list` finds it as Candle would.
  if (listed && scriptFile) {
    const row = { keyPrefix: prefix, label: flag("--label") ?? null, environment: "production", embeddedWallet: "denied", walletScope: "selected", scopes, createdAt: new Date().toISOString(), revokedAt: null }
    writeFileSync(scriptFile, JSON.stringify({ ...script, keysList: { ...(script.keysList as object), keys: [...listed, row] } }))
  }
  answer({ ...body, stored: false }, 0)
}
if (script.vault && argv[0] === "tee" && (argv[1] === "disable" || argv[1] === "fund")) {
  if (!(await unlock())) process.exit(1)
  const outcome = script.paneOutcome ?? 0
  if (outcome === "sleep") await Bun.sleep(600_000)
  if (outcome === "canary") {
    process.stdout.write(`Your recovery words: ${script.canary?.phrase}\nNew key: ${script.canary?.key}\n`)
    process.exit(0)
  }
  process.stdout.write(argv[1] === "disable" ? `Stop requested for ${argv[2]}.\n` : `Send SOL to ${argv[2]} from your vault wallet.\n`)
  process.exit(outcome)
}
// Funds out (commands/vault-transfer.ts, vault-fund.ts, tee.ts, external.ts): the
// unlock names the send, then where it goes in groups of four, and a typed confirm.
const FUNDS_OUT = ["vault transfer", "vault fund", "vault demote", "tee sweep", "external sweep"]
if (script.vault && FUNDS_OUT.includes(`${argv[0]} ${argv[1]}`)) {
  if (!(await unlock())) process.exit(1)
  // The first positional wherever the flags sit, as the CLI's parseArgs reads it (`--from cold <to>` too).
  const positional = argv.slice(2).find((a, i, rest) => !a.startsWith("-") && !(i > 0 && ["--amount", "--asset", "--from", "--to"].includes(rest[i - 1]!)))
  const to = argv[1] === "sweep" ? (argv.includes("--to") ? argv[argv.indexOf("--to") + 1]! : "the pinned vault") : positional!
  process.stdout.write(`To: ${(to.match(/.{1,4}/g) ?? [to]).join(" ")}\n`)
  if ((await hiddenPrompt("Type confirm to send: ")) !== "confirm") {
    process.stdout.write("Not confirmed. Nothing was signed.\n")
    process.exit(1)
  }
  const outcome = script.paneOutcome ?? 0
  if (outcome === "sleep") await Bun.sleep(600_000)
  process.stdout.write(outcome === 0 ? "Sent: FakeSig1111\n" : outcome === 3 ? "Broadcast FakeSig1111, not finalized yet.\n" : "Refused.\n")
  process.exit(outcome === "canary" ? 0 : outcome)
}
// `vault list --json` with stdout piped: the prompt on the terminal, the JSON on stdout.
if (script.vault && argv[0] === "vault" && argv[1] === "list") {
  if (!(await unlock())) process.exit(1)
  answer(script.vaultList ?? { ok: true, entries: [] }, 0)
}
if (argv[0] === "wallets" && argv.length <= 2 && script.ownerWallets !== undefined && process.env.CANDLE_API_KEY === undefined) answer(script.ownerWallets, 0)
// `vault phrase show` (commands/vault-phrase.ts): a fresh unlock, `understood`, the 24 words, then three typed back.
// Exit 1 before the words or after them: the read-back failed.
if (script.vault && argv[0] === "vault" && argv[1] === "phrase" && argv[2] === "show") {
  if (!(await unlock())) process.exit(1)
  if ((await hiddenPrompt("Type understood to show your 24 words: ")) !== "understood") process.exit(1)
  const words = (script.phrase ?? "").split(" ")
  process.stdout.write(`${script.phrase ?? ""}\n`)
  const back = await hiddenPrompt("Type words 3, 11 and 20, separated by spaces: ")
  process.exit(back === [words[2], words[10], words[19]].join(" ") ? 0 : 1)
}
// `secrets set <name>` (commands/secrets.ts): the value at a hidden prompt only, kept on this machine; empty is exit 2.
if (argv[0] === "secrets" && argv[1] === "set") {
  const value = await hiddenPrompt("Secret value (input hidden): ")
  if (value === "") process.exit(2)
  writeFileSync(join(dir!, "fake-cli-secrets.json"), JSON.stringify({ [argv[2]!]: value }))
  process.exit(0)
}
const tee = script.tee
const ownPrefix = (process.env.CANDLE_API_KEY ?? "").replace(/^cndl_(live|test)_/, "").slice(0, 8)
const positional = argv.filter((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--kind"))
if (tee && argv[0] === "tee" && argv[1] === "status") {
  const address = positional[2]
  const w = tee.wallets.find((x) => x.address === address && x.boundKeyPrefix === ownPrefix)
  if (!w) {
    answer({ ok: false, code: "TEE_WALLET_NOT_ON_KEY", message: `${address} is not a TEE wallet bound to key ${ownPrefix}.`, suggestion: "Pass --verify to read it from this machine's vault, or select the profile holding its key." }, 1)
  }
  // `candle tee status <address> --json` under the bound key, as recorded (cli/src/commands/tee-status-wallet.ts).
  answer({
    address: w.address,
    label: w.label ?? null,
    source: "server",
    verified: false,
    linkedWalletId: w.id,
    vaultDestination: null,
    vaultLifecycle: null,
    localState: null,
    retainedSweepReceipts: null,
    pendingSweepTransactions: null,
    observedAt: "2026-09-01T00:00:00.000Z",
    server: { success: true, id: w.id, chain: "solana", address: w.address, state: "enabled", remoteAuthority: (w.active ?? true) ? "verified-active" : "unverified", evidenceObservedAt: 1_790_000_000_000, revokedAt: null, sweptAt: null, boundKeyPrefix: w.boundKeyPrefix, everRemoteExposed: true, lifecycleVersion: 1, bridges: [] },
    balances: { lamports: w.lamports ?? "0", tokens: [] },
  }, 0)
}
if (tee && argv[0] === "keys" && argv[1] === "wallets" && positional.length === 3) {
  const prefix = positional[2]!
  const bound = tee.wallets.filter((w) => w.boundKeyPrefix === prefix)
  answer({
    keyPrefix: prefix,
    profileId: "fake-profileId-1",
    walletScope: "selected",
    wallets: bound.map((w) => ({ address: w.address, assignedAt: 1_790_000_000_000, chain: "solana", ...(w.label ? { label: w.label } : {}), linkedWalletId: w.id, spendCapable: w.active ?? true })),
    scopeLimit: { max: 1000, rows: bound.length },
  }, 0)
}
type Job = { kind: "trade" | "swap"; job: Record<string, unknown> }
const jobsFile = dir ? join(dir, "fake-cli-jobs.json") : undefined
const madeJobs = (): Record<string, Job> => (jobsFile && existsSync(jobsFile) ? JSON.parse(readFileSync(jobsFile, "utf8")) : {})
const keepJob = (id: string, job: Job) => jobsFile && writeFileSync(jobsFile, JSON.stringify({ ...madeJobs(), [id]: job }))
if (tee && argv[0] === "swap" && argv[1] !== "status") {
  const flag = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined)
  const values = new Set(["--amount", "--percent", "--wallet", "--client-trade-id", "--slippage-bps", "--rpc-url"])
  const [from, to] = argv.slice(1).filter((a, i, rest) => !a.startsWith("--") && !values.has(rest[i - 1] ?? ""))
  const id = flag("--client-trade-id") ?? "swap-fake"
  const base = (a: string | undefined) => a !== undefined && ["SOL", "USDC", "CNDL"].includes(a.toUpperCase())
  const kind = base(from) && base(to) ? "swap" : "trade"
  const outcome = tee.swapOutcome ?? "filled"
  if (outcome === "usage") answer({ ok: false, code: "USAGE", message: "Usage: candle swap <from> <to> --amount <decimal> | --percent <n> …" }, 2)
  // The id is looked up on Candle first, and what's found is printed instead of trading (swap.ts:492-493).
  const prior = { ...tee.jobs, ...madeJobs() }[id]
  if (prior && prior.kind === kind) answer({ job: prior.job, kind, clientTradeId: id }, 0)
  const wallet = tee.wallets.find((w) => w.address === flag("--wallet") && w.boundKeyPrefix === ownPrefix)
  if (!wallet) answer({ ok: false, code: "TEE_WALLET_REQUIRED", message: `"${flag("--wallet")}" is not a wallet this account can pay from. Operation ${id}; use candle swap status ${id} before another attempt.` }, 1)
  const claim = join(dir!, "operations", id)
  if (existsSync(claim)) answer({ ok: false, code: "OPERATION_ALREADY_STARTED", message: "This machine already started this id; no write was resent." }, 1)
  mkdirSync(join(dir!, "operations"), { recursive: true })
  writeFileSync(claim, "{}")
  const signature = `FakeSig${id.replace(/-/g, "").slice(0, 20)}`
  const now = 1_790_000_000_000
  const filledJob = kind === "swap" ? { status: "confirmed", clientTradeId: id, kind, signature, settlement: { state: "settled", settledOutRaw: "1000000" } } : { status: "confirmed", clientTradeId: id, chain: "solana", side: base(from) ? "buy" : "sell", mint: base(from) ? to : from, amountRaw: "1", signature, createdAt: now, updatedAt: now }
  const quote = { intent: `Swap ${flag("--amount") ?? `${flag("--percent")}%`} ${from} to ${to}`, wallet: wallet!.address, venue: "jupiter", fee: { bps: 25, feeRaw: "0" } }
  switch (outcome) {
    case "sleep":
      await Bun.sleep(60_000)
      break
    case "pending":
      keepJob(id, { kind, job: { status: "submitted", clientTradeId: id, kind, hashes: [signature], settlement: { state: "pending" } } })
      answer({ success: true, payload: { hashes: [signature], settlement: { state: "pending" } }, clientTradeId: id, kind, quote, wallet: wallet!.address, settlement: { state: "pending" } }, 0)
    case "exit3":
      keepJob(id, { kind, job: kind === "swap" ? { status: "submitted", stage: "unconfirmed", hashes: [signature], signature: null } : { ...filledJob, status: "built" } })
      answer({ ok: false, code: "TRANSACTION_UNCONFIRMED", message: `Submitted; the outcome wasn't seen. Operation ${id}; use candle swap status ${id} before another attempt.`, details: { stage: "unconfirmed", signature } }, 3)
    case "requestFailed":
      keepJob(id, { kind, job: filledJob })
      answer({ ok: false, code: "REQUEST_FAILED", message: `Network request failed. Operation ${id}; use candle swap status ${id} before another attempt.` }, 1)
    case "refused":
      keepJob(id, { kind, job: kind === "swap" ? { status: "built", clientTradeId: id, kind, signature: null } : { ...filledJob, status: "built", signature: undefined } })
      answer({ ok: false, code: "SPEND_LIMIT_EXCEEDED", message: `Over this key's per-trade cap. Operation ${id}; use candle swap status ${id} before another attempt.` }, 1)
    default:
      keepJob(id, { kind, job: filledJob })
      if (kind === "swap") answer({ success: true, payload: { hashes: [signature], settlement: filledJob.settlement }, clientTradeId: id, kind, quote, wallet: wallet!.address, settlement: filledJob.settlement }, 0)
      answer({ success: true, status: "executed", signature, clientTradeId: id, kind, quote, wallet: wallet!.address }, 0)
  }
}
if (tee && argv[0] === "swap" && argv[1] === "status") {
  const id = positional[2]!
  const kind = argv[argv.indexOf("--kind") + 1]
  const found = { ...tee.jobs, ...madeJobs() }[id]
  if (found && found.kind === kind) answer({ job: found.job, success: true, kind, clientTradeId: id }, 0)
  answer({
    ok: false,
    code: "JOB_NOT_FOUND",
    message: `No operation ${id} is visible to key ${ownPrefix} on the ${kind} rail(s). Nothing was resent.`,
    suggestion: `Trade and launch jobs are readable by any key on this account; swap jobs only by the key that placed them. If another key or profile placed it, run: candle swap status ${id} --profile <that profile>`,
  }, 1)
}
if (tee && argv[0] === "wallets" && positional.length === 1) {
  // `candle wallets --json` under the agent's key, cut to the recorded fields the doctor reads.
  const mine = tee.wallets.filter((w) => w.boundKeyPrefix === ownPrefix)
  answer({
    embedded: { success: true, wallets: {}, embeddedWalletPermission: "allowed" },
    linked: { success: true, isDone: true, page: mine.map((w) => ({ _id: w.id, address: w.address, label: w.label ?? null, boundKeyPrefix: w.boundKeyPrefix, chain: "solana", walletKind: "tee", remoteAuthority: "verified-active" })) },
    signers: tee.signers ?? Object.fromEntries(mine.map((w) => [w.id, "stored"])),
    walletCount: mine.length,
    truncated: false,
  }, 0)
}
const flagOf = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined)
if (tee && argv[0] === "stake" && ["add", "remove", "finish"].includes(argv[1] ?? "")) {
  const id = flagOf("--client-stake-id") ?? "stake-fake"
  const action = argv[1] === "add" ? "stake" : argv[1] === "remove" ? "unstake" : "finish"
  const claim = join(dir!, "operations", id)
  const signature = `FakeStakeSig${id.replace(/-/g, "").slice(0, 16)}`
  const confirmed = { success: true, dryRun: false, replay: false, status: "confirmed", signature, clientStakeId: id, action, wallet: flagOf("--wallet") }
  // A saved signed transaction resumes by posting those bytes to /submit again (stake.ts).
  if (existsSync(claim) && JSON.parse(readFileSync(claim, "utf8")).signature) answer({ ...confirmed, resumed: true }, 0)
  const wallet = tee.wallets.find((w) => w.address === flagOf("--wallet") && w.boundKeyPrefix === ownPrefix)
  if (!wallet) answer({ ok: false, code: "STAKING_WALLET_REQUIRED", message: "--wallet must name one eligible Solana wallet by main, id, address or label. See candle stake." }, 1)
  const outcome = tee.stakeOutcome ?? "confirmed"
  if (outcome === "signerUnavailable") answer({ ok: false, code: "SIGNER_UNAVAILABLE", message: "No key signer for this TEE wallet on this machine." }, 1)
  if (outcome === "sleep") await Bun.sleep(60_000)
  mkdirSync(join(dir!, "operations"), { recursive: true })
  writeFileSync(claim, JSON.stringify({ kind: "stake", signature }))
  if (outcome === "requestFailed") answer({ ok: false, code: "REQUEST_FAILED", message: "Network request failed." }, 1)
  answer(confirmed, 0)
}
if (argv[0] === "image" && argv[1] === "upload") {
  const path = argv[2]!
  if (!existsSync(path)) answer({ ok: false, code: "IMAGE_UNREADABLE", message: `Could not read ${path}: there is no file at that path. Nothing was uploaded.` }, 1)
  const bytes = readFileSync(path)
  const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
  if (script.uploadOutcome === "requestFailed") answer({ ok: false, code: "REQUEST_FAILED", message: "Network request failed." }, 1)
  answer({ success: true, imageUrl: `https://fake-images.example/${hash.slice(0, 16)}.png`, contentType: "image/png", bytes: bytes.length }, 0)
}
if (argv[0] === "launch") {
  const id = flagOf("--client-trade-id") ?? "launch-fake"
  if (argv.includes("--dry-run")) answer({ success: true, dryRun: true, clientTradeId: id, kind: "launch" }, 0)
  answer({ success: true, status: "confirmed", mint: `FakeMint${id.replace(/-/g, "").slice(0, 20)}`, clientTradeId: id, kind: "launch" }, 0)
}
if (argv[0] === "lp" && script.lpEnabled && ["add", "remove", "claim"].includes(argv[1] ?? "")) {
  const id = flagOf("--client-trade-id") ?? "lp-fake"
  answer({ success: true, clientTradeId: id, kind: "lp", action: argv[1], signature: `FakeLpSig${id.replace(/-/g, "").slice(0, 16)}`, wallet: flagOf("--wallet") }, 0)
}
if ((argv[0] === "wallets" || argv[0] === "wallet") && argv[1] === "close-empty") {
  // As cli/src/commands/wallets-close-empty.ts runs it at 0.13.5, in the shapes production
  // answered (fixtures/candle-recorded/cli-0.13.5/clicmd-close-empty-*): a named id that ran prints its
  // stored job; then Candle's preview; with nothing, `nothing_to_close`; without --yes and no terminal, the
  // preview on stderr and CONFIRMATION_REQUIRED; with --yes, the close, kept under its id, and the wallet's
  // count goes to 0.
  const wallet = flagOf("--wallet") ?? "embedded"
  const id = flagOf("--client-trade-id")
  const closeFile = dir ? join(dir, "fake-cli-close.json") : undefined
  const kept: { jobs: Record<string, unknown>; closed: string[] } = closeFile && existsSync(closeFile) ? JSON.parse(readFileSync(closeFile, "utf8")) : { jobs: {}, closed: [] }
  const keep = () => closeFile && writeFileSync(closeFile, JSON.stringify(kept))
  const close = script.closeEmpty ?? {}
  if (id && kept.jobs[id]) answer({ success: true, job: kept.jobs[id], clientTradeId: id }, 0)
  // A stand-in for a deployment with it off: production serves it, so the real refusal is unrecorded.
  if (close.off) answer({ ok: false, code: "CLOSE_EMPTY_DISABLED", message: "Closing a TEE wallet's empty token accounts is not enabled on this deployment." }, 1)
  const n = kept.closed.includes(wallet) ? 0 : (close.accounts?.[wallet] ?? 0)
  const rent = 2039280
  const lamports = rent * n
  const sol = (l: number) => (l / 1e9).toFixed(9).replace(/\.?0+$/, "") || "0"
  const txs = Math.ceil(n / 20)
  const fee = 5000 * txs
  const linkedWalletId = `linked-${wallet.slice(0, 8)}`
  const accounts = Array.from({ length: n }, (_, i) => ({ mint: `Mint${i}`, account: `Acct${i}`, lamports: String(rent), tokenProgram: "spl-token" }))
  const name = `TEE wallet ${wallet}`
  if (n === 0) {
    process.stderr.write(`No empty token accounts to close on the ${name}.\n`)
    const preview = { success: true, wallet, linkedWalletId, keep: [], accounts: [], accountCount: 0, totalLamports: "0", totalSol: "0", transactions: 0, estimatedFeeLamports: "0", netLamports: "0", netSol: "0", skipped: [], undecodable: [], closesPerTransaction: 20, maxAccountsPerCall: 200 }
    answer({ success: true, status: "nothing_to_close", wallet, preview }, 0)
  }
  process.stderr.write(`Close ${n} empty token account${n === 1 ? "" : "s"} on the ${name}\n`)
  process.stderr.write(`Rent returned to that same wallet: ${sol(lamports)} SOL in ${txs} transaction${txs === 1 ? "" : "s"}, network fee about ${sol(fee)} SOL, net ${sol(lamports - fee)} SOL\n`)
  for (const a of accounts) process.stderr.write(`  ${a.mint}  ${a.tokenProgram}  ${sol(rent)} SOL\n`)
  if (!argv.includes("--yes")) answer({ ok: false, code: "CONFIRMATION_REQUIRED", message: "Run interactively to confirm, or use --yes to close without a prompt." }, 1)
  const runId = id ?? "close-fake"
  process.stderr.write(`Operation: ${runId}\n`)
  const signatures = Array.from({ length: txs }, (_, i) => `CloseSig${i}`)
  const result = {
    success: true,
    status: "completed",
    clientTradeId: runId,
    wallet,
    linkedWalletId,
    keep: [],
    closed: accounts,
    transactions: signatures.map((signature, index) => ({ index, signature, accounts: accounts.slice(index * 20, index * 20 + 20).map((a) => a.account), lamports: String(rent * accounts.slice(index * 20, index * 20 + 20).length) })),
    signatures,
    lamportsRecovered: String(lamports),
    solRecovered: sol(lamports),
    feeLamports: String(fee),
    netLamports: String(lamports - fee),
    netSol: sol(lamports - fee),
    failed: [],
    unattempted: [],
    notClosed: [],
    skipped: [],
    remaining: 0,
  }
  const at = Date.now()
  kept.jobs[runId] = { clientTradeId: runId, kind: "close-empty", walletKind: "tee", linkedWalletId, status: "completed", submitState: "done", createdAt: at, finishedAt: at, httpStatus: 200, reconciled: true, result }
  kept.closed.push(wallet)
  keep()
  if (close.outcome === "recovering") {
    process.stderr.write(`note: Not every close is settled on chain yet; nothing will be sent again. Read it again with: candle wallet close-empty --wallet ${wallet} --client-trade-id ${runId}\n`)
    answer({ success: true, status: "recovering", clientTradeId: runId, wallet, signatures, unresolved: [{ index: 0, accounts: ["Acct0"], signature: "CloseSig0", reason: "no confirmed outcome yet" }] }, 3)
  }
  answer(result, 0)
}
if (argv[0] === "lp") {
  if (script.lpEnabled) answer({ pools: [] }, 0)
  answer({ ok: false, code: "LP_NOT_ENABLED", message: "This Candle deployment does not serve LP routes (LP_ENABLED is off there, or the API predates them)." }, 1)
}
// `help` as 0.13.5 answers it: words, never JSON, even with --json, and exit 0. Its groups and
// rows come from the CLI's source read, so the words are the CLI's own.
if (argv[0] === "help") {
  const help = (CLI_SOURCE as { help: Record<string, { group: string; summary: string; rows: { invocation: string; description: string }[] }> }).help
  const topic = argv.slice(1).find((a) => !a.startsWith("-"))
  if (topic && help[topic]) {
    const t = help[topic]!
    process.stdout.write(`candle ${topic}: ${t.summary}.\n\nUsage: candle ${topic} <subcommand> [flags]\n\n${t.rows.map((r) => `  ${r.invocation}\n    ${r.description}`).join("\n")}\n`)
  } else {
    const groups = new Map<string, string[]>()
    for (const [name, t] of Object.entries(help)) groups.set(t.group, [...(groups.get(t.group) ?? []), `  ${name.padEnd(10)} ${t.summary}`])
    process.stdout.write(`Candle CLI: Your wallets and agent tools, one command away.\n\nUsage: candle <command> [<subcommand>] [flags]\n       candle help <command> [--more]\n\n${[...groups].map(([g, rows]) => `${g}\n${rows.join("\n")}`).join("\n\n")}\n`)
  }
  process.exit(0)
}
switch (argv[0]) {
  case "sleep":
    await Bun.sleep(60_000)
    break
  case "exit3":
    process.stdout.write(json ? `${JSON.stringify({ ok: false, code: "OUTCOME_UNKNOWN" })}\n` : "may have landed\n")
    process.exit(3)
  case "badjson":
    process.stdout.write("not json\n")
    break
  default:
    process.stdout.write(json ? `${JSON.stringify({ ok: true, argv, apiKey: process.env.CANDLE_API_KEY ?? null })}\n` : `ran ${argv.join(" ")}\n`)
}

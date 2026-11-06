// The CLI's card rows through the agent: staking from a TEE wallet, image uploads,
// and, held "coming" until each is checked live, LP, a TEE wallet's launch and
// closing empty accounts. Each is a one-press card that runs the user's own `candle <argv>` with the
// agent's key, on the shared card path: the same hash (over the final argv, with every flag the core
// adds), limits, kill switch, journal and session block as a trade. Read from the CLI's source at
// candledottv/agentic@8737c8e (cli/src/commands/stake.ts, image.ts, lp.ts, launch.ts, wallets-close-empty.ts):
//   - the core mints the id and puts it on the row's id flag; the CLI makes it durable (on Candle, or in
//     its own operations folder), so the same argv again resumes or reads, and never sends twice;
//   - `--yes` wherever the command takes one: without it the CLI stops at its prompt;
//   - `image upload` has no id. It's the one row the agent may give a path to, and only a file in its
//     own research folder. The file is copied into the core's state folder when the card is made, so
//     what's uploaded is exactly what the card showed, and its SHA-256 is checked again before the run.
import { createHash } from "node:crypto"
import { chmod, copyFile, mkdir, open, readdir, readFile, realpath, rm, stat } from "node:fs/promises"
import { basename, extname, isAbsolute, join, relative, sep } from "node:path"
import { terminalText } from "../shared/terminal-text"
import type { PayerResult } from "./agent-wallets"
import { isBaseAsset } from "./assets"
import type { CandleCli, CliResult } from "./candle-cli"
import { type CardRow, rowFor } from "./cli-table"
import { PRE_BUILD_CODES } from "./cli-trade"
import type { Mapped, Operation, OperationError } from "./execute"
import { refusalMessage } from "./execute"
import { type EmptyState, isCounted } from "./empty-accounts"
import type { Journal } from "./journal"
import { launchJobState } from "./reconcile"
import { short, walletName as payerNameOf } from "./wallet-names"

/** What the paying TEE wallet is called: its name, as the payer read it from the core's book. */
const payerName = (payer: { address: string; label?: string }) => payerNameOf(undefined, { ...payer, kind: "tee" })

/** Candle's largest hosted image (cli/src/commands/image.ts, MAX_IMAGE_BYTES). */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const ID_FLAGS = ["--client-trade-id", "--client-stake-id"]
const EMBEDDED_WORDS = new Set(["main", "embedded"])

/** What a CLI card row runs: `candle <argv>` with the agent's key. The card's hash covers all of it. */
export interface CliRowParams {
  argv: string[]
  identity: "agent"
  agent: string
  json: true
  /** The row, such as "stake add": the kill switch and the outcome rules go by it. */
  row: string
  /** An image upload's staged file: its SHA-256 and size, checked again before the run. */
  file?: { path: string; sha256: string; bytes: number }
}

/** A planned CLI card, before the card book adds the id, the hash, the limits and the display. */
export interface CliPlan {
  /** The words after `candle`, with the wallet by address, the core's id and `--yes`. */
  argv: string[]
  /** Whether the command takes `--rpc-url`, which the core adds from config. */
  rpcUrl: boolean
  /** The paying wallet's address, or "none". */
  wallet: string
  tee?: { address: string; label?: string }
  /** "buy" for what spends (an LP add, a launch's first buy): valued and held to the Candle Harness limits. */
  side?: "buy"
  usd?: number
  spends?: string
  pricedAt?: number
  title: string
  headline: string
  preview?: string
  publicNote?: string
  resendNote: string
  file?: CliRowParams["file"]
}

export interface CliPlanContext {
  agent: string
  /** The card's id, minted by the card book. */
  opId: string
  /** Which wallet pays, by the agent's word (AgentWallets.payer on Solana). */
  payer: (word: string | undefined) => PayerResult
  /** A base asset's or a token's USD price, read now. */
  price: (assetOrMint: string) => Promise<{ usd: number; at: number } | undefined>
  /** Candle's staking read, for a stake card's figures. */
  readStaking: () => Promise<Record<string, unknown> | undefined>
  /** A dry run through the CLI when the card is made (a TEE wallet's launch). */
  dryRun: (argv: string[]) => Promise<CliResult>
  researchDir: string
  /** A TEE wallet's empty token accounts as last counted, for a close card's words. Never read on the card's path. */
  emptyOf?: (address: string) => EmptyState | undefined
  stage: UploadStage
  refuse: (code: string, message: string, details?: Record<string, unknown>) => Promise<never>
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
const DECIMAL = /^\d+(\.\d+)?$/
const positive = (text: string | undefined): text is string => text !== undefined && DECIMAL.test(text) && Number(text) > 0
const grouped = (amount: string): string => {
  const [whole, frac] = amount.split(".")
  return `${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${frac ? `.${frac}` : ""}`
}

/** The value after a flag in argv, or undefined. */
const flagValue = (argv: readonly string[], flag: string): string | undefined => {
  const at = argv.indexOf(flag)
  return at >= 0 ? argv[at + 1] : undefined
}

/** argv's positionals after the command words: what isn't a flag or a value flag's value. */
function positionals(argv: readonly string[], words: number, valueFlags: ReadonlySet<string>): string[] {
  const out: string[] = []
  for (let i = words; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg.startsWith("-")) {
      if (valueFlags.has(arg)) i++
      continue
    }
    out.push(arg)
  }
  return out
}

/** The same argv with one flag's value replaced. */
const withFlag = (argv: readonly string[], flag: string, value: string): string[] => argv.map((a, i) => (argv[i - 1] === flag ? value : a))

export function cardRowOf(row: string): CardRow {
  const spec = rowFor(row)?.card
  if (!spec) throw new Error(`${row} isn't a CLI card row`)
  return spec
}

/** A CLI card row as candle_cli resolved it: the row, the words after `candle`, and what the source says of its flags. */
export interface CliCardRequest {
  row: string
  words: string[]
  /** The value flags it takes, to tell its positionals apart. */
  valueFlags: string[]
  /** Whether it takes `--rpc-url`, which the core adds from config. */
  rpcUrl: boolean
  /** Whether it takes `--yes`, which the core always adds where it does (image upload has no prompt, and no flag). */
  yes: boolean
}

/**
 * Plans a CLI card row from the agent's or the user's words (resolved against the table already):
 * the paying wallet by address, the core's id and `--yes`, the value where it spends, the card's
 * words. A refusal makes no card.
 */
export async function planCliRow(request: CliCardRequest, ctx: CliPlanContext): Promise<CliPlan> {
  const { row, words } = request
  const valueFlags = new Set(request.valueFlags)
  const spec = cardRowOf(row)
  const given = ID_FLAGS.find((f) => words.includes(f))
  if (given) return ctx.refuse("CLIENT_ID_BY_HARNESS", `The Candle Harness gives every card its own id; leave ${given} out. Nothing was sent.`)
  const commandWords = row.split(" ").length
  const args = positionals(words, commandWords, valueFlags)
  let argv = [...words]
  let wallet = "none"
  let tee: CliPlan["tee"]
  let walletName = ""

  if (spec.wallet !== "none") {
    const word = flagValue(words, "--wallet")
    const named = word !== undefined && !EMBEDDED_WORDS.has(word) ? word : undefined
    // From the embedded wallet, a staking row or a launch is Candle's own tool, which the agent calls.
    const useTool = () => ctx.refuse("USE_MCP_TOOL", rowFor(row)?.note ?? `candle ${row} runs from a TEE wallet: name it with --wallet <its label or address>. Nothing was sent.`)
    if (spec.wallet === "tee" && named === undefined) await useTool()
    const payer = ctx.payer(named ?? "embedded")
    if (!payer.ok) return ctx.refuse(payer.code, payer.message, { canPayFrom: payer.canPayFrom })
    if (payer.kind === "embedded" && spec.wallet === "tee") await useTool()
    // close-empty takes either wallet in the CLI, but an agent's key can't close the embedded wallet's.
    if (payer.kind === "embedded" && spec.embeddedHeld !== undefined) return ctx.refuse("NEEDS_TRANSFER_WRITE", `candle ${row} from the embedded wallet isn't in the Candle Harness: ${spec.embeddedHeld} Nothing was sent.`)
    wallet = payer.address
    if (payer.kind === "tee") {
      tee = { address: payer.address, ...(payer.label ? { label: payer.label } : {}) }
      walletName = payerName(payer)
    } else walletName = "embedded wallet"
    // By address, never by label: the hash binds the wallet that pays.
    argv = word === undefined ? [...argv, "--wallet", payer.address] : withFlag(argv, "--wallet", payer.address)
  }

  let plan: Omit<CliPlan, "argv" | "rpcUrl" | "wallet" | "tee">
  const [, action] = row.split(" ")
  if (spec.kind === "stake") plan = await planStake(action!, args, wallet, walletName, ctx)
  else if (spec.kind === "upload") {
    const planned = await planUpload(args, words.includes("--banner"), ctx)
    argv = ["image", "upload", planned.file!.path, ...(words.includes("--banner") ? ["--banner"] : [])]
    plan = planned
  } else if (spec.kind === "lp") plan = await planLp(action!, args, words, walletName, ctx)
  else if (spec.kind === "launch") plan = await planLaunch(argv, words, walletName, ctx)
  else plan = planClose(words, walletName, ctx.emptyOf?.(wallet))

  if (spec.idFlag) argv.push(spec.idFlag, ctx.opId)
  if (request.yes) argv.push("--yes")
  return { ...plan, argv, rpcUrl: request.rpcUrl, wallet, ...(tee ? { tee } : {}) }
}

async function planStake(action: string, args: string[], wallet: string, walletName: string, ctx: CliPlanContext): Promise<Omit<CliPlan, "argv" | "rpcUrl" | "wallet" | "tee">> {
  const invalid = (message: string) => ctx.refuse("INVALID_STAKE", message)
  if (action === "finish" ? args.length > 1 : args.length !== 1 || !positive(args[0])) {
    await invalid(action === "finish" ? "Name at most one withdrawal to finish, as candle_get_staking lists it." : `candle stake ${action} takes one amount, a positive decimal such as "10".`)
  }
  const positions = await ctx.readStaking()
  const own = (Array.isArray(positions?.wallets) ? positions.wallets : []).map(record).find((w) => w?.address === wallet)
  const wait = record(positions?.pool)?.withdrawalTimelockSeconds
  let headline: string
  if (action === "add") headline = `STAKE ${grouped(args[0]!)} CNDL`
  else if (action === "remove") headline = `UNSTAKE ${grouped(args[0]!)} sCNDL`
  else headline = args[0] ? `FINISH UNSTAKE ${short(args[0])}` : "FINISH UNSTAKE"
  const preview = [
    action !== "finish" && typeof wait === "number" ? `pool wait ${duration(wait)}${action === "remove" ? ", then finish it" : " to unstake later"}` : undefined,
    action === "finish" && !args[0] ? "finishes the wallet's one matured withdrawal" : undefined,
    own === undefined && positions !== undefined ? "Candle's staking read doesn't list this wallet yet" : undefined,
  ].filter(Boolean)
  return {
    title: `${headline} · ${walletName}`,
    headline,
    ...(preview.length ? { preview: preview.join(" · ") } : {}),
    resendNote: "Re-send runs it again under the same --client-stake-id: the CLI resumes its saved transaction and never sends a second.",
  }
}

/**
 * The path rule: a regular file whose real path is inside the agent's research
 * folder (a relative path is taken from there, where the agent works), at most 10 MB, and a PNG,
 * JPEG, GIF or WebP by its first bytes, as the CLI checks. Then it's staged.
 */
async function planUpload(args: string[], banner: boolean, ctx: CliPlanContext): Promise<Omit<CliPlan, "argv" | "rpcUrl" | "wallet" | "tee">> {
  const refuse = (message: string) => ctx.refuse("PATH_NOT_ALLOWED", `${message} Nothing was uploaded.`)
  if (args.length !== 1) return refuse("candle image upload takes one file.")
  const given = args[0]!
  const folder = await realpath(ctx.researchDir).catch(() => undefined)
  if (!folder) return refuse(`${ctx.agent}'s research folder doesn't exist yet.`)
  const real = await realpath(isAbsolute(given) ? given : join(ctx.researchDir, given)).catch(() => undefined)
  if (!real) return refuse(`There's no file at ${terminalText(given, { maxLength: 200 })}.`)
  if (!real.startsWith(folder + sep)) return refuse(`Only a file in ${ctx.agent}'s research folder (${ctx.researchDir}) can be uploaded; ${terminalText(given, { maxLength: 200 })} is outside it, or links outside it.`)
  const info = await stat(real)
  if (!info.isFile()) return refuse(`${terminalText(given, { maxLength: 200 })} isn't a file.`)
  if (info.size > MAX_IMAGE_BYTES) return refuse(`${terminalText(given, { maxLength: 200 })} is over 10 MB, the largest image Candle hosts.`)
  const type = await imageType(real)
  if (!type) return refuse(`${terminalText(given, { maxLength: 200 })} isn't a PNG, JPEG, GIF or WebP image (by its first bytes, as the candle CLI checks).`)
  const file = await ctx.stage.stage(ctx.opId, real, type.ext)
  const name = terminalText(basename(real), { maxLength: 60 })
  const what = banner ? "BANNER" : "IMAGE"
  return {
    title: `UPLOAD ${what} ${name} (${type.name}, ${sizeText(file.bytes)})`,
    headline: `UPLOAD ${what} ${name}`,
    preview: `from ${terminalText(relative(folder, real), { maxLength: 120 })} in ${ctx.agent}'s research folder · sha256 ${file.sha256.slice(0, 12)}…`,
    publicNote: "public and permanent: Candle pins the file, and its URL can't be taken back",
    resendNote: "An upload has no id: a re-send uploads the file again, and the first upload, if it went through, stays public.",
    file,
  }
}

async function planLp(action: string, args: string[], words: readonly string[], walletName: string, ctx: CliPlanContext): Promise<Omit<CliPlan, "argv" | "rpcUrl" | "wallet" | "tee">> {
  const invalid = (message: string) => ctx.refuse("INVALID_LP", message)
  const resendNote = "Re-send runs it again under the same --client-trade-id: the CLI confirms the saved signature and sends nothing new."
  if (action === "add") {
    const amount = flagValue(words, "--amount")
    if (args.length !== 2 || !positive(amount)) await invalid("candle lp add takes <pool> <token> and --amount <decimal>.")
    const [pool, token] = args as [string, string]
    const asset = token.toUpperCase()
    const price = await ctx.price(isBaseAsset(asset) ? asset : token)
    const usd = price ? Number(amount) * price.usd : undefined
    const label = isBaseAsset(asset) ? asset : short(token)
    const headline = `LP ADD ${grouped(amount!)} ${label}`
    return {
      side: "buy",
      ...(usd !== undefined ? { usd } : {}),
      spends: `${label}, at most, into the pool at its ratio`,
      ...(price ? { pricedAt: price.at } : {}),
      title: `${headline}${usd !== undefined ? ` (≈$${usd.toFixed(2)})` : ""} · pool ${short(pool)} · ${walletName}`,
      headline,
      resendNote,
    }
  }
  if (args.length !== 1) await invalid(`candle lp ${action} takes one position.`)
  const percent = flagValue(words, "--percent")
  if (action === "remove" && !positive(percent)) await invalid("candle lp remove takes --percent, from 0.01 to 100.")
  const headline = action === "remove" ? `LP REMOVE ${percent}%` : "LP CLAIM FEES"
  return { title: `${headline} · position ${short(args[0]!)} · ${walletName}`, headline, resendNote }
}

async function planLaunch(argv: readonly string[], words: readonly string[], walletName: string, ctx: CliPlanContext): Promise<Omit<CliPlan, "argv" | "rpcUrl" | "wallet" | "tee">> {
  const symbol = flagValue(words, "--symbol")
  const name = flagValue(words, "--name")
  if (!symbol || !name || !flagValue(words, "--image-url")) await ctx.refuse("INVALID_LAUNCH", "candle launch takes --name, --symbol and --image-url (upload a file first with candle image upload).")
  const buy = flagValue(words, "--buy")
  if (buy !== undefined && !positive(buy)) await ctx.refuse("INVALID_LAUNCH", "--buy is a positive decimal amount of the quote asset.")
  const quote = (flagValue(words, "--quote-asset") ?? "sol").toUpperCase()
  const dry = await ctx.dryRun([...argv.filter((a) => a !== "--dry-run"), "--client-trade-id", ctx.opId, "--dry-run"])
  const body = record(dry.json)
  if (dry.timedOut || dry.exitCode !== 0 || !body) {
    const said = typeof body?.message === "string" ? terminalText(body.message, { maxLength: 300 }) : "no answer"
    return ctx.refuse(typeof body?.code === "string" ? body.code : "DRY_RUN_REFUSED", `The candle CLI's dry run refused it: ${said}. No card was made, and nothing was sent.`)
  }
  const price = buy !== undefined && isBaseAsset(quote) ? await ctx.price(quote) : undefined
  const usd = buy !== undefined && price ? Number(buy) * price.usd : undefined
  const seed = buy !== undefined ? ` + first buy ${grouped(buy)} ${quote}` : ""
  const sym = terminalText(symbol!, { maxLength: 16 })
  return {
    ...(buy !== undefined ? { side: "buy" as const, spends: `${quote}, the first buy` } : {}),
    ...(usd !== undefined ? { usd } : {}),
    ...(price ? { pricedAt: price.at } : {}),
    title: `LAUNCH ${sym} (${terminalText(name!, { maxLength: 40 })})${seed} · ${walletName}`,
    headline: `LAUNCH ${sym}${seed}`,
    preview: "the candle CLI's dry run passed",
    publicNote: "public: a new token can't be taken back",
    resendNote: "Re-send runs it again under the same --client-trade-id, which the CLI reads first: it never launches a second token.",
  }
}

function planClose(words: readonly string[], walletName: string, empty: EmptyState | undefined): Omit<CliPlan, "argv" | "rpcUrl" | "wallet" | "tee"> {
  const keep = words.filter((w, i) => words[i - 1] === "--keep")
  const kept = keep.length ? ` · keeps ${keep.map(short).join(", ")}` : ""
  // Candle's preview when it was last read; the run closes what Candle's preview finds then.
  const counted = isCounted(empty) && empty.count > 0 ? `${empty.count} empty token account${empty.count === 1 ? "" : "s"} · ${empty.netSol} SOL back to the same wallet` : "rent back to the same wallet"
  return {
    title: `CLOSE EMPTY ACCOUNTS · ${walletName}`,
    headline: "CLOSE EMPTY ACCOUNTS",
    preview: `${counted}${kept}`,
    resendNote: "Re-send runs it again under the same --client-trade-id, which reads the stored report first: it never closes twice.",
  }
}

/** The four image types Candle hosts, by their first bytes (cli/src/commands/image.ts, sniffImageType). */
async function imageType(path: string): Promise<{ name: string; ext: string } | undefined> {
  const handle = await open(path, "r")
  try {
    const head = new Uint8Array(12)
    await handle.read(head, 0, 12, 0)
    const at = (offset: number, bytes: number[]) => bytes.every((b, i) => head[offset + i] === b)
    if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { name: "PNG", ext: ".png" }
    if (at(0, [0xff, 0xd8, 0xff])) return { name: "JPEG", ext: ".jpg" }
    if (at(0, [0x47, 0x49, 0x46, 0x38]) && (head[4] === 0x37 || head[4] === 0x39) && head[5] === 0x61) return { name: "GIF", ext: ".gif" }
    if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return { name: "WebP", ext: ".webp" }
    return undefined
  } finally {
    await handle.close()
  }
}

const sizeText = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`)

/** Seconds as days or hours: "7 days", "36 hours". */
function duration(seconds: number): string {
  if (seconds >= 86_400 && seconds % 86_400 === 0) return `${seconds / 86_400} day${seconds === 86_400 ? "" : "s"}`
  const hours = Math.round(seconds / 3600)
  return hours >= 1 ? `${hours} hour${hours === 1 ? "" : "s"}` : `${Math.round(seconds / 60)} minutes`
}

const sha256 = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex")

/**
 * Upload files, copied into the core's state folder (0600) when a card is made: the agent can't
 * change what's uploaded after the user saw the card. A copy is kept while its operation may still
 * be re-sent, and removed once the card closes or its operation settles.
 */
export class UploadStage {
  constructor(private readonly dir: string) {}

  async stage(opId: string, source: string, ext: string): Promise<{ path: string; sha256: string; bytes: number }> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    const path = join(this.dir, `${opId}${ext}`)
    await copyFile(source, path)
    await chmod(path, 0o600)
    return { path, sha256: await sha256(path), bytes: (await stat(path)).size }
  }

  /** Whether the staged copy is still the file the card showed. */
  async unchanged(file: { path: string; sha256: string }): Promise<boolean> {
    return sha256(file.path).then((hash) => hash === file.sha256, () => false)
  }

  async release(opId: string): Promise<void> {
    for (const name of await readdir(this.dir).catch(() => [] as string[])) {
      if (name.startsWith(`${opId}.`)) await rm(join(this.dir, name), { force: true })
    }
  }

  /** At start: every staged copy whose operation can't be re-sent any more goes. */
  async sweep(keep: ReadonlySet<string>): Promise<void> {
    for (const name of await readdir(this.dir).catch(() => [] as string[])) {
      if (!keep.has(name.slice(0, name.length - extname(name).length))) await rm(join(this.dir, name), { force: true })
    }
  }
}

/** Codes the CLI raises, for each kind, only before anything was signed, sent or published. Anything else may have run. */
const BEFORE_ANYTHING = [...PRE_BUILD_CODES].filter((c) => c !== "RPC_FAILED" && c !== "RPC_RATE_LIMITED")
const NOTHING_SENT: Record<CardRow["kind"], ReadonlySet<string>> = {
  stake: new Set([...BEFORE_ANYTHING, "STAKING_WALLET_REQUIRED", "STAKING_WITHDRAWAL_REQUIRED"]),
  upload: new Set(["USAGE", "IMAGE_UNREADABLE", "IMAGE_TOO_LARGE", "IMAGE_TYPE_UNSUPPORTED", "NO_API_KEY", "API_KEY_REQUIRED", "SCOPE_MISSING", "RATE_LIMITED", "UPLOAD_INVALID"]),
  lp: new Set([...BEFORE_ANYTHING, "LP_NOT_ENABLED"]),
  launch: new Set(BEFORE_ANYTHING),
  close: new Set([...BEFORE_ANYTHING, "AGENT_WALLET_MISSING"]),
}

/** Whether an exit-0 answer says it went through, by kind. */
function wentThrough(kind: CardRow["kind"], body: Record<string, unknown>): Mapped["state"] {
  switch (kind) {
    case "stake":
      return body.status === "confirmed" && typeof body.signature === "string" ? "succeeded" : "unknown"
    case "upload":
      return body.success === true && typeof body.imageUrl === "string" ? "succeeded" : "unknown"
    case "lp":
      return typeof body.signature === "string" ? "succeeded" : "unknown"
    case "launch": {
      const job = record(body.job)
      if (job) return launchJobState(job)
      return typeof body.mint === "string" || body.status === "confirmed" ? "succeeded" : "unknown"
    }
    case "close":
      return closeState(body)
  }
}

/**
 * A close's answer (CLI 0.13.5): the submit's `{ status: "completed", signatures, … }`, or, read back under the same
 * id, the stored job `{ job: { status, result: { status } } }`. A job that was built and never submitted sent nothing
 * (the CLI says so, and exits 0), so it failed; it isn't re-sent under that id. Anything else is unknown.
 */
function closeState(body: Record<string, unknown>): Mapped["state"] {
  const job = record(body.job)
  const status = job ? (record(job.result)?.status ?? job.status) : body.status
  if (status === "completed" || status === "nothing_to_close") return "succeeded"
  if (job && status === "built") return "failed"
  return "unknown"
}

function errorOf(code: string, body: Record<string, unknown>): OperationError {
  if (code === "SIGNER_UNAVAILABLE") return { code, message: "This machine doesn't hold the TEE wallet's signer, so the candle CLI couldn't sign. Nothing was sent. candle-harness doctor shows which wallets have one.", retryable: false }
  if (code === "USAGE") return { code, message: "The Candle Harness built a command the candle CLI didn't accept. Nothing was sent. This is a bug in the Candle Harness.", retryable: false }
  const message = refusalMessage(code, body) ?? (typeof body.message === "string" ? terminalText(body.message, { maxLength: 500 }) : code)
  return { code, message, retryable: body.retryable === true }
}

/**
 * A CLI card row's run as an operation state. Exit 0 is read by its body; exit 1 or 2 is a refusal
 * only for a code raised before anything was signed, sent or published; everything else, exit 3
 * included, is unknown and read back by the row's rule.
 */
export function mapCliRow(row: string, run: Pick<CliResult, "exitCode" | "timedOut" | "json" | "jsonError">): Mapped {
  const kind = cardRowOf(row).kind
  if (run.timedOut) return { state: "unknown", reason: "the candle CLI didn't finish in time" }
  const body = record(run.json)
  if (!body) return { state: "unknown", reason: run.jsonError ? "the candle CLI's answer couldn't be read" : "the candle CLI stopped without an answer" }
  if (run.exitCode === 0) {
    const state = wentThrough(kind, body)
    if (state === "failed") return { state, result: body, error: { code: "CLOSE_NOT_SUBMITTED", message: "Candle built the close and it was never submitted, so nothing was sent. Closing them again makes a new close.", retryable: false } }
    return state === "unknown" ? { state, result: body, reason: "the candle CLI's answer didn't say it went through" } : { state, result: body }
  }
  const code = typeof body.code === "string" ? body.code : `CLI_EXIT_${run.exitCode}`
  const error = errorOf(code, body)
  if (run.exitCode === 3) return { state: "unknown", result: body, error, reason: "the candle CLI says it may have gone through (exit 3)" }
  if ((run.exitCode === 1 || run.exitCode === 2) && NOTHING_SENT[kind].has(code)) return { state: "refused", result: body, error }
  return { state: "unknown", result: body, error, reason: `${code}: it may have gone through` }
}

export class CliCards {
  constructor(
    private readonly deps: {
      cli: Pick<CandleCli, "runExact">
      redactor: { value(v: unknown): unknown }
      journal: Journal
      stage: UploadStage
      now: () => number
    },
  ) {}

  /** Runs an approved card's argv, exactly, with the agent's key. An upload's staged file is checked first. */
  async execute(op: Operation): Promise<Mapped> {
    const p = op.params as unknown as CliRowParams
    if (p.file && !(await this.deps.stage.unchanged(p.file))) {
      return { state: "refused", error: { code: "UPLOAD_FILE_CHANGED", message: "The file the card showed is gone or changed in the Candle Harness's copy, so nothing was uploaded.", retryable: false } }
    }
    const run = await this.deps.cli.runExact({ agent: p.agent, argv: p.argv, json: true })
    const clean = { ...run, ...(run.json !== undefined ? { json: this.deps.redactor.value(run.json) } : {}) }
    if (record(clean.json)?.code === "USAGE") {
      await this.deps.journal.append({ type: "core.bug", mode: op.mode, agent: op.agent, opId: op.opId, what: `candle ${p.row} refused the Candle Harness's argv as USAGE`, argv: p.argv })
    }
    return mapCliRow(p.row, clean)
  }

  /**
   * One read back by the row's rule, or undefined when there's none to make now: a rerun only within
   * the card's lifetime (after it, a run that never started would start: that's the user's call), and
   * a rerun that's refused leaves it unknown, since that's an answer about the rerun.
   */
  async read(op: Operation): Promise<{ mapped: Mapped; detail: string } | undefined> {
    const p = op.params as unknown as CliRowParams
    const spec = cardRowOf(p.row)
    if (spec.readBack === "none") return undefined
    if (spec.readBack === "rerun") {
      if (this.deps.now() >= op.cardExpiresAt) return undefined
      const mapped = await this.execute(op)
      return mapped.state === "refused" ? { mapped: { state: "unknown", reason: `a rerun was refused (${mapped.error?.code ?? "?"})` }, detail: "rerun refused" } : { mapped, detail: "rerun" }
    }
    const run = await this.deps.cli.runExact({ agent: p.agent, argv: ["swap", "status", op.opId, "--kind", "launch", "--json"], json: true }).catch(() => undefined)
    const body = record(run?.json === undefined ? undefined : this.deps.redactor.value(run.json))
    const job = record(body?.job)
    if (run?.exitCode === 0 && job) return { mapped: { state: launchJobState(job), result: job }, detail: "launch job" }
    return { mapped: { state: "unknown" }, detail: typeof body?.code === "string" ? body.code : "unreadable" }
  }
}

// Every command the `candle` CLI routes, as data, with the rule the agent meets, who it
// runs as, and the route it takes (or `later`, held with why). The flags
// each row accepts come from the CLI's own source (cli-source.json, read by
// scripts/read-cli-source.ts), less every flag the agent may never pass.
//
// Rules: read (runs at once); less-access (only narrows: a one-press card from the agent, at once when
// typed); card, owner, ceremony, funds-out (a one-press card or the prompt pane, unless held); mcp (Candle's MCP tool does this: use
// it); never (not something the agent runs).
import source from "./cli-source.json"

export type CliRule = "read" | "less-access" | "card" | "owner" | "ceremony" | "funds-out" | "mcp" | "never"
export type Route = "cli" | "card" | "pane" | "later"
export type Identity = "agent" | "owner"

export interface CliRow {
  /** "keys revoke", "keys wallets set": command, subcommand, and the action word some take. */
  path: string
  rule: CliRule
  route: Route
  /** agent: the agent's key (CANDLE_API_KEY). owner: the user's own CLI profile, no key passed. */
  identity: Identity
  /** The MCP tool that does this, for rule `mcp`. */
  mcpTool?: string
  /** A narrower rule by flags, for rows whose meaning depends on them (conservative: unsure is owner). */
  byFlags?: (flags: Map<string, string | true>) => { rule: CliRule; route: Route } | undefined
  /** What `byFlags` changes, in the commands pane's words ("now", "coming"). */
  partly?: string
  /** Why, for rule `never` and for a row whose rule the CLI's source alone wouldn't suggest. */
  note?: string
  /**
   * Done by another route than candle_cli: the commands pane says "now", and `via` says how (`swap` is
   * candle_trade or candle_swap with wallet; staking, launches, fee claims, profile edits and posts are
   * Candle's own tools).
   */
  via?: string
  /** One of the CLI's card rows through candle_cli: how it becomes a card. */
  card?: CardRow
  /** Held "coming" with why, for a row that isn't a card (`transfer`). */
  held?: string
  /** The palette's request for the agent, where the CLI's help line wouldn't read as one ("buy 30 days" reads as a trade). */
  ask?: string
  /** How it runs in the prompt pane: every owner, ceremony and funds-out row, and the few others that prompt. */
  pane?: PaneSpec
  /**
   * At most this many positionals, the action word not counted, for a row whose rule rests on its words:
   * an extra word would run as something the rule never saw.
   */
  takes?: number
}

/**
 * How a row runs in the CLI prompt pane, where the user answers the CLI's own prompts and the agent
 * sees only how it ended.
 */
export interface PaneSpec {
  /**
   * The factor step (`candle vault status --unlock`) before the command: an owner row the CLI runs
   * without unlocking the vault, so the CLI checks the factor first. False where the command unlocks it itself, so the user
   * isn't asked twice, and for ceremonies, where the user is at the pane typing a secret.
   */
  factorFirst: boolean
  /** The three rows whose stdout may be piped: what the launcher reads from it, and nothing else. */
  capture?: "code" | "addresses" | "new-key"
  /** Paths the agent may never give, named by the user in the pane: a path flag, or a path positional such as `<path>`. */
  askPaths?: { flag: string; prompt: string }[]
  /** `profile remove`: the CLI never prompts, so the card is its only gate and the core adds `--yes`. */
  addsYes?: true
  /** The CLI's own prompts, in the card's words. */
  confirms: string[]
  /** Forbidden flags this row takes anyway, since here they name no path or identity (`--from`: a vault key's label). */
  lifts?: string[]
  /** Why a read or a narrowing runs in the pane anyway: it asks at the CLI's own prompt. */
  needsPrompt?: string
  /** A ceremony's line on the card: what it shows or takes. */
  shows?: string
  /** What may be on the pane once the command has started, so a stop is never told as "nothing was shown". */
  reveals?: string
  /** The outcome words for exit 3, where the row's own meaning isn't "may still land". */
  exit3?: string
  /** At most this many positionals: a row whose secret goes into a hidden prompt takes none on its command line. */
  positionals?: number
}

/**
 * The oldest CLI the Candle Harness runs on: the one its command table was read from (cli-source.json), which
 * bundles MCP server 0.10.31. One CLI: the one it was checked against. 0.13.20 is the first that waits for
 * Candle's browser confirm on an owner step; an older one is refused it once Candle turns the confirm on.
 */
export const MIN_CANDLE_CLI = "0.13.20"

/** The rules that run in the prompt pane. */
export const PANE_RULES: ReadonlySet<CliRule> = new Set(["owner", "ceremony", "funds-out"])

/** Whether the vault is unlocked by the command itself (scripts/read-cli-source.ts, `unlocksOf`). */
export type Unlocks = "always" | "if-vault" | "if-tee-and-vault" | "never"

/**
 * How a CLI row becomes a one-press card. The card runs `candle <argv>` with the
 * agent's key, and its hash covers that argv with every flag the core adds.
 */
export interface CardRow {
  /** The card's kind: what the kill switch, the limits, the journal and the session block go by. */
  kind: "stake" | "upload" | "lp" | "launch" | "close"
  /** The flag the core puts the card's id on. The CLI keeps the id durable: on Candle, or in its own operations folder. */
  idFlag?: "--client-stake-id" | "--client-trade-id"
  /**
   * How a lost answer is read back. rerun: the same argv again, which the CLI turns into a read or a
   * resume under the same id; only within the card's lifetime, since a run that never started would
   * start then. launch: `candle swap status <id> --kind launch`. none: the user's call.
   */
  readBack: "rerun" | "launch" | "none"
  /** Paused, the kill switch stops it, since it spends or publishes; otherwise it's kept. */
  stops: boolean
  /** Which wallet pays: a TEE wallet named by --wallet (the embedded wallet's form is Candle's own tool), either, or none. */
  wallet: "tee" | "either" | "none"
  /** Built on the card path, and held "coming" until it's checked live, with why. */
  held?: string
  /** A row that takes either wallet, but never from the embedded one with an agent's key: why (close-empty's transfer:write). */
  embeddedHeld?: string
}

export interface SourceEntry {
  command: string
  subcommand: string | null
  identity: "agent" | "owner" | "both" | "none" | "unknown"
  json: boolean
  /** `byAction`: the value flags each action word takes, for a handler with an action table (agent post). */
  flags: { value: string[]; boolean: string[]; path: string[]; pathPositionals: string[]; byAction?: Record<string, string[]> } | null
  /** Whether anything it can reach unlocks the vault, under any flags. */
  unlocks: Unlocks
  /** The streams it checks are a terminal, under any flags. */
  tty: ("stdin" | "stdout" | "stderr")[]
  /** For a handler that only dispatches a word (`vault factor add`): the same, per word. */
  actions?: Record<string, { unlocks: Unlocks; tty: ("stdin" | "stdout" | "stderr")[] }>
}

/** An access preset as the CLI mints it (agent-key-access.ts): the words it's shown as, and its exact scopes. */
export interface Preset {
  label: string
  scopes: string[]
}

/** A command word's screen in the CLI's own help (help.ts): its group, summary and subcommand rows. */
export interface HelpTopic {
  group: string
  display?: string
  summary: string
  rows: { invocation: string; description: string }[]
}

export const SOURCE = source as {
  source: { repo: string; commit: string; cliVersion: string }
  /** Command-word aliases the CLI resolves before routing (`wallet` for `wallets`). */
  aliases: Record<string, string>
  helpTopics: string[]
  groups: string[]
  help: Record<string, HelpTopic>
  commands: SourceEntry[]
  presets: Record<"read" | "readwrite" | "readwritetransfer" | "tradeperps", Preset>
}

/**
 * The scopes of a new LP agent's key: Write's exact list, as the CLI read mints it, plus
 * `lp:write`, which no preset holds. `keys create --scopes` takes them, joined by commas. It's a custom
 * list, so changing the key's access with a preset later removes LP.
 */
export const LP_AGENT_SCOPES: readonly string[] = [...SOURCE.presets.readwrite.scopes, "lp:write"]

const STAKE_NOTE = "From the embedded wallet: candle_stake, candle_unstake or candle_finish_unstake, as a one-press card. From a TEE wallet: this command with --wallet <the TEE wallet's label or address>, a one-press card."
const LP_HELD = "Candle hasn't switched LP on for agent keys yet, and it needs a key with lp:write, which no preset has. candle-harness doctor says when Candle serves LP."
const STAKE_ROW = (stops: boolean): CardRow => ({ kind: "stake", idFlag: "--client-stake-id", readBack: "rerun", stops, wallet: "tee" })
const LP_ROW = (stops: boolean): CardRow => ({ kind: "lp", idFlag: "--client-trade-id", readBack: "rerun", stops, wallet: "tee", held: LP_HELD })
/** A row's pane, as written in the table: the factor step comes from the source read unless a row says otherwise. */
type PaneInput = Partial<PaneSpec>
type RowInput = Omit<CliRow, "pane"> & { pane?: PaneInput }
const r = (path: string, rule: CliRule, route: Route, identity: Identity, extra: Partial<RowInput> = {}): RowInput => ({ path, rule, route, identity, ...extra })
const mcp = (path: string, tool: string, identity: Identity = "agent") => r(path, "mcp", "cli", identity, { mcpTool: tool })
const never = (path: string, note: string, identity: Identity = "owner") => r(path, "never", "later", identity, { note })
const CONFIRM = "you'll type confirm"
/** A send's own prompts (commands/vault-transfer.ts, vault-fund.ts): the unlock names the send, then the destination in full and a typed confirm. */
const SEND_CONFIRMS = ["the CLI asks for your vault passphrase itself, naming the send", "it prints the destination in full, in groups of four, and you type confirm"]
/** A sweep's (commands/tee.ts, external.ts): the unlock, then where everything goes and a typed confirm. */
const SWEEP_CONFIRMS = ["the CLI asks for your vault passphrase itself", "it names where everything goes, and you type confirm"]
/** `vault factor add <kind>` and `vault enroll <kind>` are one handler (index.ts:321): a passphrase factor shows a generated one. */
const ADDS_FACTOR = "Adds a factor. It may show a new passphrase."
const TOKEN_PAGES_HELD = "It writes to a token's public page as the key's account, which needs token-pages:write. No preset has it, so no agent key in the Candle Harness does. Run it in your own terminal with a key made for it."
const SPEND_NOTE = "The CLI's own log and limits for x402 per-use payments, which the Candle Harness never makes: token forensics and the vamp finder go through Candle's MCP tools, which don't pay. Run it in your own terminal."
const LAB_NOTE = "Use hacc_lab: the Candle Harness's own strategy lab tool, offered on the plan that has the lab, which follows a replay to the end and says how it ended."
/** A plan payment's own prompts (commands/plan.ts): the price and the terms, a typed confirm, then the vault key's unlock. */
const PLAN_CONFIRMS = ["it shows the price and Candle's terms, and you type confirm", "the CLI asks for your vault passphrase itself, to sign the payment"]
const VAULT_PROMPT = "It finds the wallet's key in this machine's vault (or the older TEE wallet store), so it asks for that passphrase at the CLI's own prompt."

const ROWS: readonly RowInput[] = [
  // Trade
  r("stake", "read", "cli", "agent"),
  // From the embedded wallet, Candle's own staking tools are the cards; a TEE wallet's
  // staking is these rows with --wallet, through the CLI, which signs.
  r("stake add", "card", "card", "agent", { via: "candle_stake from the embedded wallet", note: STAKE_NOTE, card: STAKE_ROW(true) }),
  r("stake remove", "card", "card", "agent", { via: "candle_unstake from the embedded wallet", note: STAKE_NOTE, card: STAKE_ROW(false) }),
  r("stake finish", "card", "card", "agent", { via: "candle_finish_unstake from the embedded wallet", note: STAKE_NOTE, card: STAKE_ROW(false) }),
  r("stake claim", "card", "card", "agent", { via: "candle_claim_staking_reward", note: "Use candle_claim_staking_reward with the reward's id, as candle_get_staking lists it: a one-press card." }),
  // A TEE wallet's trade or swap is candle_trade or candle_swap with `wallet`: one
  // parser and one card path, which runs `candle swap` itself.
  r("swap", "card", "card", "agent", { via: "candle_trade or candle_swap with wallet", note: "From any wallet the agent can pay from: candle_trade or candle_swap with wallet. The Candle Harness runs candle swap for a TEE wallet." }),
  r("swap status", "read", "cli", "agent"),
  // Funds go out by the owner's vault-signed routes only.
  r("transfer", "funds-out", "later", "agent", {
    held: "It needs a Withdraw key, and every agent key in the Candle Harness is Write, which can't move funds. Send from a TEE wallet whose key is in this machine's vault with candle vault transfer, or sweep a disabled one home with candle tee sweep.",
  }),
  r("launch", "card", "card", "agent", {
    via: "candle_launch_token or candle_launch_and_seed from the embedded wallet",
    note: "From the embedded wallet: candle_launch_token, or candle_launch_and_seed with a seed, as a one-press card with an image URL.",
    partly: "from the embedded wallet, and --check (reads); a TEE wallet: coming",
    // --check (0.13.5) answers which launch path works on the key, with nothing uploaded, built or sent
    // (launch-check.ts: one GET of /launch/preflight), so it's a read.
    byFlags: (flags) => (flags.has("--check") ? { rule: "read", route: "cli" } : undefined),
    card: {
      kind: "launch",
      idFlag: "--client-trade-id",
      readBack: "launch",
      stops: true,
      wallet: "tee",
      held: "A TEE wallet's launch needs the owner to allow launches on that wallet (candle wallets allow-launch) and Candle's self-signed launches switched on. From the embedded wallet, use candle_launch_token or candle_launch_and_seed.",
    },
  }),
  // A launch's state by its mint or client id (0.13.11): one read, or --wait to poll for up to ten
  // minutes. It never sends a transaction.
  r("launch status", "read", "cli", "agent"),
  // The one path the agent may give: a file in its own research folder.
  r("image upload", "card", "card", "agent", { card: { kind: "upload", readBack: "none", stops: true, wallet: "none" } }),
  // The strategy lab through the CLI (0.13.9): the same Hacc lab hacc_lab reaches, over the key.
  r("lab status", "mcp", "cli", "agent", { mcpTool: "hacc_lab", note: LAB_NOTE, ask: "show the strategy lab's status: replays used and when they reset " }),
  r("lab replay", "mcp", "cli", "agent", { mcpTool: "hacc_lab", note: LAB_NOTE }),
  r("lab runners", "mcp", "cli", "agent", { mcpTool: "hacc_lab", note: LAB_NOTE }),
  r("lab edges", "mcp", "cli", "agent", { mcpTool: "hacc_lab", note: LAB_NOTE }),
  // The token card for one contract (0.13.5): Candle's candle_token_card, which the Candle Harness reads already.
  mcp("scan", "candle_token_card"),
  r("lp pools", "read", "cli", "agent"),
  r("lp positions", "read", "cli", "agent"),
  r("lp add", "card", "card", "agent", { card: LP_ROW(true) }),
  r("lp remove", "card", "card", "agent", { card: LP_ROW(false) }),
  r("lp claim", "card", "card", "agent", { card: LP_ROW(false) }),
  // Perps: reads through Candle's MCP tools; the statuses and every write wait for the perps phase.
  mcp("perps markets", "candle_perps_markets"),
  mcp("perps market", "candle_perps_market"),
  mcp("perps book", "candle_perps_book"),
  mcp("perps candles", "candle_perps_candles"),
  mcp("perps orders", "candle_perps_orders"),
  mcp("perps positions", "candle_perps_positions"),
  mcp("perps fills", "candle_perps_fills"),
  mcp("perps funding", "candle_perps_funding"),
  mcp("perps account", "candle_perps_account"),
  mcp("perps risk", "candle_perps_risk"),
  mcp("perps thresholds", "candle_perps_thresholds"),
  r("perps thresholds set", "owner", "later", "owner"),
  r("perps deposit", "card", "later", "agent"),
  r("perps deposit status", "read", "cli", "agent"),
  r("perps withdraw", "funds-out", "later", "agent"),
  r("perps withdraw status", "read", "cli", "agent"),
  r("perps setup", "card", "later", "agent"),
  r("perps open", "card", "later", "agent"),
  r("perps close", "card", "later", "agent"),
  r("perps cancel", "card", "later", "agent"),
  r("perps modify", "card", "later", "agent"),
  r("perps margin", "card", "later", "agent"),
  r("perps tpsl", "card", "later", "agent"),
  r("perps schedule-cancel", "card", "later", "agent"),
  r("perps flatten", "card", "later", "agent"),
  r("perps leverage", "card", "later", "agent"),
  r("perps reduce-only", "card", "later", "agent"),
  r("perps reduce-only on", "less-access", "later", "agent"),
  r("perps reduce-only off", "owner", "later", "owner"),
  never("perps watch", "The core watches perps risk itself; --on-warn and --on-critical run commands.", "agent"),
  // Account
  mcp("portfolio", "candle_get_portfolio"),
  mcp("pnl", "candle_get_profile_pnl"),
  mcp("plans", "candle_get_plans", "owner"),
  // Buying or renewing a plan pays USDC by x402 from a vault key (0.13.9): the CLI shows the price,
  // takes a typed confirm and unlocks the vault to sign, so it runs in the pane as the owner.
  r("plan buy", "owner", "pane", "owner", { pane: { confirms: PLAN_CONFIRMS }, ask: "pay for a Candle plan for 30 days from a vault key: " }),
  r("plan renew", "owner", "pane", "owner", { pane: { confirms: PLAN_CONFIRMS }, ask: "renew my Candle plan for the next 30 days now " }),
  r("plan status", "read", "cli", "owner", { ask: "show my Candle plan: when it ends, auto-renew and the last payment " }),
  // A local flag: on, a later command at a terminal near the period's end pays the renewal unattended.
  r("plan auto-renew", "owner", "pane", "owner", { ask: "set my Candle plan's auto-renew " }),
  r("plan auto-renew on", "owner", "pane", "owner", { ask: "turn my Candle plan's auto-renew on ", takes: 0 }),
  r("plan auto-renew off", "less-access", "cli", "owner", { ask: "turn my Candle plan's auto-renew off ", takes: 0 }),
  mcp("fees", "candle_get_fees"),
  r("fees claim", "card", "card", "agent", { via: "candle_claim_fees", note: "Use candle_claim_fees with the token's mint: a one-press card, dry-run first." }),
  mcp("agent profile", "candle_get_agent_profile"),
  mcp("agent profile show", "candle_get_agent_profile"),
  // 0.13.5's --avatar-file and --banner-file are paths, never the agent's: an image in the research
  // folder goes up by image upload's card first, then its URL into candle_update_profile. An https image
  // elsewhere goes by candle_upload_profile_image (server 0.10.25), which re-hosts and sets it in one call.
  r("agent profile set", "card", "card", "agent", {
    via: "candle_update_profile",
    note: "Use candle_update_profile: a one-press card, public. Its avatar and banner take only an uploads.candle.tv URL: for an image at another https address, use candle_upload_profile_image (its own card); for a file in your research folder, upload it with candle image upload first, then pass its URL.",
  }),
  // A published agent's open positions (0.13.9), keyless.
  mcp("agent positions", "candle_get_agent_positions"),
  mcp("agent post", "candle_list_agent_posts"),
  mcp("agent post list", "candle_list_agent_posts"),
  r("agent post create", "card", "card", "agent", { via: "candle_create_post", note: "Use candle_create_post: a one-press card, public." }),
  r("agent post delete", "card", "card", "agent", { via: "candle_delete_post", note: "Use candle_delete_post with the post's id: a one-press card." }),
  r("keys list", "read", "cli", "owner"),
  // Sets or clears a key's Candle cap over the device token (0.13.5). Raising or clearing it widens
  // what the key may spend, and the Candle Harness can't read the cap it replaces, so it's always the owner's.
  r("keys limit", "owner", "pane", "owner"),
  // A key the agent creates: `--json` on a piped stdout, straight into the Candle Harness's key store. Never with
  // `--embedded-wallet allow`, which needs a terminal for its own confirm (a second owner step).
  r("keys create", "owner", "pane", "owner", { pane: { capture: "new-key" } }),
  r("keys access", "owner", "pane", "owner", {
    // `--history` reads. `--access read` is always a narrowing; anything else can widen: owner.
    byFlags: (flags) => (flags.has("--history") ? { rule: "read", route: "cli" } : flags.get("--access") === "read" ? { rule: "less-access", route: "cli" } : undefined),
    partly: "--access read (narrows) and --history (reads): now",
    pane: { confirms: ["to widen it, you'll type the key's prefix"] },
    takes: 1,
  }),
  r("keys update", "owner", "pane", "owner", {
    byFlags: (flags) => (flags.get("--embedded-wallet") === "deny" ? { rule: "less-access", route: "cli" } : undefined),
    partly: "--embedded-wallet deny (narrows): now",
    pane: { confirms: ["you'll type the key's prefix"] },
    takes: 1,
  }),
  // A group word: the bare word prints its usage, and its one subcommand narrows.
  r("keys self", "less-access", "cli", "agent", { note: "On its own it prints its usage." }),
  r("keys self embedded-wallet", "less-access", "cli", "agent", { note: "Only `deny`: a key can never allow itself.", takes: 1 }),
  r("keys revoke", "less-access", "cli", "owner"),
  // A key's per-asset caps (0.13.18), set with the profile's own API key: Candle takes only a lower cap
  // or a first one (raising or removing one is LOOSEN_REQUIRES_SESSION, the owner's in the web key
  // manager), so it only narrows.
  r("keys limits", "less-access", "cli", "agent", { note: "It can only lower a key's per-asset caps or add one: Candle refuses raising or removing one, which is yours in Candle's web key manager." }),
  // Pausing one key on Candle over the device token (0.13.18): everything it does stops, sells
  // included, until keys resume. Stopping only narrows; resuming widens, so it's the owner's.
  r("keys stop", "less-access", "cli", "owner", { note: "Candle stops everything the key does, sells and its bots' exits included, until candle keys resume.", takes: 1 }),
  r("keys resume", "owner", "pane", "owner", { takes: 1 }),
  // A new secret for an existing key (0.13.18). The CLI replaces only its own profile's copy; the Candle Harness
  // holds each agent's key itself, and its copy stops working when the grace window ends.
  r("keys rotate", "owner", "later", "owner", {
    held: "Rotating gives the key a new secret, and the Candle Harness holds its own copy of each agent's key, which stops working when the old secret does. The Candle Harness doesn't store a rotated secret yet: for an agent's key, make a fresh one with candle keys create and revoke the old one once the agent runs on it.",
  }),
  r("keys wallets", "read", "cli", "agent"),
  r("keys wallets set", "less-access", "cli", "agent", { note: "From a key it can only narrow the set." }),
  // From a key the CLI refuses a widening (LOOSEN_REQUIRES_SESSION), so only the narrowing is the agent's.
  r("keys wallets scope", "never", "later", "agent", {
    byFlags: (flags) => (flags.get("--scope") === "selected" ? { rule: "less-access", route: "cli" } : undefined),
    partly: "--scope selected (narrows): now",
    note: "Widening a key to every wallet is refused from a key: widen it in Candle's agent console. Narrowing it to selected wallets runs now.",
    takes: 1,
  }),
  r("keys signer", "owner", "pane", "owner"),
  r("keys signer approve", "owner", "pane", "owner", { pane: { confirms: ["you'll type the signer's full fingerprint"] } }),
  r("keys signer move", "owner", "pane", "owner", { pane: { confirms: ["onto a signer that isn't pinned yet, you'll type its fingerprint"] } }),
  r("wallets", "read", "cli", "agent"),
  r("wallets import", "ceremony", "pane", "agent", { pane: { confirms: ["you'll type the private key, hidden"], shows: "You'll paste a private key into the CLI's hidden prompt.", positionals: 0 } }),
  r("wallets revoke", "less-access", "cli", "agent"),
  r("wallets trust", "owner", "pane", "owner", { pane: { confirms: [CONFIRM] } }),
  r("wallets untrust", "less-access", "cli", "owner"),
  r("wallets allow-launch", "owner", "pane", "owner", { pane: { confirms: [CONFIRM] } }),
  r("wallets disallow-launch", "less-access", "cli", "owner"),
  // The account's withdrawal allowlist (0.13.18): a read, which says approving an address is the owner's, in Candle's agent console.
  r("wallets allowlist", "read", "cli", "agent"),
  // Opens the Agents console's grant-only page in the browser and waits until every embedded wallet
  // carries Candle's signer (0.13.18). The grant happens in the browser, as the member, so no factor step.
  r("wallets authorize", "ceremony", "pane", "agent", {
    pane: {
      confirms: ["it opens Candle's agent console in your browser, where you approve the grant"],
      shows: "Lets agent keys use your account's embedded wallets, approved in your browser.",
    },
  }),
  // From a TEE wallet. Candle keeps it off on a deployment until AGENT_TEE_CLOSE_EMPTY_ENABLED; on Candle's
  // production server it closed four accounts through it and read the close back under its id, so it's on. The Wallets pane's `close` chip and the typed line follow the row.
  r("wallets close-empty", "card", "card", "agent", {
    partly: "from a TEE wallet; the embedded wallet's needs transfer:write, which an agent key doesn't have",
    card: {
      kind: "close",
      idFlag: "--client-trade-id",
      readBack: "rerun",
      stops: false,
      wallet: "either",
      embeddedHeld: "From the embedded wallet it needs transfer:write, which an agent key doesn't have.",
    },
  }),
  // Token pages, x402 and Quant (0.13.5). Forensics and the vamp finder may pay per use from a vault
  // key past the free rate (commands/token-paid.ts); Candle's MCP tools answer them without paying.
  mcp("token forensics", "candle_token_forensics"),
  mcp("token vamp-candidates", "candle_vamp_candidates"),
  mcp("token events", "candle_token_events"),
  // Public reads; about --capabilities reads the key's own eligibility. history without a section is
  // the token's metadata edits (0.13.9), with one a section's versions.
  r("token clusters", "read", "cli", "agent"),
  r("token about", "read", "cli", "agent"),
  r("token history", "read", "cli", "agent"),
  r("token comments", "read", "cli", "agent"),
  // The creator's edit of a token's description and links (0.13.9), under launch:write, which Write holds.
  r("token edit", "card", "card", "agent", {
    via: "candle_token_edit",
    note: "Use candle_token_edit: a one-press card, public. Only the account that launched the token may edit it, and only its description and links.",
  }),
  // Public writes on a token's page as the key's account, under token-pages:write.
  r("token claim", "card", "later", "agent", { held: TOKEN_PAGES_HELD }),
  r("token section", "card", "later", "agent", { held: TOKEN_PAGES_HELD }),
  r("token flag", "card", "later", "agent", { held: TOKEN_PAGES_HELD }),
  r("token update", "card", "later", "agent", { held: TOKEN_PAGES_HELD }),
  r("token comment", "card", "later", "agent", { held: TOKEN_PAGES_HELD }),
  r("token post", "card", "later", "agent", { held: TOKEN_PAGES_HELD }),
  r("token post delete", "card", "later", "agent", { held: TOKEN_PAGES_HELD }),
  never("spend", SPEND_NOTE, "agent"),
  never("spend limit", SPEND_NOTE),
  never("spend max-per-call", SPEND_NOTE),
  never("spend pause", SPEND_NOTE),
  never("spend resume", SPEND_NOTE),
  // One question to Candle's Quant over the agent's key (0.13.18). It never pays: past the day's free
  // answers it prints the price and stops.
  r("quant ask", "read", "cli", "agent", { note: "It sends the question to Candle's Quant and prints the answer. It never pays: past today's free answers it says the price and stops." }),
  // Accepting Quant's terms is the person's own act, typed at the CLI's prompt (commands/quant-terms.ts).
  r("quant terms", "ceremony", "pane", "agent", {
    pane: { confirms: ["you'll type accept"], shows: "Accepts Quant's terms for your account (docs.candle.tv/terms)." },
  }),
  r("profile list", "read", "cli", "owner"),
  // Offline config, with no prompt: an owner step, since `profile use` changes who every later candle runs as.
  r("profile add", "owner", "pane", "owner"),
  r("profile use", "owner", "pane", "owner"),
  r("profile rename", "owner", "pane", "owner"),
  r("profile remove", "owner", "pane", "owner", { pane: { addsYes: true }, note: "It deletes the profile's local credentials and never asks, so the card is its only gate." }),
  r("profile set", "owner", "pane", "owner"),
  // A device code and the browser: nothing the browser doesn't grant, so no factor step.
  r("auth login", "ceremony", "pane", "owner"),
  r("auth logout", "owner", "pane", "owner", { note: "It revokes the profile's key on Candle and deletes the profile, and never asks, so the card is its only gate." }),
  r("auth status", "read", "cli", "owner"),
  // Custody, on this machine
  r("vault init", "ceremony", "pane", "owner", {
    pane: { confirms: ["you'll be shown a new passphrase to write down, or choose your own"], shows: "Makes a vault on this machine. It may show your new passphrase and your 24 words.", reveals: "your new passphrase or your 24 words" },
  }),
  r("vault status", "read", "cli", "owner", {
    byFlags: (flags) => (flags.has("--unlock") ? { rule: "ceremony", route: "pane" } : undefined),
    partly: "--unlock (in the terminal): now",
    pane: { capture: "code" },
  }),
  r("vault list", "owner", "pane", "owner", { pane: { capture: "addresses" } }),
  r("vault new-key", "owner", "pane", "owner"),
  r("vault rename", "owner", "pane", "owner"),
  // Exit 1 can mean it stopped before showing, or showed and the read-back failed.
  r("vault phrase", "ceremony", "pane", "owner", { pane: { confirms: ["you'll type understood, then three of the 24 words back"], shows: "Shows your 24 words.", reveals: "your 24 words" } }),
  // An agent key scoped `selected` may not see every linked wallet, so the restore would end at exit 3.
  r("vault restore", "ceremony", "pane", "owner", {
    pane: {
      confirms: ["you'll type the 24 words, hidden, then confirm the account"],
      shows: "You'll type your 24 words. It may show a new passphrase.",
      reveals: "a new passphrase",
      // Exit 3 when its read of the account's linked wallets was incomplete (commands/vault-restore.ts).
      exit3: "restored, but not confirmed (exit 3): the CLI couldn't read every linked wallet. Check with candle vault status before anything else.",
    },
  }),
  r("vault reconcile-exposure", "owner", "pane", "owner"),
  r("vault factor", "ceremony", "pane", "owner"),
  r("vault factor list", "read", "cli", "owner"),
  r("vault factor add", "ceremony", "pane", "owner", { pane: { shows: ADDS_FACTOR, reveals: "a new passphrase" } }),
  r("vault factor remove", "owner", "pane", "owner"),
  r("vault enroll", "ceremony", "pane", "owner", { pane: { shows: ADDS_FACTOR, reveals: "a new passphrase" } }),
  r("vault backup", "owner", "pane", "owner", { pane: { askPaths: [{ flag: "--to", prompt: "Where to write the backup: a new file's path, or icloud" }] } }),
  r("vault verify-backup", "owner", "pane", "owner", { pane: { askPaths: [{ flag: "<path>", prompt: "The backup file to check" }] } }),
  r("vault import-legacy", "owner", "pane", "owner"),
  r("vault retire-legacy", "owner", "pane", "owner"),
  // Funds out: the owner's own vault-signed routes. Each asks for the
  // factor itself, prints where it goes and takes a typed confirm; the Candle Harness's destination checks
  // (destinations.ts) sit in front, since `vault transfer` checks no list of its own.
  r("vault transfer", "funds-out", "pane", "owner", {
    pane: {
      confirms: SEND_CONFIRMS,
      // --from names a vault key's or a promoted TEE wallet's label, not a path.
      lifts: ["--from"],
      exit3: "sent, but not finalized yet (exit 3): it may still land. Check the signature on an explorer before sending again.",
    },
  }),
  r("vault promote", "owner", "pane", "owner", { pane: { confirms: [CONFIRM], lifts: ["--from"] } }),
  r("vault promote-batch", "owner", "pane", "owner", { pane: { askPaths: [{ flag: "--pairs-from", prompt: "The file of labels and where each sweeps to" }], confirms: [CONFIRM] } }),
  r("vault fund", "owner", "pane", "owner", { pane: { confirms: [CONFIRM], lifts: ["--from"] } }),
  r("vault demote", "owner", "pane", "owner", { pane: { confirms: [CONFIRM] } }),
  r("vault export-key", "ceremony", "pane", "owner", {
    pane: { askPaths: [{ flag: "--to", prompt: "A new file to write the key to" }], confirms: [CONFIRM], shows: "Writes the key, unencrypted, to a new file you name in the pane." },
  }),
  // No factor step: it asks for its own store's passphrase. At 0.13.5 it only
  // adds to an older TEE wallet store already on the machine, and with none refuses (TEE_STORE_ABSENT).
  r("tee new", "owner", "pane", "owner", {
    note: "Only with the older TEE wallet store on this machine. A new TEE wallet comes from the vault: candle vault new-key --chain solana, then candle vault promote.",
    pane: { factorFirst: false, confirms: ["you'll type the older TEE wallet store's passphrase"] },
  }),
  // It binds the wallet to the key it runs with.
  // Only a wallet from the older store that was never enabled: the CLI refuses one whose key is in the
  // vault, and never re-enables one (commands/tee.ts, "A retired or enabled TEE wallet is never re-enabled").
  r("tee enable", "owner", "pane", "agent", { note: "Only a TEE wallet from the older store, never enabled: a stopped wallet is never re-enabled.", pane: { confirms: [CONFIRM] } }),
  r("tee fund", "read", "cli", "owner", { note: "It prints the funding instruction; it signs nothing.", pane: { needsPrompt: VAULT_PROMPT } }),
  r("tee status", "read", "cli", "agent", {
    byFlags: (flags) => (flags.has("--verify") ? { rule: "owner", route: "pane" } : undefined),
    partly: "--verify (an owner step, in the prompt pane): now",
    pane: {},
  }),
  // Whether each named TEE wallet can really trade, read without spending (0.13.19). --sign builds a tiny quote, has the
  // relay sign it and simulates it, and never broadcasts.
  r("tee check", "read", "cli", "agent", { note: "It spends nothing: --sign signs and simulates a tiny quote and never sends it." }),
  r("tee disable", "less-access", "cli", "agent", {
    note: "A stop for good: exit 3 while Candle hasn't confirmed it's enforced. Then sweep it home.",
    pane: { needsPrompt: VAULT_PROMPT, exit3: "the stop is asked for, but Candle hasn't confirmed it's enforced yet (exit 3). Check with candle tee status before trading from this wallet." },
  }),
  // Signed from this machine's vault, to the wallet's pinned vault only; the profile's own key reads the
  // wallet's state on Candle, so it runs as the owner.
  r("tee sweep", "funds-out", "pane", "owner", {
    pane: {
      confirms: SWEEP_CONFIRMS,
      exit3: "not complete (exit 3): part of it may still land. Run the same candle tee sweep again to reconcile: it keeps what it sent and never sends it twice.",
    },
  }),
  r("tee rebind", "owner", "pane", "owner", { pane: { confirms: [CONFIRM] } }),
  r("tee rebinds", "read", "cli", "owner"),
  // The factor first: the CLI unlocks only to rename a TEE wallet's vault entry, and the core drops the
  // step for a TEE wallet it knows when there's a vault, so the user is asked once.
  r("tee rename", "owner", "pane", "owner", { pane: { factorFirst: true } }),
  r("tee signer", "owner", "pane", "agent"),
  // It waits, polling, until the owner runs keys signer approve: panes stack.
  r("tee signer new", "owner", "pane", "agent"),
  // Removes this machine's signer once it owns no wallets, and tells Candle (0.13.9).
  r("tee signer remove", "owner", "pane", "agent"),
  // The signer's state on Candle, read once (0.13.11): no pair made, no approval asked.
  r("tee signer status", "read", "cli", "agent"),
  r("external new", "owner", "pane", "owner"),
  r("external list", "owner", "pane", "owner", { note: "It unlocks the vault, so it needs the CLI's passphrase prompt." }),
  r("external sweep", "funds-out", "pane", "owner", {
    pane: {
      confirms: SWEEP_CONFIRMS,
      // --to names a vault key in this vault, which the CLI checks, not a path.
      lifts: ["--to"],
      exit3: "not complete (exit 3): some was left behind, and a send may still land. Check the signatures on an explorer before running it again.",
    },
  }),
  r("sign", "ceremony", "pane", "owner", { pane: { askPaths: [{ flag: "--file", prompt: "The transaction file to sign" }] } }),
  r("sign message", "ceremony", "pane", "owner", { pane: { askPaths: [{ flag: "--file", prompt: "The message file to sign" }] } }),
  // Your own services, and maintenance
  // The secret goes into a hidden prompt only: a second positional is exit 2 (commands/secrets.ts:51), and would be in the journal.
  r("secrets set", "ceremony", "pane", "owner", { pane: { confirms: ["you'll type the secret, hidden"], shows: "You'll type the secret into the CLI's hidden prompt. It never goes to Candle.", positionals: 1 } }),
  r("secrets list", "read", "cli", "owner"),
  r("secrets remove", "less-access", "cli", "owner"),
  r("plugins", "read", "cli", "owner"),
  r("doctor", "read", "cli", "owner"),
  r("setup", "ceremony", "pane", "owner"),
  r("verify", "ceremony", "pane", "owner", {
    note: "It takes a file path, which the agent may never give.",
    pane: {
      askPaths: [
        { flag: "<file>", prompt: "The file to check" },
        { flag: "--bundle", prompt: "Its signature bundle" },
      ],
    },
  }),
  // It replaces the running candle; exit 0 doesn't mean it updated (`updated` under --json says).
  r("update", "ceremony", "pane", "owner"),
  r("help", "read", "cli", "owner"),
  never("mcp", "The core runs Candle's MCP server itself.", "agent"),
  never("core serve", "The Candle Harness runs its own core: candle-harness core."),
  never("core mcp", "The Candle Harness has its own MCP server for agents: candle-harness mcp."),
  never("tui", "This is the Candle Harness."),
  // Staging only (0.13.9): Candle's own tool for test members, from its team's keychain items.
  never("completion", "Shell setup, not a Candle Harness feature."),
  never("completion zsh", "Shell setup, not a Candle Harness feature."),
  never("completion bash", "Shell setup, not a Candle Harness feature."),
  never("completion fish", "Shell setup, not a Candle Harness feature."),
]

/** The command word the CLI routes for `word`: an alias (`wallet`) resolved, anything else as it is. */
export function canonicalCommand(word: string): string {
  return Object.hasOwn(SOURCE.aliases, word) ? SOURCE.aliases[word]! : word
}

/** The source's entry for a command and subcommand (null for a bare command). */
export function sourceFor(command: string, subcommand: string | null): SourceEntry | undefined {
  return SOURCE.commands.find((c) => c.command === command && c.subcommand === subcommand)
}

/** What the source read of a row's own handler says it unlocks: a dispatched word's (`vault factor remove`) where it has one. */
export function unlocksFor(path: string): Unlocks | undefined {
  const [command, sub, word] = path.split(" ")
  const entry = (sub !== undefined ? sourceFor(command!, sub) : undefined) ?? sourceFor(command!, null)
  if (!entry) return undefined
  const action = entry.subcommand === null ? sub : word
  return (action !== undefined ? entry.actions?.[action]?.unlocks : undefined) ?? entry.unlocks
}

/**
 * Whether a row needs a vault whatever its factor step (a vault is optional): the CLI unlocks the vault to
 * run it, or (`tee rename`) renames the vault's entry. With no vault it keeps its card, `vault init`
 * offered in place of approve. Not `vault init` or `vault status`; `vault restore` makes one and never unlocks.
 */
export function needsVault(row: CliRow): boolean {
  if (row.path === "tee rename") return true
  return unlocksFor(row.path) === "always" && row.path !== "vault init" && row.path !== "vault status"
}

/**
 * Every row that runs in the prompt pane gets its spec. The factor step comes first for an owner row
 * the CLI runs without unlocking the vault, and never twice.
 */
function withPane(row: RowInput): CliRow {
  const runsInPane = (PANE_RULES.has(row.rule) && row.route === "pane") || row.pane !== undefined
  if (!runsInPane) return row as CliRow
  const factorFirst = row.pane?.factorFirst ?? (row.rule === "owner" && unlocksFor(row.path) === "never")
  return { ...row, pane: { ...row.pane, factorFirst, confirms: row.pane?.confirms ?? [] } }
}

export const CLI_ROWS: readonly CliRow[] = ROWS.map(withPane)

const BY_PATH = new Map(CLI_ROWS.map((row) => [row.path, row]))

export function rowFor(path: string): CliRow | undefined {
  return BY_PATH.get(path)
}

/**
 * Whether a resolved call runs in the prompt pane: an owner, ceremony or funds-out step, or a row
 * whose command asks at the CLI's own prompt whatever its rule (`tee disable`).
 */
export function runsInPane(row: CliRow, rule: CliRule): boolean {
  return row.pane !== undefined && (PANE_RULES.has(rule) || row.pane.needsPrompt !== undefined)
}

/**
 * The flags a command takes more than once, by the CLI's own reading of each (wallets-close-empty.ts,
 * sign.ts, tee-evm.ts). Every other flag the CLI reads once, keeping the last.
 */
const REPEATS: Record<string, readonly string[]> = {
  "wallets close-empty": ["--keep"],
  sign: ["--wallet"],
  "tee sweep": ["--token"],
  "vault demote": ["--token"],
}

/** Whether a row's command takes this flag more than once. */
export const repeats = (path: string, flag: string): boolean => REPEATS[path]?.includes(flag) ?? false

/** Flags never taken from the agent: they change who or where a command runs, or what it reads or writes on disk. */
export const FORBIDDEN_FLAGS = new Set([
  "--profile",
  "--api-url",
  "--no-verify-account",
  "--factor",
  "--device",
  "--yes",
  "--json",
  "--rpc-url",
  "--evm-rpc-url",
  "--install-helper",
  "--on-warn",
  "--on-critical",
  "-k",
  "--keystore",
  "--key-file",
  "--signer-out",
  "--labels-from",
  "--pairs-from",
  "--file",
  "--from",
  "--to",
  "--out",
  "--bundle",
])

/**
 * The flags a row takes from the agent: what the command's source declares (for an action word with
 * a table of its own, that action's), less the forbidden (but those the row lifts) and the path flags.
 */
export function allowedFlags(entry: SourceEntry, action?: string, lifts: readonly string[] = []): { value: Set<string>; boolean: Set<string> } {
  const ok = (f: string) => (!FORBIDDEN_FLAGS.has(f) || lifts.includes(f)) && !f.startsWith("--accept-") && !(entry.flags?.path ?? []).includes(f) && f.startsWith("-")
  const values = action !== undefined && entry.flags?.byAction?.[action] !== undefined ? entry.flags.byAction[action]! : (entry.flags?.value ?? [])
  return { value: new Set(values.filter(ok)), boolean: new Set((entry.flags?.boolean ?? []).filter(ok)) }
}

/** Whether closing a TEE wallet's empty token accounts is switched on (only once checked live): the Wallets pane offers `close` only then. */
export const closeEmptyOn = (): boolean => rowFor("wallets close-empty")?.card?.held === undefined

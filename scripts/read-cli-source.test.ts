// The source read: each way the CLI's handlers build a parseArgs spec, read from a
// small made-up CLI source in a temporary folder, and the committed data read with nothing left unread.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SOURCE } from "../src/core/cli-table"
import { readCliSource } from "./read-cli-source"

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

/** The smallest presets file the reader reads with nothing unread. */
const ONE_PRESET = `const READ_SCOPES = ["account:read"]
export function scopesForPreset(preset) {
  switch (preset) {
    case "read":
      return [...READ_SCOPES]
  }
}
export const AGENT_KEY_PRESET_LABELS = {
  read: "Read",
}`

/** A made-up CLI source: index.ts's dispatch table, help.ts, one file per handler, and other files under src (a presets file by default). */
function cliSource(handlers: Record<string, string>, other: Record<string, string> = { "agent-key-access.ts": ONE_PRESET }): string {
  const root = mkdtempSync(join(tmpdir(), "chrn-cli-src-"))
  dirs.push(root)
  const src = join(root, "src")
  mkdirSync(join(src, "commands"), { recursive: true })
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "9.9.9" }))
  const names = Object.keys(handlers)
  writeFileSync(
    join(src, "index.ts"),
    [
      ...names.map((n) => `import { ${n} } from "./commands/${n}"`),
      "const COMMANDS: Record<string, CommandRoute> = {",
      ...names.map((n) => `  ${n.toLowerCase()}: { bare: ${n} },`),
      "}",
    ].join("\n"),
  )
  writeFileSync(join(src, "help.ts"), 'export const GROUPS = ["Trade"]\nexport const HELP: Record<string, Topic> = {\n}\n')
  for (const [name, body] of Object.entries(handlers)) writeFileSync(join(src, "commands", `${name}.ts`), body)
  for (const [path, body] of Object.entries(other)) {
    mkdirSync(join(src, path, ".."), { recursive: true })
    writeFileSync(join(src, path), body)
  }
  return src
}

const flagsOf = (src: string, command: string) => {
  const out = readCliSource(src, "abc123")
  return { flags: out.commands.find((c) => c.command === command)?.flags as Record<string, unknown>, unread: out.unread }
}

describe("reading a handler's flags", () => {
  test("a plain spec, and a stray string in a conditional spread that isn't a flag", () => {
    const src = cliSource({
      stake: `export async function stake(args: string[], ctx: Ctx): Promise<number> {
  const parsed = parseArgs(args, {
    valueFlags: ["--wallet", "--client-stake-id"],
    booleanFlags: ["--yes", ...(action === "claim" ? ["--all"] : [])],
  })
  return tradingKey(ctx) && ctx.json
}`,
    })
    expect(flagsOf(src, "stake")).toEqual({ flags: { value: ["--client-stake-id", "--wallet"], boolean: ["--all", "--yes"], path: [], pathPositionals: [] }, unread: [] })
  })

  test("close-empty: a lifted flag and a parse of the rest, in a helper with an object return type", () => {
    const src = cliSource({
      Close: `export function splitKeep(args: string[]): { rest: string[]; keep: string[] } | { error: string } {
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--keep") continue
  }
  return { rest: [], keep: [] }
}
export async function Close(args: string[], ctx: Ctx): Promise<number> {
  const lifted = splitKeep(args)
  const parsed = parseArgs(lifted.rest, { valueFlags: ["--wallet", "--client-trade-id"], booleanFlags: ["--yes"] })
  return 0
}`,
    })
    expect(flagsOf(src, "close").flags).toMatchObject({ value: ["--client-trade-id", "--keep", "--wallet"], boolean: ["--yes"] })
  })

  test("a flag handed to a helper with the arguments is lifted too", () => {
    const src = cliSource({
      Sign: `export async function Sign(args: string[], ctx: Ctx): Promise<number> {
  const lifted = takeRepeatedFlag(args, "--wallet")
  const parsed = parseArgs(lifted.rest, { valueFlags: ["--file"], pathFlags: ["--file"] })
  return 0
}`,
    })
    expect(flagsOf(src, "sign").flags).toMatchObject({ value: ["--file", "--wallet"], path: ["--file"] })
  })

  test("agent post: an action table, kept per action", () => {
    const src = cliSource({
      Post: `const ACTION_FLAGS = {
  create: ["--text", "--chain", "--mint"],
  delete: [],
  list: ["--limit", "--cursor"],
} as const
export async function Post(args: string[], ctx: Ctx): Promise<number> {
  const action = args[0] as Action | undefined
  const parsed = parseArgs(args.slice(1), { valueFlags: [...ACTION_FLAGS[action]] })
  return 0
}`,
    })
    const { flags } = flagsOf(src, "post")
    expect(flags.value).toEqual(["--chain", "--cursor", "--limit", "--mint", "--text"])
    expect(flags.byAction).toEqual({ create: ["--text", "--chain", "--mint"], delete: [], list: ["--limit", "--cursor"] })
  })

  test("agent profile: Object.keys of a flag table, and a spread of one", () => {
    const src = cliSource({
      Profile: `const FLAGS = {
  "--bio": "publicThesis",
  "--links": "publicLinks",
} as const
const SET_FLAGS: Record<string, Spec> = {
  "--warn-distance": { field: "warnDistanceBps", kind: "pct" },
}
export async function Profile(args: string[], ctx: Ctx): Promise<number> {
  const parsed = parseArgs(args.slice(1), { valueFlags: Object.keys(FLAGS) })
  const other = parseArgs(args, { valueFlags: ["--key", ...(verb === "set" ? Object.keys(SET_FLAGS) : [])] })
  return 0
}`,
    })
    expect(flagsOf(src, "profile").flags.value).toEqual(["--bio", "--key", "--links", "--warn-distance"])
  })

  test("a spec named by a const, and a conditional between two specs, read as both", () => {
    const src = cliSource({
      Trust: `const WRITE_FLAGS = { valueFlags: ["--label"], booleanFlags: ["--force"] }
export async function Trust(args: string[], ctx: Ctx): Promise<number> {
  const a = parseArgs(args, WRITE_FLAGS)
  const b = parseArgs(args, trusted ? {} : { booleanFlags: ["--yes"] })
  return 0
}`,
    })
    expect(flagsOf(src, "trust").flags).toMatchObject({ value: ["--label"], boolean: ["--force", "--yes"] })
  })

  test("launch (0.13.5): flags spread from a definition in another file, filtered and mapped, and an imported flag", () => {
    const src = cliSource(
      {
        Launch: `import { LAUNCH_IMAGE_FLAG, launchFlagFields } from "../launch-options"
export const LAUNCH_ARG_SPEC: ArgSpec = {
  valueFlags: [
    ...launchFlagFields.filter((field) => field.type !== "boolean").map((field) => field.cli.flag),
    LAUNCH_IMAGE_FLAG,
    "--rpc-url",
  ],
  booleanFlags: [
    ...launchFlagFields.filter((field) => field.type === "boolean").map((field) => field.cli.flag),
    "--yes",
  ],
  pathFlags: ["--image"],
}
export async function Launch(args: string[], ctx: Ctx): Promise<number> {
  const parsed = parseArgs(args, LAUNCH_ARG_SPEC)
  return 0
}`,
      },
      {
        "agent-key-access.ts": ONE_PRESET,
        "launch-definition.ts": `// Generated. Do not edit.
export const LAUNCH_DEFINITION = {
  "fields": [
    { "key": "name", "type": "string", "surfaces": { "cli": { "flag": "--name", "value": "<name>" }, "mcp": { "key": "name" } } },
    { "key": "dryRun", "type": "boolean", "surfaces": { "cli": { "flag": "--dry-run" } } },
    { "key": "internal", "type": "string", "surfaces": { "cli": {} } }
  ]
} as const
`,
        "launch-options.ts": `import { LAUNCH_DEFINITION } from "./launch-definition"
export const LAUNCH_IMAGE_FLAG = "--image"
export const launchFlagFields = LAUNCH_DEFINITION.fields.flatMap((field) =>
  "flag" in field.surfaces.cli ? [{ ...field, cli: field.surfaces.cli }] : [],
)
`,
      },
    )
    expect(flagsOf(src, "launch")).toEqual({
      flags: { value: ["--image", "--name", "--rpc-url"], boolean: ["--dry-run", "--yes"], path: ["--image"], pathPositionals: [] },
      unread: [],
    })
  })

  test("token section (0.13.5): a local row of an action table, and a spread of a conditional spec after it", () => {
    const src = cliSource({
      Section: `const SECTION_FLAGS = {
  set: { valueFlags: ["--chain", "--file"], booleanFlags: ["--clear"] },
  restore: { valueFlags: ["--chain", "--version-id"], booleanFlags: [] },
} as const
export async function Section(args: string[], ctx: Ctx): Promise<number> {
  const action = args[0]
  const spec = SECTION_FLAGS[action]
  const parsed = parseArgs(args.slice(1), {
    valueFlags: [...spec.valueFlags],
    booleanFlags: [...spec.booleanFlags],
    ...(action === "set" ? { pathFlags: ["--file"] } : {}),
  })
  return 0
}`,
    })
    expect(flagsOf(src, "section")).toEqual({
      flags: {
        value: ["--chain", "--file", "--version-id"],
        boolean: ["--clear"],
        path: ["--file"],
        pathPositionals: [],
        byAction: { set: ["--chain", "--file"], restore: ["--chain", "--version-id"] },
      },
      unread: [],
    })
  })

  test("token edit (0.13.9): a definition filtered by || and startsWith, three files deep", () => {
    const src = cliSource(
      {
        Edit: `import { EDIT_FIELDS } from "../edit-fields"
export async function Edit(args: string[], ctx: Ctx): Promise<number> {
  const parsed = parseArgs(args, { valueFlags: ["--chain", ...EDIT_FIELDS.map((field) => field.cli.flag)] })
  return 0
}`,
      },
      {
        "agent-key-access.ts": ONE_PRESET,
        "launch-definition.ts": `export const LAUNCH_DEFINITION = {
  "fields": [
    { "key": "name", "surfaces": { "cli": { "flag": "--name" } } },
    { "key": "description", "surfaces": { "cli": { "flag": "--description" } } },
    { "key": "socials.twitter", "surfaces": { "cli": { "flag": "--x" } } }
  ]
} as const
`,
        "launch-options.ts": `import { LAUNCH_DEFINITION } from "./launch-definition"
export const launchFlagFields = LAUNCH_DEFINITION.fields.flatMap((field) =>
  "flag" in field.surfaces.cli ? [{ ...field, cli: field.surfaces.cli }] : [],
)
`,
        "edit-fields.ts": `import { launchFlagFields } from "./launch-options"
export const EDIT_FIELDS = launchFlagFields.filter(
  (field) => field.key === "description" || field.key.startsWith("socials."),
)
`,
      },
    )
    expect(flagsOf(src, "edit")).toEqual({ flags: { value: ["--chain", "--description", "--x"], boolean: [], path: [], pathPositionals: [] }, unread: [] })
  })

  test("lab runners (0.13.9): a local list chosen by a parameter the handler binds to a literal", () => {
    const src = cliSource({
      Runners: `async function report(args: string[], ctx: Ctx, kind: "runners" | "edges"): Promise<number> {
  const flags = kind === "runners" ? ["--hours", "--min-wallets"] : ["--days", "--min-n"]
  const parsed = parseArgs(args, { valueFlags: flags })
  return 0
}
export const Runners = (args: string[], ctx: Ctx) => report(args, ctx, "runners")`,
    })
    expect(flagsOf(src, "runners")).toEqual({ flags: { value: ["--hours", "--min-wallets"], boolean: [], path: [], pathPositionals: [] }, unread: [] })
  })

  test("a parameter two calls bind differently is unbound, so the list it picks is unread", () => {
    const src = cliSource({
      Both: `async function report(args: string[], ctx: Ctx, kind: "runners" | "edges"): Promise<number> {
  const flags = kind === "runners" ? ["--hours"] : ["--days"]
  const parsed = parseArgs(args, { valueFlags: flags })
  return 0
}
export async function Both(args: string[], ctx: Ctx): Promise<number> {
  return args[0] ? report(args, ctx, "runners") : report(args, ctx, "edges")
}`,
    })
    const { flags, unread } = flagsOf(src, "both")
    expect(flags).toBeNull()
    expect(unread[0]).toStartWith("Both: a flag list named flags the reader can't follow")
  })

  test("a spread or a named list the reader can't follow is unread, never left as no flags", () => {
    const src = cliSource({
      Built: `export async function Built(args: string[], ctx: Ctx): Promise<number> {
  const parsed = parseArgs(args, { valueFlags: [...flagsFor(ctx), "--chain"] })
  return 0
}`,
      Local: `export async function Local(args: string[], ctx: Ctx): Promise<number> {
  const extra = ctx.json ? ["--json"] : []
  const parsed = parseArgs(args, { valueFlags: ["--chain"], booleanFlags: extra })
  return 0
}`,
    })
    const out = readCliSource(src, "abc123")
    expect(out.commands.find((c) => c.command === "built")?.flags).toBeNull()
    expect(out.commands.find((c) => c.command === "local")?.flags).toBeNull()
    expect(out.unread).toHaveLength(2)
    expect(out.unread[0]).toStartWith("Built: a spread the reader can't follow: ...flagsFor(ctx)")
    expect(out.unread[1]).toStartWith("Local: a flag list named extra the reader can't follow")
  })

  test("a parseArgs call the reader can't read is listed as unread, never left as no flags", () => {
    const src = cliSource({
      Odd: `export async function Odd(args: string[], ctx: Ctx): Promise<number> {
  const parsed = parseArgs(args, specFor(ctx))
  return 0
}`,
    })
    const { flags, unread } = flagsOf(src, "odd")
    expect(flags).toBeNull()
    expect(unread).toEqual(["Odd: a spec the reader can't read: specFor(ctx)"])
  })
})

// The vault and terminal facts, read by following calls into other files.
const VAULT_SUPPORT = `export async function unlockInteractively(ctx: Ctx, path: string, raw: string): Promise<Opened> {
  return chooseFactor(ctx)
}
export function requireTty(ctx: Ctx, what: string): boolean {
  return ctx.deps.isTTY.stdin && ctx.deps.isTTY.stdout
}
export function requirePromptStreams(ctx: Ctx, what: string): boolean {
  return ctx.deps.isTTY.stdin && ctx.deps.isTTY.stderr
}
export function missingVault(ctx: Ctx): Error {
  return new Error("VAULT_MISSING")
}`
const TEE_LOOKUP = `import { unlockInteractively } from "../commands/vault-support"
export async function findTeeInVault(ctx: Ctx, address: string): Promise<Hit> {
  const raw = await readVaultRaw(path)
  if (raw === null) return { hit: false }
  return { hit: true, vault: await unlockInteractively(ctx, path, raw) }
}`
const vaultFacts = (src: string) => {
  const out = readCliSource(src, "abc123")
  return Object.fromEntries(out.commands.map((c) => [c.command, { unlocks: c.unlocks, tty: c.tty, ...(c.actions ? { actions: c.actions } : {}) }]))
}

describe("reading whether a command unlocks the vault, and which streams it needs", () => {
  const src = cliSource(
    {
      Listing: `import { requirePromptStreams, unlockInteractively, missingVault } from "./vault-support"
export async function Listing(args: string[], ctx: Ctx): Promise<number> {
  if (!requirePromptStreams(ctx, "vault list")) return 1
  if (raw === null) throw missingVault(ctx)
  return open(ctx)
}
async function open(ctx: Ctx) {
  return unlockInteractively(ctx, p, raw)
}`,
      Enable: `export async function Enable(args: string[], ctx: Ctx): Promise<number> {
  if (!ctx.deps.isTTY.stdin) return 1
  return owned(ctx, args[0])
}
async function owned(ctx: Ctx, address: string) {
  const { findTeeInVault } = await import("../vault/tee-lookup")
  return findTeeInVault(ctx, address)
}`,
      Rename: `import { requireTty, unlockInteractively } from "./vault-support"
export async function Rename(args: string[], ctx: Ctx): Promise<number> {
  const raw = rows.some((row) => row.tee) ? await readVaultRaw(path) : null
  if (raw !== null && !requireTty(ctx, "tee rename")) return 1
  return raw === null ? 0 : unlockInteractively(ctx, path, raw)
}`,
      Create: `import { resolveDeviceToken } from "../deps"
export async function Create(args: string[], ctx: Ctx): Promise<number> {
  return resolveDeviceToken(ctx) && confirmAllow(ctx)
}
function confirmAllow(ctx: Ctx) {
  return ctx.deps.isTTY.stdin && ctx.deps.isTTY.stdout
}`,
      Factor: `import { factorList, factorRemove } from "./factor-words"
export async function Factor(args: string[], ctx: Ctx): Promise<number> {
  const [word, ...rest] = args
  switch (word) {
    case "list":
      return factorList(rest, ctx)
    case "remove":
      return factorRemove(rest, ctx)
  }
  return 2
}`,
    },
    {
      "commands/vault-support.ts": VAULT_SUPPORT,
      "vault/tee-lookup.ts": TEE_LOOKUP,
      "agent-key-access.ts": ONE_PRESET,
      "commands/factor-words.ts": `import { requireTty, unlockInteractively } from "./vault-support"
export async function factorList(args: string[], ctx: Ctx): Promise<number> {
  return 0
}
export async function factorRemove(args: string[], ctx: Ctx): Promise<number> {
  if (!requireTty(ctx, "vault factor remove")) return 1
  return unlockInteractively(ctx, p, raw)
}`,
    },
  )
  const facts = vaultFacts(src)

  test("an unlock two calls down in another file is always, with a vault required; prompt streams are stdin and stderr", () => {
    expect(facts.listing).toEqual({ unlocks: "always", tty: ["stdin", "stderr"] })
  })

  test("through the TEE lookup, by a dynamic import, it unlocks only if there's a vault", () => {
    expect(facts.enable).toEqual({ unlocks: "if-vault", tty: ["stdin"] })
  })

  test("only when a row it names is a TEE wallet and a vault exists", () => {
    expect(facts.rename).toEqual({ unlocks: "if-tee-and-vault", tty: ["stdin", "stdout"] })
  })

  test("nothing that unlocks: never, with any inline terminal check it makes", () => {
    expect(facts.create).toEqual({ unlocks: "never", tty: ["stdin", "stdout"] })
  })

  test("a dispatcher's words are read one by one", () => {
    expect(facts.factor!.actions).toEqual({ list: { unlocks: "never", tty: [] }, remove: { unlocks: "always", tty: ["stdin", "stdout"] } })
  })
})

describe("reading the access presets", () => {
  const ACCESS = `const READ_SCOPES: readonly AgentKeyScope[] = ["account:read"]
/** Write. */
const READWRITE_SCOPES: readonly AgentKeyScope[] = [
  "swap:write",
  // a comment with "quotes:in" it
  "account:read",
]
export function scopesForPreset(preset: AgentKeyPreset): AgentKeyScope[] {
  switch (preset) {
    case "read":
      return [...READ_SCOPES]
    case "readwrite":
      return [...READWRITE_SCOPES]
  }
}
export const AGENT_KEY_PRESET_LABELS = {
  read: "Read",
  readwrite: "Write",
} as const satisfies Record<AgentKeyPreset, string>`

  test("each preset's explicit list and its label, comments skipped", () => {
    const out = readCliSource(cliSource({}, { "agent-key-access.ts": ACCESS }), "abc123")
    expect(out.presets).toEqual({ read: { label: "Read", scopes: ["account:read"] }, readwrite: { label: "Write", scopes: ["swap:write", "account:read"] } })
    expect(out.unread).toEqual([])
  })

  test("a source with no presets file, or a preset that isn't an explicit list, is unread", () => {
    expect(readCliSource(cliSource({}, {}), "abc123").unread).toEqual(["agent-key-access.ts: not found, so the presets weren't read"])
    const spread = ACCESS.replace('const READ_SCOPES: readonly AgentKeyScope[] = ["account:read"]', "const READ_SCOPES = makeScopes()")
    expect(readCliSource(cliSource({}, { "agent-key-access.ts": spread }), "abc123").unread).toEqual(["agent-key-access.ts: preset read (READ_SCOPES) isn't an explicit list with a label"])
  })
})

describe("the committed read of the pinned CLI", () => {
  test("left nothing unread", () => {
    expect((SOURCE as unknown as { unread: string[] }).unread).toEqual([])
  })

  test("every flag it holds is a flag", () => {
    const stray = SOURCE.commands.flatMap((c) => [...(c.flags?.value ?? []), ...(c.flags?.boolean ?? []), ...(c.flags?.path ?? [])].filter((f) => !f.startsWith("-")).map((f) => `${c.command} ${c.subcommand}: ${f}`))
    expect(stray).toEqual([])
  })

  test("holds the flags the session-19 read missed", () => {
    const of = (command: string, subcommand: string) => SOURCE.commands.find((c) => c.command === command && c.subcommand === subcommand)!.flags!
    expect(of("wallets", "close-empty")).toMatchObject({ value: ["--client-trade-id", "--keep", "--wallet"], boolean: ["--yes"] })
    expect(of("agent", "profile").value).toContain("--bio")
    expect((of("agent", "post") as { byAction?: Record<string, string[]> }).byAction?.create).toEqual(["--text", "--chain", "--mint"])
  })
})

// Reads the Candle CLI's source as text, never importing or running it, and writes what candle_cli
// needs to know about every command: the dispatch table (`COMMANDS` in index.ts), each handler's
// flags as its own `parseArgs` spec declares them (value, boolean and path flags, path positionals),
// whether it takes `--json`, and its identity from what it calls: `resolveDeviceToken` or a vault
// unlock is the owner; `tradingKey` or `resolveApiKey` is an agent key. It also reads the CLI's help
// (help.ts): its groups, and each command word's summary and subcommand rows.
//
// A spec is read wherever the handler builds it: a literal, a const, a conditional between two, and
// inside its arrays spreads, `Object.keys(NAME)` and `NAME[action]` (an action table, kept per action
// as `byAction`). A flag the handler lifts out of its arguments before the parse (`args[i] !==
// "--keep"`, `takeRepeatedFlag(args, "--wallet")`) is a value flag, and repeatable. Every `parseArgs`
// call in a handler must be read: one that isn't is listed under `unread`, never left as no flags
// (`wallets close-empty` was once read as taking none).
//
// For the prompt pane it also reads, following the handler's calls into other files:
// whether it unlocks the vault (`unlocks`), which streams it checks are a terminal (`tty`), and for a
// handler that only dispatches a word (`vault factor add`), the same per word (`actions`). And the
// access presets (agent-key-access.ts): each preset's exact scopes, which a custom key is built from.
//
// It also reads the command-word aliases (`ALIASES` in index.ts), which the CLI resolves before routing.
//
// The repo is named on the command line, since the CLI's own package.json kept `candledottv/agentic`
// after it moved to `candledottv/cli` (0.13.5):
//
//   bun scripts/read-cli-source.ts <cli>/packages/cli/src <commit> candledottv/cli > src/core/cli-source.json
import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

const files = new Map<string, string>()
const read = (file: string) => {
  let text = files.get(file)
  if (text === undefined) files.set(file, (text = readFileSync(file, "utf8")))
  return text
}

/** The index just past a string or template literal starting at `i`, following `${...}` nesting. */
function skipString(text: string, i: number): number {
  const quote = text[i]!
  for (let j = i + 1; j < text.length; j++) {
    const c = text[j]!
    if (c === "\\") j++
    else if (c === quote) return j + 1
    else if (quote === "`" && c === "$" && text[j + 1] === "{") j = skipCode(text, j + 1, "}") - 1
  }
  throw new Error(`unterminated string at ${i}`)
}

/** The index just past the `closer` that balances the opener at `open`, skipping strings, comments and regex literals. */
function skipCode(text: string, open: number, closer: string): number {
  const opener = text[open]!
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const c = text[i]!
    if (c === "/" && text[i + 1] === "/") {
      i = text.indexOf("\n", i)
      if (i < 0) break
      continue
    }
    if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i) + 1
      continue
    }
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(text, i) - 1
      continue
    }
    // A regex literal: a "/" where an expression starts. Its body can hold quotes and braces.
    if (c === "/" && /([(,=:[!&|?{};]|return)\s*$/.test(text.slice(Math.max(0, i - 20), i))) {
      let inClass = false
      for (i++; i < text.length && (text[i] !== "/" || inClass) && text[i] !== "\n"; i++) {
        if (text[i] === "\\") i++
        else if (text[i] === "[") inClass = true
        else if (text[i] === "]") inClass = false
      }
      continue
    }
    if (c === opener) depth++
    else if (c === closer && --depth === 0) return i + 1
  }
  throw new Error(`unbalanced at ${open}`)
}

const CLOSERS: Record<string, string> = { "{": "}", "[": "]", "(": ")" }

/** The text of the balanced `{...}` (or `(...)`, or `[...]`) starting at `open`. */
function balanced(text: string, open: number): string {
  return text.slice(open, skipCode(text, open, CLOSERS[text[open]!] ?? ")"))
}

/** Where an expression starting at `i` ends: the first `,` (or `stop`) outside brackets and strings. */
function expressionEnd(text: string, i: number, stop = ""): number {
  for (let j = i; j < text.length; j++) {
    const c = text[j]!
    if (c === "," || stop.includes(c)) return j
    if (c === "/" && text[j + 1] === "/") {
      // A trailing comment ends a line-bounded expression; otherwise it's skipped.
      if (stop.includes("\n")) return j
      j = text.indexOf("\n", j)
      if (j < 0) return text.length
      continue
    }
    if (c === '"' || c === "'" || c === "`") j = skipString(text, j) - 1
    else if (c in CLOSERS) j = skipCode(text, j, CLOSERS[c]!) - 1
  }
  return text.length
}

/**
 * `key: value` pairs at the top level of an object literal's text. A value is a whole expression. A
 * spread entry (`...(cond ? { pathFlags: [...] } : {})`) has no key: it's skipped, or kept as `...`
 * with its expression where a caller asks for spreads, and nothing after it is lost.
 */
function topLevelEntries(objectText: string, withSpreads = false): [string, string][] {
  const body = objectText.slice(1, -1)
  const entries: [string, string][] = []
  let i = 0
  while (i < body.length) {
    const spread = /^(?:\s+|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/|,)*\.\.\.\s*/.exec(body.slice(i))
    if (spread) {
      i += spread[0].length
      const end = expressionEnd(body, i, "\n")
      if (withSpreads) entries.push(["...", body.slice(i, end).trim()])
      i = end
      continue
    }
    const m = /^(?:\s+|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/|,)*("[^"]+"|[A-Za-z_$][\w$]*)\s*:\s*/.exec(body.slice(i))
    if (!m) break
    const key = m[1]!.replace(/"/g, "")
    i += m[0].length
    // Brackets are skipped whole, so a value ends at its own comma, or at the line's end (the last entry).
    const end = expressionEnd(body, i, "\n")
    entries.push([key, body.slice(i, end).trim()])
    i = end
  }
  return entries
}

/** The arguments of a call whose `(` is at `open`, split at top-level commas. */
function callArguments(text: string, open: number): string[] {
  const inner = balanced(text, open).slice(1, -1)
  const args: string[] = []
  for (let i = 0; i < inner.length; ) {
    const end = expressionEnd(inner, i)
    const arg = inner.slice(i, end).trim()
    if (arg) args.push(arg)
    i = end + 1
  }
  return args
}

const OWNER = /\b(resolveDeviceToken|unlockInteractively|unlockVault|openVault|unlockWithPassphrase|unlockWithSecurityKey)\b/
const AGENT = /\b(tradingKey|resolveApiKey)\b/

/**
 * The body's `{` after a parameter list ending at `from`: past a return type, which can hold object
 * types of its own (`): { rest: string[] } | { error: string } {`). The body's brace is the first at
 * the top level that doesn't follow `:`, `|`, `&`, `<` or `,`.
 */
function bodyBrace(text: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    const c = text[i]!
    if (c === "{") {
      const before = text.slice(from, i).trimEnd().at(-1)
      if (before === undefined || !":|&<,".includes(before)) return i
      i = skipCode(text, i, "}") - 1
    } else if (c === "(" || c === "[") i = skipCode(text, i, CLOSERS[c]!) - 1
  }
  throw new Error(`no function body after ${from}`)
}

/** A function's text in a file: `export async function name(` or `async function name(`. */
function functionText(fileText: string, name: string): string | undefined {
  const m = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(fileText)
  if (m) {
    // Past the parameter list (which may hold an object type), to the body's brace.
    const close = balanced(fileText, m.index + m[0].length - 1)
    return balanced(fileText, bodyBrace(fileText, m.index + m[0].length - 1 + close.length))
  }
  // `export const name = (args, ctx) => runShared(...)`, or `=> { ... }`.
  const arrow = new RegExp(`(?:export\\s+)?const\\s+${name}\\s*(?::[^=]+)?=\\s*(?:async\\s*)?\\(`).exec(fileText)
  if (!arrow) return undefined
  const params = balanced(fileText, arrow.index + arrow[0].length - 1)
  const after = arrow.index + arrow[0].length - 1 + params.length
  const rest = fileText.slice(after)
  const fat = /^[^=]*=>\s*/.exec(rest)
  if (!fat) return undefined
  const start = after + fat[0].length
  const lineEnd = fileText.indexOf("\n", start)
  return fileText[start] === "{" ? balanced(fileText, start) : fileText.slice(start, lineEnd < 0 ? undefined : lineEnd)
}

/** The function's own text plus local functions it calls, two levels down. */
function reachable(fileText: string, name: string, depth = 2, seen = new Set<string>()): string {
  if (seen.has(name)) return ""
  seen.add(name)
  const own = functionText(fileText, name)
  if (!own) return ""
  if (depth === 0) return own
  let all = own
  for (const call of own.matchAll(/\b([a-z][A-Za-z0-9]*)\s*\(/g)) {
    if (functionText(fileText, call[1]!) && !seen.has(call[1]!)) all += `\n${reachable(fileText, call[1]!, depth - 1, seen)}`
  }
  return all
}

/** A relative import's file: `./x` is x.ts, or x/index.ts. */
function importTarget(fromDir: string, spec: string): string | undefined {
  for (const candidate of [resolve(fromDir, `${spec}.ts`), resolve(fromDir, spec, "index.ts")]) if (existsSync(candidate)) return candidate
  return undefined
}

/**
 * Where each name a file imports from a relative path is defined: `import { a, b as c } from "./x"`,
 * and the dynamic `const { a } = await import("../x")` handlers use for what only some paths need.
 */
function importsOf(file: string): Map<string, { file: string; name: string }> {
  const text = read(file)
  const out = new Map<string, { file: string; name: string }>()
  const add = (names: string, spec: string, alias: RegExp) => {
    const target = importTarget(dirname(file), spec)
    if (!target) return
    for (const part of names.split(",")) {
      const [orig, local] = part.replace(/^\s*type\s+/, "").trim().split(alias)
      if (orig) out.set((local ?? orig).trim(), { file: target, name: orig.trim() })
    }
  }
  for (const m of text.matchAll(/import\s*\{([^}]+)\}\s*from\s*"(\.[^"]+)"/g)) add(m[1]!, m[2]!, /\s+as\s+/)
  for (const m of text.matchAll(/const\s*\{([^}]+)\}\s*=\s*await\s+import\(\s*"(\.[^"]+)"\s*\)/g)) add(m[1]!, m[2]!, /\s*:\s*/)
  return out
}

/**
 * A function's text plus what it calls, `depth` levels down, into other files through their imports:
 * what the vault and terminal facts are read from. Each function is taken once.
 */
function reachAcross(file: string, name: string, depth: number, seen = new Set<string>()): string {
  const key = `${file}#${name}`
  if (seen.has(key)) return ""
  seen.add(key)
  const text = read(file)
  const own = functionText(text, name)
  if (!own) return ""
  if (depth === 0) return own
  const imports = importsOf(file)
  let all = own
  for (const call of own.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
    const callee = call[1]!
    if (functionText(text, callee)) all += `\n${reachAcross(file, callee, depth - 1, seen)}`
    else {
      const imported = imports.get(callee)
      if (imported) all += `\n${reachAcross(imported.file, imported.name, depth - 1, seen)}`
    }
  }
  return all
}

/**
 * Whether a command unlocks the vault itself, so a factor step before it would ask twice:
 * - never: nothing it reaches unlocks;
 * - if-tee-and-vault: only when a wallet it names is a TEE wallet and a vault exists (`tee rename`);
 * - if-vault: whenever a vault exists, through the TEE lookup that treats no vault as no hit (`tee enable`);
 * - always: it opens the vault, and fails without one.
 */
export type Unlocks = "always" | "if-vault" | "if-tee-and-vault" | "never"

function unlocksOf(body: string): Unlocks {
  if (!/\b(unlockInteractively|findTeeInVault)\s*\(/.test(body)) return "never"
  if (/\.tee\)\s*\?\s*await\s+readVaultRaw\(/.test(body)) return "if-tee-and-vault"
  if (/\bfindTeeInVault\s*\(/.test(body) && !/\b(missingVault|requireTty|requirePromptStreams)\s*\(/.test(body)) return "if-vault"
  return "always"
}

/**
 * The streams it checks are a terminal: `requireTty` is stdin and stdout; `requirePromptStreams`
 * and `refusePromptsWithoutTerminal` are stdin and stderr; and any inline `isTTY.<stream>`.
 */
function ttyOf(body: string): string[] {
  const streams = new Set<string>()
  if (/\brequireTty\s*\(/.test(body)) streams.add("stdin").add("stdout")
  if (/\b(requirePromptStreams|refusePromptsWithoutTerminal)\s*\(/.test(body)) streams.add("stdin").add("stderr")
  for (const m of body.matchAll(/\bisTTY\.(stdin|stdout|stderr)\b/g)) streams.add(m[1]!)
  return ["stdin", "stdout", "stderr"].filter((s) => streams.has(s))
}

/** A dispatcher's words and the function each runs: `case "add": return f(` and `if (word === "add") return f(`. */
function dispatchedWords(body: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of body.matchAll(/case\s+"([a-z][a-z-]*)"\s*:\s*return\s+([A-Za-z_$][\w$]*)\s*\(/g)) out[m[1]!] = m[2]!
  for (const m of body.matchAll(/if\s*\(\s*[a-z]+\s*===\s*"([a-z][a-z-]*)"\s*\)\s*return\s+([A-Za-z_$][\w$]*)\s*\(/g)) out[m[1]!] = m[2]!
  // The first argument itself (`transfer status`, 0.13.19), awaited or not. Not any local awaited the same
  // way: `chain === "hood"` and `reason === "interrupted"` branch on a value, not a typed word.
  for (const m of body.matchAll(/if\s*\(\s*args\[0\]\s*===\s*"([a-z][a-z-]*)"\s*\)\s*return\s+(?:await\s+)?([A-Za-z_$][\w$]*)\s*\(/g)) out[m[1]!] = m[2]!
  return out
}

const REACH_DEPTH = 4
/** How many names a value may be followed through (a const naming a const, an import), so a loop ends. */
const NAME_DEPTH = 8

/** A file-level `const NAME = {...}` or `[...]`, as text (its type annotation skipped). */
function constText(fileText: string, name: string): string | undefined {
  const m = new RegExp(`const\\s+${name}\\b[^=]*=\\s*(?=[[{])`).exec(fileText)
  if (!m) return undefined
  const text = balanced(fileText, m.index + m[0].length)
  // `{ ... } as const`, `[ ... ] satisfies …`: the literal alone.
  return text
}

const flagLiterals = (text: string): string[] => [...text.matchAll(/"(-[^"\s]*)"/g)].map((m) => m[1]!)

/**
 * Where a spec is read: its file, for consts and imports, the handler's own text, for its locals, and
 * the parameters its calls bind to a literal (`report(args, ctx, "runners")` binds `kind`).
 */
interface Scope {
  file: string
  text: string
  body: string
  vars: Record<string, unknown>
}

/** An expression without the parentheses wrapping all of it. */
function unwrap(expr: string): string {
  let e = expr.trim()
  while (e.startsWith("(") && balanced(e, 0).length === e.length) e = e.slice(1, -1).trim()
  return e
}

const NAME = /^[A-Za-z_$][\w$]*$/
const isWhole = (e: string, opener: string) => e.startsWith(opener) && balanced(e, 0).length === e.length

/** An array literal's elements, comments dropped. */
function elements(arrayText: string): string[] {
  const inner = arrayText.slice(1, -1)
  const out: string[] = []
  for (let i = 0; i < inner.length; ) {
    const end = expressionEnd(inner, i)
    const el = inner.slice(i, end).replace(/^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)+/, "").replace(/\/\/[^\n]*$/, "").trim()
    if (el) out.push(el)
    i = end + 1
  }
  return out
}

/**
 * A top-level `const NAME = …` in a file: its expression's text, up to the first line at the top level
 * that doesn't carry it on (`.filter(…)` on the next line does). `as const` and `satisfies …` dropped.
 */
function constExpression(fileText: string, name: string, local = false): string | undefined {
  const m = new RegExp(`(?:^|\\n)${local ? "[ \\t]*" : "(?:export\\s+)?"}const\\s+${name}\\b[^=\\n]*=\\s*`).exec(fileText)
  if (!m) return undefined
  const start = m.index + m[0].length
  let i = start
  for (; i < fileText.length; i++) {
    const c = fileText[i]!
    if (c === '"' || c === "'" || c === "`") i = skipString(fileText, i) - 1
    else if (c in CLOSERS) i = skipCode(fileText, i, CLOSERS[c]!) - 1
    else if (c === "/" && fileText[i + 1] === "/") {
      const nl = fileText.indexOf("\n", i)
      if (nl < 0) break
      i = nl - 1
    } else if (c === "\n" && !/^\s*(?:[.?:|&+]|=>)/.test(fileText.slice(i + 1, i + 80))) break
  }
  return fileText
    .slice(start, i)
    .trim()
    .replace(/\s+(?:as\s+const|satisfies\s+[\w$<>,[\]\s]+)$/, "")
}

/** The index of `token` at the top level of an expression, outside strings and brackets, from `from`. */
function topLevelAt(text: string, token: string, from = 0): number {
  for (let i = from; i < text.length; i++) {
    const c = text[i]!
    if (c === '"' || c === "'" || c === "`") i = skipString(text, i) - 1
    else if (c in CLOSERS) i = skipCode(text, i, CLOSERS[c]!) - 1
    else if (text.startsWith(token, i)) {
      // A ternary's `?` isn't `?.` or `??`.
      if (token === "?" && (text[i + 1] === "." || text[i + 1] === "?" || text[i - 1] === "?")) continue
      return i
    }
  }
  return -1
}

/** The `:` that closes the ternary whose `?` is at `q`, past any ternary nested in its first branch. */
function ternaryColon(text: string, q: number): number {
  let depth = 0
  for (let i = q + 1; i < text.length; i++) {
    const c = text[i]!
    if (c === '"' || c === "'" || c === "`") i = skipString(text, i) - 1
    else if (c in CLOSERS) i = skipCode(text, i, CLOSERS[c]!) - 1
    else if (c === "?" && text[i + 1] !== "." && text[i + 1] !== "?" && text[i - 1] !== "?") depth++
    else if (c === ":" && depth-- === 0) return i
  }
  return -1
}

/** A file-level name's value: a const the reader evaluates, followed through imports. */
function valueOf(file: string, name: string, depth = 0): unknown {
  if (depth > NAME_DEPTH) throw new Error(`${name} is imported too many files deep`)
  const expr = constExpression(read(file), name)
  if (expr !== undefined) return evaluate(expr, { file, vars: {} }, depth)
  const imported = importsOf(file).get(name)
  if (!imported) throw new Error(`${name} is no const or import the reader can find`)
  return valueOf(imported.file, imported.name, depth + 1)
}

/** One arrow function's parameter and body: `(field) => …`, or `field => …`. */
function arrow(text: string): { param: string; body: string } {
  const m = /^\(?\s*([A-Za-z_$][\w$]*)\s*(?::[^)=]*)?\)?\s*=>\s*([\s\S]+)$/.exec(text.trim())
  if (!m) throw new Error(`a callback the reader can't follow: ${text.slice(0, 60)}`)
  return { param: m[1]!, body: m[2]! }
}

/**
 * The value of an expression a flag list is derived from, read as text and never run: JSON-shaped
 * literals, names (file-level consts, imports, a callback's parameter, a handler's parameter bound by
 * a literal), `.prop` and `["prop"]`, `.filter`, `.map` and `.flatMap` with an arrow, `.startsWith("…")`,
 * `===`, `!==`, `||`, `&&`, `"key" in x`, a ternary, and array and object literals with spreads. Anything else throws, so a list the reader can't follow is unread.
 */
function evaluate(expr: string, env: { file: string; vars: Record<string, unknown> }, depth = 0): unknown {
  const e = unwrap(expr)
  const fail = (): never => {
    throw new Error(`an expression the reader can't evaluate: ${e.slice(0, 60)}`)
  }
  const q = topLevelAt(e, "?")
  if (q >= 0) {
    const colon = ternaryColon(e, q)
    if (colon < 0) fail()
    return evaluate(e.slice(0, q), env, depth) ? evaluate(e.slice(q + 1, colon), env, depth) : evaluate(e.slice(colon + 1), env, depth)
  }
  for (const op of ["||", "&&"]) {
    const at = topLevelAt(e, op)
    if (at < 0) continue
    const left = evaluate(e.slice(0, at), env, depth)
    if (op === "||" ? left : !left) return left
    return evaluate(e.slice(at + 2), env, depth)
  }
  for (const op of ["===", "!=="]) {
    const at = topLevelAt(e, op)
    if (at < 0) continue
    const same = evaluate(e.slice(0, at), env, depth) === evaluate(e.slice(at + 3), env, depth)
    return op === "===" ? same : !same
  }
  const inAt = topLevelAt(e, " in ")
  if (inAt >= 0) {
    const key = evaluate(e.slice(0, inAt), env, depth)
    const object = evaluate(e.slice(inAt + 4), env, depth)
    if (typeof key !== "string" || typeof object !== "object" || object === null) fail()
    return (key as string) in (object as object)
  }
  if (/^"(?:[^"\\]|\\.)*"$/.test(e)) return JSON.parse(e)
  if (/^-?\d+(?:\.\d+)?$/.test(e)) return Number(e)
  if (e === "true" || e === "false") return e === "true"
  if (isWhole(e, "[")) {
    const out: unknown[] = []
    for (const el of elements(e)) {
      if (!el.startsWith("...")) out.push(evaluate(el, env, depth))
      else {
        const spread = evaluate(el.slice(3), env, depth)
        if (!Array.isArray(spread)) fail()
        out.push(...(spread as unknown[]))
      }
    }
    return out
  }
  if (isWhole(e, "{")) {
    try {
      return JSON.parse(e)
    } catch {}
    const out: Record<string, unknown> = {}
    for (const [key, value] of topLevelEntries(e, true)) {
      if (key !== "...") out[key] = evaluate(value, env, depth)
      else {
        const spread = evaluate(value, env, depth)
        if (typeof spread !== "object" || spread === null) fail()
        Object.assign(out, spread)
      }
    }
    return out
  }
  // A name, then accessors and array calls.
  const head = /^[A-Za-z_$][\w$]*/.exec(e)
  if (!head) fail()
  let value: unknown = head![0] in env.vars ? env.vars[head![0]] : valueOf(env.file, head![0], depth + 1)
  let i = head![0].length
  while (i < e.length) {
    const rest = e.slice(i)
    const ws = /^\s*/.exec(rest)![0].length
    const call = /^\.(filter|map|flatMap)\s*\(/.exec(rest.slice(ws))
    const starts = /^\.startsWith\s*\(\s*("(?:[^"\\]|\\.)*")\s*\)/.exec(rest.slice(ws))
    const prop = /^\.([A-Za-z_$][\w$]*)/.exec(rest.slice(ws))
    if (starts) {
      if (typeof value !== "string") fail()
      value = (value as string).startsWith(JSON.parse(starts[1]!) as string)
      i += ws + starts[0].length
    } else if (call) {
      const open = i + ws + call[0].length - 1
      const args = callArguments(e, open)
      if (!Array.isArray(value) || args.length !== 1) fail()
      const fn = arrow(args[0]!)
      const apply = (item: unknown) => evaluate(fn.body, { file: env.file, vars: { ...env.vars, [fn.param]: item } }, depth)
      const list = value as unknown[]
      if (call[1] === "filter") value = list.filter((item) => apply(item))
      else if (call[1] === "map") value = list.map(apply)
      else
        value = list.flatMap((item) => {
          const r = apply(item)
          if (!Array.isArray(r)) fail()
          return r as unknown[]
        })
      i = open + balanced(e, open).length
    } else if (prop) {
      if (typeof value !== "object" || value === null) fail()
      value = (value as Record<string, unknown>)[prop[1]!]
      i += ws + prop[0].length
    } else if (rest[ws] === "[") {
      const key = evaluate(balanced(e, i + ws).slice(1, -1), env, depth)
      if (typeof value !== "object" || value === null || typeof key !== "string") fail()
      value = (value as Record<string, unknown>)[key as string]
      i += ws + balanced(e, i + ws).length
    } else fail()
  }
  return value
}

/** A value that must be flags: a flag, or a list of them. */
function asFlags(value: unknown, what: string): string[] {
  const list = typeof value === "string" ? [value] : value
  if (!Array.isArray(list) || !list.every((f) => typeof f === "string" && f.startsWith("-"))) throw new Error(`${what} doesn't come to a list of flags`)
  return list as string[]
}

/** `const spec = TABLE[action]` in the handler: the local's table, an object const of the file. */
function aliasTable(name: string, scope: Scope): [string, string][] | undefined {
  const m = new RegExp(`const\\s+${name}\\s*=\\s*([A-Za-z_$][\\w$]*)\\s*\\[\\s*[A-Za-z_$][\\w$]*\\s*\\]`).exec(scope.body)
  const table = m ? constText(scope.text, m[1]!) : undefined
  return table?.startsWith("{") ? topLevelEntries(table) : undefined
}

/** `spec.valueFlags`, where `spec` is a table's row by action: each action's flags under that key. */
function aliasByAction(operand: string, scope: Scope): Record<string, string[]> | undefined {
  const m = /^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/.exec(operand)
  const rows = m ? aliasTable(m[1]!, scope) : undefined
  if (!rows) return undefined
  return Object.fromEntries(
    rows.map(([action, row]) => {
      const value = topLevelEntries(row).find(([k]) => k === m![2])?.[1]
      return [action, value === undefined ? [] : flagLiterals(value)]
    }),
  )
}

/**
 * The flags a spread in a flag list names. It must be one the reader can follow, or it throws:
 * `Object.keys(NAME)`, a file-level `NAME` or `NAME[x]`, a parenthesised expression, a local row of an
 * action table (`spec.valueFlags`), or a list derived from a definition it can evaluate
 * (`launchFlagFields.filter(…).map(…)`, imported from another file).
 */
function spreadFlags(operand: string, scope: Scope): string[] {
  const o = operand.trim()
  if (o.startsWith("(")) return flagsOf(o, scope)
  if (/^Object\.keys\(/.test(o)) return flagsOf(o, scope)
  const named = /^([A-Za-z_$][\w$]*)(?:\s*\[\s*[A-Za-z_$][\w$]*\s*\])?$/.exec(o)
  if (named && constText(scope.text, named[1]!) !== undefined) return flagLiterals(constText(scope.text, named[1]!)!)
  const byAction = aliasByAction(o, scope)
  if (byAction) return [...new Set(Object.values(byAction).flat())]
  try {
    return asFlags(evaluate(o, { file: scope.file, vars: scope.vars }), `...${o.slice(0, 60)}`)
  } catch (error) {
    throw new Error(`a spread the reader can't follow: ...${o.slice(0, 60)} (${(error as Error).message})`)
  }
}

/**
 * The flags an expression in a spec names. An array's elements are read one by one: a flag literal, a
 * spread (which must be followed), or a name that must hold flags. `Object.keys(NAME)` is NAME's keys,
 * and a file-level `NAME` the flags it holds. In anything else (a conditional, say), its flag literals
 * and the file-level consts it names; a name that's no file-level const there is a local (`action`,
 * `verb`) and names no flags, but every spread inside it must still be followed.
 */
function flagsOf(expr: string, scope: Scope): string[] {
  const e = unwrap(expr)
  const out = new Set<string>()
  if (NAME.test(e)) {
    const text = constText(scope.text, e)
    if (text !== undefined) return flagLiterals(text)
    try {
      // A local of the handler's (`const flags = kind === "runners" ? [...] : [...]`), else a file-level name.
      const local = constExpression(scope.body, e, true)
      if (local !== undefined) return asFlags(evaluate(local, { file: scope.file, vars: scope.vars }), e)
      return asFlags(valueOf(scope.file, e), e)
    } catch (error) {
      throw new Error(`a flag list named ${e} the reader can't follow (${(error as Error).message})`)
    }
  }
  if (isWhole(e, "[")) {
    for (const el of elements(e)) for (const f of el.startsWith("...") ? spreadFlags(el.slice(3), scope) : flagsOf(el, scope)) out.add(f)
    return [...out]
  }
  if (/^"(?:[^"\\]|\\.)*"$/.test(e)) return flagLiterals(e)
  // Spreads inside a conditional are followed, then blanked so their names aren't read again.
  let rest = e
  for (let at = topLevelAt(rest, "..."); at >= 0; at = topLevelAt(rest, "...", at + 3)) {
    const end = expressionEnd(rest, at + 3, "])}:")
    for (const f of spreadFlags(rest.slice(at + 3, end), scope)) out.add(f)
    rest = `${rest.slice(0, at)}${" ".repeat(end - at)}${rest.slice(end)}`
  }
  for (const f of flagLiterals(rest.replace(/Object\.keys\(\s*[A-Za-z_$][\w$]*\s*\)/g, ""))) out.add(f)
  for (const m of rest.matchAll(/Object\.keys\(\s*([A-Za-z_$][\w$]*)\s*\)/g)) {
    const object = constText(scope.text, m[1]!)
    if (object === undefined) throw new Error(`Object.keys(${m[1]}) names no const in the file`)
    for (const [key] of topLevelEntries(object)) if (key.startsWith("-")) out.add(key)
  }
  // Strings and Object.keys(…) out of the way: what's left that names a const is one.
  const bare = rest.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/Object\.keys\([^)]*\)/g, "")
  for (const m of bare.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\b(?!\s*\()/g)) {
    const text = constText(scope.text, m[1]!)
    if (text !== undefined) for (const f of flagLiterals(text)) out.add(f)
  }
  return [...out]
}

/** An action table in a spec's valueFlags, read per action: `...NAME[x]`, or a local row of one (`...spec.valueFlags`). */
function actionTable(expr: string, scope: Scope): Record<string, string[]> | undefined {
  const m = /\.\.\.\s*([A-Za-z_$][\w$]*)\s*\[\s*[A-Za-z_$][\w$]*\s*\]/.exec(expr)
  const object = m ? constText(scope.text, m[1]!) : undefined
  if (object?.startsWith("{")) return Object.fromEntries(topLevelEntries(object).map(([action, value]) => [action, flagLiterals(value)]))
  const alias = /\.\.\.\s*([A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*)\s*[,\]]/.exec(expr)
  return alias ? aliasByAction(alias[1]!, scope) : undefined
}

interface Flags {
  value: Set<string>
  boolean: Set<string>
  path: Set<string>
  pathPositionals: Set<string>
  byAction?: Record<string, string[]>
  /** The spec's `keyPrefixPositional`: a word like a key prefix that starts with "-" is a word, not a flag. */
  keyPrefixPositional?: true
  /** The spec's `keyPrefixValueFlags`: value flags whose value may be a key prefix that starts with "-". */
  keyPrefixValueFlags?: Set<string>
}

/**
 * One spec's flags, added to `into`. A spec is an object literal, a const naming one, or a conditional
 * between two; a spread inside an object literal is a spec of its own.
 */
function readSpec(spec: string, scope: Scope, into: Flags): void {
  const s = unwrap(spec)
  let objects: string[]
  if (NAME.test(s)) {
    const text = constText(scope.text, s)
    if (!text?.startsWith("{")) throw new Error(`spec ${s} names no object const in the file`)
    objects = [text]
  } else {
    // `{...}`, or `cond ? {} : { booleanFlags: [...] }`: every object literal at the top level.
    objects = []
    for (let i = 0; i < s.length; i++) {
      const c = s[i]!
      if (c === '"' || c === "'" || c === "`") i = skipString(s, i) - 1
      else if (c === "{") {
        objects.push(balanced(s, i))
        i += objects.at(-1)!.length - 1
      } else if (c === "(" || c === "[") i = skipCode(s, i, CLOSERS[c]!) - 1
    }
    if (objects.length === 0) throw new Error(`a spec the reader can't read: ${s.slice(0, 60)}`)
  }
  const keys: Record<string, Set<string>> = { valueFlags: into.value, booleanFlags: into.boolean, pathFlags: into.path }
  for (const object of objects) {
    for (const [key, value] of topLevelEntries(object, true)) {
      if (key === "...") readSpec(value, scope, into)
      else if (key in keys) for (const f of flagsOf(value, scope)) keys[key]!.add(f)
      else if (key === "pathPositionals") for (const p of value.matchAll(/"([^"]+)"/g)) into.pathPositionals.add(p[1]!)
      else if (key === "keyPrefixPositional") {
        if (value.trim() !== "true") throw new Error(`keyPrefixPositional the reader can't read: ${value.slice(0, 40)}`)
        into.keyPrefixPositional = true
      } else if (key === "keyPrefixValueFlags") for (const f of flagsOf(value, scope)) (into.keyPrefixValueFlags ??= new Set()).add(f)
      if (key === "valueFlags") {
        const table = actionTable(value, scope)
        if (table) into.byAction = { ...into.byAction, ...table }
      }
    }
  }
}

/** Flags lifted out of the arguments before the parse: compared against an argument, or handed to a helper with them. */
function liftedFlags(body: string): string[] {
  const out = new Set<string>()
  for (const m of body.matchAll(/\[\s*[\w$+]+\s*\]\s*[!=]==\s*"(--[a-z][a-z0-9-]*)"/g)) out.add(m[1]!)
  for (const m of body.matchAll(/\b[a-zA-Z]+\(\s*args\s*,\s*"(--[a-z][a-z0-9-]*)"\s*\)/g)) out.add(m[1]!)
  return [...out]
}

/** Every flag a function (and what it calls in its own file) parses, lifts or tests for, added to `flags`. */
function readFlags(file: string, name: string, flags: Flags): void {
  const text = read(file)
  const body = reachable(text, name)
  for (const m of body.matchAll(/\bparseArgs\(/g)) {
    const args = callArguments(body, m.index + m[0].length - 1)
    if (args.length < 2) throw new Error("a parseArgs call with no spec")
    readSpec(args[1]!, { file, text, body, vars: boundParameters(text, name) }, flags)
  }
  for (const f of liftedFlags(body)) flags.value.add(f)
  for (const f of checkedFlags(body)) if (!flags.value.has(f)) flags.boolean.add(f)
}

/** Another file's functions a handler returns into with its whole arguments: `return teeSweepEvm(args, ctx)`. */
function delegates(file: string, name: string): { file: string; name: string }[] {
  const own = functionText(read(file), name) ?? ""
  const imports = importsOf(file)
  const out = new Map<string, { file: string; name: string }>()
  for (const m of own.matchAll(/\breturn\s+(?:await\s+)?([A-Za-z_$][\w$]*)\(\s*args\s*,/g)) {
    const target = imports.get(m[1]!)
    if (target) out.set(`${target.file}#${target.name}`, target)
  }
  return [...out.values()]
}

/** Flags a handler tests for before any parse and branches on (`args.includes("--dry-run")`, swap at 0.13.19): booleans. */
function checkedFlags(body: string): string[] {
  return [...new Set([...body.matchAll(/\bargs\.includes\(\s*"(--[a-z][a-z0-9-]*)"\s*\)/g)].map((m) => m[1]!))]
}

/** A function's parameter names, in order: `(args: string[], ctx: Ctx, kind: "a" | "b")`. */
function parameterNames(fileText: string, name: string): string[] | undefined {
  const m = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(fileText)
  if (!m) return undefined
  return callArguments(fileText, m.index + m[0].length - 1).map((p) => /^[A-Za-z_$][\w$]*/.exec(p)?.[0] ?? "")
}

/**
 * The parameters of the file's own functions that a handler's calls bind to a string literal
 * (`labRunners = (args, ctx) => report(args, ctx, "runners")` binds report's `kind`). A parameter two
 * calls bind differently is left unbound, so whatever depends on it stays unread.
 */
function boundParameters(fileText: string, handler: string): Record<string, unknown> {
  const own = functionText(fileText, handler) ?? ""
  const out: Record<string, unknown> = {}
  const clash = new Set<string>()
  for (const call of own.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
    const params = call[1] === handler ? undefined : parameterNames(fileText, call[1]!)
    if (!params) continue
    callArguments(own, call.index! + call[0].length - 1).forEach((arg, i) => {
      const param = params[i]
      if (!param || !/^"(?:[^"\\]|\\.)*"$/.test(arg)) return
      const value = JSON.parse(arg) as string
      if (param in out && out[param] !== value) clash.add(param)
      out[param] = value
    })
  }
  for (const param of clash) delete out[param]
  return out
}

export function readCliSource(srcDir: string, commit: string, repo = "candledottv/cli") {
  const index = read(join(srcDir, "index.ts"))
  const commandsAt = index.indexOf("const COMMANDS: Record<string, CommandRoute> = {")
  const commandsText = balanced(index, index.indexOf("{", commandsAt))

  // `import { a, b as c } from "./commands/x"` -> local name -> file.
  const importOf = new Map<string, string>()
  for (const m of index.matchAll(/import\s*\{([^}]+)\}\s*from\s*"(\.[^"]+)"/g)) {
    for (const part of m[1]!.split(",")) {
      const [orig, alias] = part.trim().split(/\s+as\s+/)
      if (orig) importOf.set((alias ?? orig).trim(), resolve(srcDir, `${m[2]}.ts`))
    }
  }

  const failures: string[] = []

  function describeHandler(handler: string) {
    try {
      return describeHandlerOrThrow(handler)
    } catch (error) {
      failures.push(`${handler}: ${(error as Error).message}`)
      const file = importOf.get(handler)
      return { handler, file: file ? file.slice(resolve(srcDir).length + 1) : null, flags: null, identity: "unknown", json: false }
    }
  }

  function describeHandlerOrThrow(handler: string) {
    const file = importOf.get(handler)
    if (!file) return { handler, file: null, flags: null, identity: "unknown", json: false }
    const text = read(file)
    const body = reachable(text, handler)
    const flags: Flags = { value: new Set(), boolean: new Set(), path: new Set(), pathPositionals: new Set() }
    readFlags(file, handler, flags)
    // A handler that hands its arguments whole to another file's (`tee sweep` to teeSweepEvm for a Hood
    // wallet): that one's flags are this command's too.
    for (const target of delegates(file, handler)) readFlags(target.file, target.name, flags)
    const owner = OWNER.test(body)
    const agent = AGENT.test(body)
    const across = reachAcross(file, handler, REACH_DEPTH)
    const words = dispatchedWords(functionText(text, handler) ?? "")
    const actions = Object.fromEntries(
      Object.entries(words).map(([word, fn]) => {
        const target = functionText(text, fn) ? file : importsOf(file).get(fn)?.file
        if (!target) throw new Error(`${handler} dispatches ${word} to ${fn}, which the reader can't find`)
        const reached = reachAcross(target, importsOf(file).get(fn)?.name ?? fn, REACH_DEPTH)
        return [word, { unlocks: unlocksOf(reached), tty: ttyOf(reached) }]
      }),
    )
    return {
      handler,
      file: file.slice(resolve(srcDir).length + 1),
      flags: {
        value: [...flags.value].sort(),
        boolean: [...flags.boolean].sort(),
        path: [...flags.path].sort(),
        pathPositionals: [...flags.pathPositionals],
        ...(flags.byAction ? { byAction: flags.byAction } : {}),
        ...(flags.keyPrefixPositional ? { keyPrefixPositional: true } : {}),
        ...(flags.keyPrefixValueFlags ? { keyPrefixValueFlags: [...flags.keyPrefixValueFlags].sort() } : {}),
      },
      identity: owner && agent ? "both" : owner ? "owner" : agent ? "agent" : "none",
      json: /\bjson\b/.test(body),
      unlocks: unlocksOf(across),
      tty: ttyOf(across),
      ...(Object.keys(actions).length ? { actions } : {}),
    }
  }

  // Command-word aliases (`wallet` for `wallets`, 0.13.5), resolved by the CLI before it routes.
  const aliasesText = constText(index, "ALIASES")
  const aliases: Record<string, string> = aliasesText === undefined ? {} : Object.fromEntries(topLevelEntries(aliasesText).map(([k, v]) => [k, JSON.parse(v) as string]))

  const commands: Record<string, unknown>[] = []
  for (const [word, route] of topLevelEntries(commandsText)) {
    const entries = topLevelEntries(route)
    for (const [key, value] of entries) {
      if (key === "bare") commands.push({ command: word, subcommand: null, ...describeHandler(value) })
      if (key === "subcommands") {
        for (const [sub, handler] of topLevelEntries(value)) commands.push({ command: word, subcommand: sub, ...describeHandler(handler) })
      }
    }
  }

  const help = read(join(srcDir, "help.ts"))
  const helpAt = /export const HELP[^=]*=\s*\{/.exec(help)
  const helpText = helpAt ? balanced(help, helpAt.index + helpAt[0].length - 1) : "{}"
  const helpTopics = topLevelEntries(helpText).map(([k]) => k)

  /** A string literal's value. Interpolations in a template literal become "…": they're computed, not text. */
  function literal(text: string): string {
    if (text.startsWith('"')) return JSON.parse(text) as string
    const body = text.startsWith("`") ? text.slice(1, -1).replace(/\$\{[^}]*\}/g, "…") : text.slice(1, -1)
    return body.replace(/\\(.)/g, "$1")
  }

  /** The first `key: "…"` in an object's text, as its value. */
  function stringField(objectText: string, key: string): string | undefined {
    const m = new RegExp(`\\b${key}\\s*:\\s*(?=["'\`])`).exec(objectText)
    if (!m) return undefined
    const at = m.index + m[0].length
    return literal(objectText.slice(at, skipString(objectText, at)))
  }

  /** The object literals in an array's text, skipping comments. */
  function objectsIn(arrayText: string, where: string): string[] {
    const objects: string[] = []
    for (let i = 1; i < arrayText.length - 1; ) {
      const rest = /^(?:\s+|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/|,)+/.exec(arrayText.slice(i))
      if (rest) {
        i += rest[0].length
        continue
      }
      if (arrayText[i] !== "{") {
        failures.push(`${where}: a row that isn't an object literal`)
        break
      }
      const object = balanced(arrayText, i)
      objects.push(object)
      i += object.length
    }
    return objects
  }

  // The CLI's own help: its groups, and for each command word the group, summary and rows (subcommand
  // invocations and what each does). The commands pane shows these, grouped as the CLI groups them.
  const groupsAt = /export const GROUPS\s*=\s*\[/.exec(help)
  const groups = groupsAt ? [...balanced(help, groupsAt.index + groupsAt[0].length - 1).matchAll(/"([^"]+)"/g)].map((m) => m[1]!) : []
  const topics: Record<string, { group: string; display?: string; summary: string; rows: { invocation: string; description: string }[] }> = {}
  /**
   * A word the topic documents only in its usage lines and description, with no row of its own
   * (`candle transfer status <id>`, 0.13.19): a row from the usage line, described by the description's
   * sentence that names it. A usage line whose second word isn't a plain word (`<from>`, a flag) is the
   * command itself.
   */
  function usageRows(word: string, topicText: string, rows: readonly { invocation: string }[]): { invocation: string; description: string }[] {
    const usageAt = /\busage\s*:\s*\[/.exec(topicText)
    if (!usageAt) return []
    const lines = [...balanced(topicText, usageAt.index + usageAt[0].length - 1).matchAll(/"(?:[^"\\]|\\.)*"/g)].map((m) => JSON.parse(m[0]) as string)
    const description = stringField(topicText, "description") ?? ""
    const out: { invocation: string; description: string }[] = []
    for (const line of lines) {
      const m = new RegExp(`^candle ${word} ([a-z][a-z-]*)(?:\\s|$)`).exec(line)
      if (!m || rows.some((r) => r.invocation.trim().split(/\s+/)[0] === m[1]) || out.some((r) => r.invocation.startsWith(`${m[1]} `))) continue
      const sentence = description.split(/(?<=\.)\s+/).find((s) => s.includes(`candle ${word} ${m[1]} `))
      if (!sentence) {
        failures.push(`help ${word}: usage names ${m[1]}, which no row or sentence of the description says what it does`)
        continue
      }
      const said = sentence.replace(new RegExp(`^candle ${word} ${m[1]} \\S+\\s*`), "")
      out.push({ invocation: line.slice(`candle ${word} `.length), description: said.charAt(0).toUpperCase() + said.slice(1) })
    }
    return out
  }
  for (const [word, topicText] of topLevelEntries(helpText)) {
    const rowsAt = /\brows\s*:\s*\[/.exec(topicText)
    const rows = rowsAt ? objectsIn(balanced(topicText, rowsAt.index + rowsAt[0].length - 1), `help ${word}`) : []
    const display = stringField(topicText, "display")
    const listed = rows.map((row) => ({ invocation: stringField(row, "invocation") ?? "", description: stringField(row, "description") ?? "" }))
    topics[word] = {
      group: stringField(topicText, "group") ?? "",
      ...(display ? { display } : {}),
      summary: stringField(topicText, "summary") ?? "",
      rows: [...listed, ...usageRows(word, topicText, listed)],
    }
    if (!groups.includes(topics[word]!.group)) failures.push(`help ${word}: group "${topics[word]!.group}" isn't in GROUPS`)
  }

  // The access presets: `scopesForPreset`'s cases, each returning a spread of an explicit const, and
  // the words each is shown as. A custom key (an LP key) is a preset's list plus a scope.
  const presets: Record<string, { label: string; scopes: string[] }> = {}
  const accessFile = join(srcDir, "agent-key-access.ts")
  if (!existsSync(accessFile)) failures.push("agent-key-access.ts: not found, so the presets weren't read")
  else {
    const access = read(accessFile)
    const labelsText = constText(access, "AGENT_KEY_PRESET_LABELS")
    const labels = Object.fromEntries(labelsText ? topLevelEntries(labelsText).map(([k, v]) => [k, literal(v)]) : [])
    const cases = [...(functionText(access, "scopesForPreset") ?? "").matchAll(/case\s+"([a-z]+)"\s*:\s*return\s*\[\s*\.\.\.\s*([A-Z_]+)\s*\]/g)]
    if (cases.length === 0) failures.push("agent-key-access.ts: scopesForPreset has no case the reader can read")
    for (const [, preset, name] of cases) {
      const list = constText(access, name!)?.replace(/\/\/[^\n]*/g, "")
      if (!list?.startsWith("[") || labels[preset!] === undefined) {
        failures.push(`agent-key-access.ts: preset ${preset} (${name}) isn't an explicit list with a label`)
        continue
      }
      presets[preset!] = { label: labels[preset!]!, scopes: [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1]!) }
    }
  }

  return {
    about:
      "Read from the Candle CLI's source by scripts/read-cli-source.ts, as text, never imported or run: the dispatch table, each handler's own parseArgs flags (and flags it lifts out before the parse, as value flags), --json, its identity from what it calls, whether it unlocks the vault and which streams it needs to be a terminal (following its calls into other files), and the access presets' scopes.",
    source: { repo, path: "packages/cli/src", commit, cliVersion: JSON.parse(read(join(srcDir, "../package.json"))).version },
    aliases,
    helpTopics,
    groups,
    help: topics,
    commands,
    presets,
    unread: failures,
  }
}

if (import.meta.main) {
  const [srcDir, commit, repo] = process.argv.slice(2)
  if (!srcDir || !commit || !repo) {
    console.error("Usage: bun scripts/read-cli-source.ts <cli src dir> <commit> <owner/repo>")
    process.exit(2)
  }
  process.stdout.write(`${JSON.stringify(readCliSource(srcDir, commit, repo), null, 2)}\n`)
}

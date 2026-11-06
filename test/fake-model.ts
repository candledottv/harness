// A scripted model, for checking an engine without a real provider. It answers in three shapes, so every engine can be pointed at it:
//   - OpenAI Chat Completions (`/chat/completions`): Pi as a local model (models.json), OpenCode as a provider;
//   - OpenAI Responses (`/responses`): Codex as a custom provider, Grok by GROK_MODELS_BASE_URL;
//   - Anthropic Messages (`/messages`): Claude Code by ANTHROPIC_BASE_URL.
// Every request is logged, so the isolation checks see exactly what would reach a model.
//
// The first user message picks the script:
//   SCRIPT:hello            a short streamed reply
//   SCRIPT:call <tool> <json args>   one tool call, then a reply quoting the start of its result
//   SCRIPT:slow             streams for 60 s (for cancel)
//   SCRIPT:fail             answers 401, as a provider does for a bad key
// A harness's own side request (one that declares no tools, or asks for a session title or a status line)
// always gets a short reply, and the script is read from the first user message that carries one.
// Run: bun test/fake-model.ts <requests.jsonl>   (prints "listening <port>")
import { appendFileSync } from "node:fs"

export type Api = "chat" | "responses" | "messages"

/** One logged request: the API, the tools it declared, the tool results it carried back, and its whole body. */
export interface LoggedRequest {
  at: number
  api: Api
  auth: "set" | "none"
  tools: string[]
  /** Each tool result in the request, by its call id, as text. */
  results: { id: string; text: string }[]
  body: any
}

const text = (c: unknown): string =>
  typeof c === "string"
    ? c
    : Array.isArray(c)
      ? c.map((p: any) => (typeof p === "string" ? p : typeof p?.text === "string" ? p.text : typeof p?.content === "string" || Array.isArray(p?.content) ? text(p.content) : "")).join("")
      : ""

/** The first JSON object in `s`, braces balanced and strings respected: a harness may add text after the prompt. */
export function firstJson(s: string): string | undefined {
  const start = s.indexOf("{")
  if (start < 0) return undefined
  let depth = 0
  let inString = false
  for (let i = start; i < s.length; i++) {
    const c = s[i]!
    if (inString) {
      if (c === "\\") i++
      else if (c === '"') inString = false
    } else if (c === '"') inString = true
    else if (c === "{") depth++
    else if (c === "}" && --depth === 0) return s.slice(start, i + 1)
  }
  return undefined
}

/** The first user message that carries a script, else the first: a harness may send its own context first. */
const scripted = (users: string[]): string => users.find((u) => /SCRIPT:/.test(u)) ?? users[0] ?? ""

/** A harness's own side request (a session title, a status line), answered with text whatever it declares. */
const sideRequest = (system: string): boolean => /session title|dashboard line|title for (this|the) (conversation|session)/i.test(system)

/** What a request is, in one shape for all three APIs. */
interface Read {
  firstUser: string
  side: boolean
  /** The last thing in the conversation was a tool's result. */
  afterTool?: string
  tools: string[]
  results: { id: string; text: string }[]
}

function readChat(body: any): Read {
  const messages: any[] = body.messages ?? []
  const last = messages[messages.length - 1]
  return {
    firstUser: scripted(messages.filter((m) => m.role === "user").map((m) => text(m.content))),
    side: sideRequest(messages.filter((m) => m.role === "system").map((m) => text(m.content)).join("\n")),
    ...(last?.role === "tool" ? { afterTool: text(last.content) } : {}),
    tools: (body.tools ?? []).map((t: any) => t.function?.name ?? t.name).filter(Boolean),
    results: messages.filter((m) => m.role === "tool").map((m) => ({ id: String(m.tool_call_id ?? ""), text: text(m.content) })),
  }
}

function readResponses(body: any): Read {
  const input: any[] = typeof body.input === "string" ? [{ role: "user", content: body.input }] : (body.input ?? [])
  const isResult = (i: any) => i?.type === "function_call_output" || i?.type === "custom_tool_call_output"
  const outputText = (i: any) => (typeof i.output === "string" ? i.output : text(i.output))
  const last = input[input.length - 1]
  return {
    firstUser: scripted(input.filter((i) => i?.role === "user" && (i.type === undefined || i.type === "message")).map((i) => text(i.content))),
    side: sideRequest([String(body.instructions ?? ""), ...input.filter((i) => i?.role === "system" || i?.role === "developer").map((i) => text(i.content))].join("\n")),
    ...(isResult(last) ? { afterTool: outputText(last) } : {}),
    tools: (body.tools ?? []).map((t: any) => t.name ?? t.function?.name ?? t.type).filter(Boolean),
    results: input.filter(isResult).map((i) => ({ id: String(i.call_id ?? ""), text: outputText(i) })),
  }
}

function readMessages(body: any): Read {
  const messages: any[] = body.messages ?? []
  const blocks = (m: any): any[] => (Array.isArray(m?.content) ? m.content : [{ type: "text", text: String(m?.content ?? "") }])
  const results = messages.filter((m) => m.role === "user").flatMap((m) => blocks(m).filter((b) => b.type === "tool_result").map((b) => ({ id: String(b.tool_use_id ?? ""), text: text(b.content) })))
  const last = messages[messages.length - 1]
  const lastResults = last?.role === "user" ? blocks(last).filter((b) => b.type === "tool_result") : []
  const system = typeof body.system === "string" ? body.system : text(body.system)
  return {
    firstUser: scripted(messages.filter((m) => m.role === "user").map((m) => blocks(m).filter((b) => b.type === "text").map((b) => b.text).join("\n"))),
    side: sideRequest(system),
    ...(lastResults.length ? { afterTool: lastResults.map((b) => text(b.content)).join("\n") } : {}),
    tools: (body.tools ?? []).map((t: any) => t.name).filter(Boolean),
    results,
  }
}

type Plan = { kind: "text"; parts: string[]; delayMs: number } | { kind: "call"; name: string; args: string }

function plan(r: Read): Plan {
  if (r.afterTool !== undefined) return { kind: "text", parts: ["Tool said: ", r.afterTool.slice(0, 200)], delayMs: 5 }
  if (r.tools.length === 0 || r.side) return { kind: "text", parts: ["Fake title"], delayMs: 1 }
  const script = /SCRIPT:(\w+)\s*(.*)/s.exec(r.firstUser)
  if (!script) return { kind: "text", parts: ["No script."], delayMs: 5 }
  const [, name, rest] = script
  if (name === "slow") return { kind: "text", parts: Array.from({ length: 600 }, (_, i) => `word${i} `), delayMs: 100 }
  if (name === "call") {
    const m = /^(\S+)\s+([\s\S]*)$/.exec(rest!.trim())
    if (m) return { kind: "call", name: m[1]!, args: firstJson(m[2]!) ?? "{}" }
  }
  return { kind: "text", parts: ["Hello ", "from ", "the ", "fake ", "model."], delayMs: 5 }
}

let n = 0
const id = (prefix: string) => `${prefix}_fake${++n}`

function sse(send: (s: string) => void, event: string | undefined, data: unknown) {
  send(`${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`)
}

async function streamChat(send: (s: string) => void, p: Plan) {
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) => sse(send, undefined, { id: "chatcmpl-fake", object: "chat.completion.chunk", created: 0, model: "fake-1", choices: [{ index: 0, delta, finish_reason: finish }] })
  chunk({ role: "assistant", content: "" })
  if (p.kind === "text") {
    for (const part of p.parts) {
      chunk({ content: part })
      await Bun.sleep(p.delayMs)
    }
    chunk({}, "stop")
  } else {
    chunk({ tool_calls: [{ index: 0, id: id("call"), type: "function", function: { name: p.name, arguments: p.args } }] })
    chunk({}, "tool_calls")
  }
  sse(send, undefined, { id: "chatcmpl-fake", object: "chat.completion.chunk", created: 0, model: "fake-1", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })
  send("data: [DONE]\n\n")
}

async function streamResponses(send: (s: string) => void, p: Plan, model: string) {
  const respId = id("resp")
  const base = { id: respId, object: "response", created_at: Math.floor(Date.now() / 1000), model, status: "in_progress", output: [] as unknown[] }
  sse(send, "response.created", { type: "response.created", response: base })
  sse(send, "response.in_progress", { type: "response.in_progress", response: base })
  let item: Record<string, unknown>
  if (p.kind === "text") {
    const itemId = id("msg")
    sse(send, "response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { type: "message", id: itemId, role: "assistant", status: "in_progress", content: [] } })
    sse(send, "response.content_part.added", { type: "response.content_part.added", item_id: itemId, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } })
    for (const part of p.parts) {
      sse(send, "response.output_text.delta", { type: "response.output_text.delta", item_id: itemId, output_index: 0, content_index: 0, delta: part })
      await Bun.sleep(p.delayMs)
    }
    const whole = p.parts.join("")
    sse(send, "response.output_text.done", { type: "response.output_text.done", item_id: itemId, output_index: 0, content_index: 0, text: whole })
    sse(send, "response.content_part.done", { type: "response.content_part.done", item_id: itemId, output_index: 0, content_index: 0, part: { type: "output_text", text: whole, annotations: [] } })
    item = { type: "message", id: itemId, role: "assistant", status: "completed", content: [{ type: "output_text", text: whole, annotations: [] }] }
  } else {
    item = { type: "function_call", id: id("fc"), call_id: id("call"), name: p.name, arguments: p.args, status: "completed" }
    sse(send, "response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "", status: "in_progress" } })
    sse(send, "response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: p.args })
    sse(send, "response.function_call_arguments.done", { type: "response.function_call_arguments.done", item_id: item.id, output_index: 0, arguments: p.args })
  }
  sse(send, "response.output_item.done", { type: "response.output_item.done", output_index: 0, item })
  const usage = { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 15 }
  sse(send, "response.completed", { type: "response.completed", response: { ...base, status: "completed", output: [item], usage } })
}

async function streamMessages(send: (s: string) => void, p: Plan, model: string) {
  sse(send, "message_start", { type: "message_start", message: { id: id("msg"), type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } })
  if (p.kind === "text") {
    sse(send, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })
    for (const part of p.parts) {
      sse(send, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: part } })
      await Bun.sleep(p.delayMs)
    }
  } else {
    sse(send, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: id("toolu"), name: p.name, input: {} } })
    sse(send, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: p.args } })
  }
  sse(send, "content_block_stop", { type: "content_block_stop", index: 0 })
  sse(send, "message_delta", { type: "message_delta", delta: { stop_reason: p.kind === "text" ? "end_turn" : "tool_use", stop_sequence: null }, usage: { output_tokens: 5 } })
  sse(send, "message_stop", { type: "message_stop" })
}

/** A Messages answer whole, for a request that didn't ask to stream. */
function wholeMessage(p: Plan, model: string) {
  const content = p.kind === "text" ? [{ type: "text", text: p.parts.join("") }] : [{ type: "tool_use", id: id("toolu"), name: p.name, input: JSON.parse(p.args) }]
  return { id: id("msg"), type: "message", role: "assistant", model, content, stop_reason: p.kind === "text" ? "end_turn" : "tool_use", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } }
}

export function startFakeModel(log?: string) {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 120,
    async fetch(req) {
      const url = new URL(req.url)
      if (req.method === "HEAD" || url.pathname === "/" || url.pathname.endsWith("/api/hello")) return new Response("ok")
      if (url.pathname.endsWith("/models")) return Response.json({ object: "list", data: [{ id: "fake-1", object: "model" }] })
      if (url.pathname.endsWith("/count_tokens")) return Response.json({ input_tokens: 10 })
      const api: Api | undefined = url.pathname.endsWith("/chat/completions") ? "chat" : url.pathname.endsWith("/responses") ? "responses" : url.pathname.endsWith("/messages") ? "messages" : undefined
      if (!api) return new Response("not found", { status: 404 })
      const body = (await req.json()) as any
      const read = api === "chat" ? readChat(body) : api === "responses" ? readResponses(body) : readMessages(body)
      const authed = req.headers.get("authorization") || req.headers.get("x-api-key") ? "set" : "none"
      if (log) appendFileSync(log, `${JSON.stringify({ at: Date.now(), api, auth: authed, tools: read.tools, results: read.results, body } satisfies LoggedRequest)}\n`)
      if (/SCRIPT:fail/.test(read.firstUser)) return Response.json({ error: { message: "Incorrect API key provided", type: "invalid_request_error", code: "invalid_api_key" } }, { status: 401 })
      const p = plan(read)
      const model = String(body.model ?? "fake-1")
      if (api === "messages" && body.stream !== true) return Response.json(wholeMessage(p, model))
      const stream = new ReadableStream({
        async start(c) {
          const enc = new TextEncoder()
          const send = (s: string) => c.enqueue(enc.encode(s))
          try {
            if (api === "chat") await streamChat(send, p)
            else if (api === "responses") await streamResponses(send, p, model)
            else await streamMessages(send, p, model)
            c.close()
          } catch {}
        },
      })
      return new Response(stream, { headers: { "content-type": "text/event-stream" } })
    },
  })
}

if (import.meta.main) console.log(`listening ${startFakeModel(process.argv[2]).port}`)

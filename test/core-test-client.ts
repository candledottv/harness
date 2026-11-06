// A raw client of the core's socket for tests, ported from an earlier version's test fixtures: it keeps
// every frame it receives, so a test can search all of them for a secret.
import { createConnection } from "node:net"

export interface TestClient {
  frames: string[]
  events: { topic: string; seq: number; data: unknown; snapshot?: boolean }[]
  request(method: string, params?: Record<string, unknown>): Promise<{ result?: unknown; error?: { code: number; message: string; data?: { code: string } & Record<string, unknown> } }>
  writeRaw(text: string): void
  closed: Promise<void>
  isClosed(): boolean
  close(): void
}

export async function connectTestClient(socketPath: string): Promise<TestClient> {
  const socket = createConnection(socketPath)
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve())
    socket.once("error", reject)
  })
  const frames: string[] = []
  const events: TestClient["events"] = []
  const pending = new Map<number, (message: Record<string, unknown>) => void>()
  let nextId = 1
  let buffer = ""
  let closed = false
  const closedPromise = new Promise<void>((resolve) =>
    socket.on("close", () => {
      closed = true
      for (const [, settle] of pending) settle({ error: { code: 0, message: "closed", data: { code: "CLOSED" } } })
      pending.clear()
      resolve()
    }),
  )
  socket.on("error", () => {})
  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8")
    for (;;) {
      const newline = buffer.indexOf("\n")
      if (newline === -1) break
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      frames.push(line)
      const message = JSON.parse(line) as Record<string, unknown>
      if (message.method === "event") events.push(message.params as TestClient["events"][number])
      else if (typeof message.id === "number") {
        pending.get(message.id)?.(message)
        pending.delete(message.id)
      }
    }
  })
  return {
    frames,
    events,
    request(method, params = {}) {
      if (closed) return Promise.resolve({ error: { code: 0, message: "closed", data: { code: "CLOSED" } } })
      const id = nextId++
      return new Promise((resolve) => {
        pending.set(id, resolve as never)
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
      })
    },
    writeRaw: (text) => socket.write(text),
    closed: closedPromise,
    isClosed: () => closed,
    close: () => socket.end(),
  }
}

import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { createConnection, createServer, type Socket } from "node:net"
import { join } from "node:path"
import { peerPid, socketFd } from "./peer-pid"

const dir = mkdtempSync("/tmp/chrn-peer-")
afterAll(() => rmSync(dir, { recursive: true, force: true }))

async function serve(path: string): Promise<{ next: () => Promise<Socket>; close: () => void }> {
  const waiting: ((s: Socket) => void)[] = []
  const server = createServer((socket) => waiting.shift()?.(socket))
  await new Promise<void>((resolve) => server.listen(path, resolve))
  return { next: () => new Promise((resolve) => waiting.push(resolve)), close: () => server.close() }
}

test("the kernel names the connecting process: another process's pid, not the client's say-so", async () => {
  const path = join(dir, "a.sock")
  const s = await serve(path)
  const accepted = s.next()
  const child = Bun.spawn([process.execPath, "-e", `const c = require("node:net").createConnection(${JSON.stringify(path)}); c.on("data", () => {}); setTimeout(() => process.exit(0), 2000)`])
  const socket = await accepted
  expect(socketFd(socket)).toBeNumber()
  expect(peerPid(socket)).toBe(child.pid)
  socket.destroy()
  child.kill()
  await child.exited
  s.close()
})

test("this process's own connection names this process", async () => {
  const path = join(dir, "b.sock")
  const s = await serve(path)
  const accepted = s.next()
  const client = createConnection(path)
  const socket = await accepted
  expect(peerPid(socket)).toBe(process.pid)
  client.destroy()
  socket.destroy()
  s.close()
})

test("a socket with no descriptor is unreadable, never a guess", () => {
  expect(peerPid({} as Socket)).toBeUndefined()
})

// The socket rules: only a socket nobody answers on is ever removed.
import { afterEach, expect, test } from "bun:test"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CoreAlreadyRunningError } from "./lock"
import { answers, clearStaleSocket, SocketPathOccupied } from "./socket-path"

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), "chrn-sock-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

async function listen(path: string): Promise<Server> {
  const server = createServer((s) => s.end())
  await new Promise<void>((resolve) => server.listen(path, resolve))
  return server
}

test("nothing at the path is fine", async () => {
  await clearStaleSocket(join(folder(), "core.sock"))
})

test("a socket nobody answers on is removed", async () => {
  const path = join(folder(), "core.sock")
  // A child binds the path and is killed outright, leaving the socket file behind.
  const child = Bun.spawn(["bun", "-e", `require("node:net").createServer().listen(${JSON.stringify(path)}, () => console.log("up"))`], { stdout: "pipe" })
  await child.stdout.getReader().read()
  child.kill("SIGKILL")
  await child.exited
  expect(lstatSync(path).isSocket()).toBe(true)
  expect(await answers(path)).toBe(false)
  await clearStaleSocket(path)
  expect(existsSync(path)).toBe(false)
})

test("a socket that answers is a running core, and is left alone", async () => {
  const path = join(folder(), "core.sock")
  const server = await listen(path)
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  expect(await answers(path)).toBe(true)
  await expect(clearStaleSocket(path)).rejects.toBeInstanceOf(CoreAlreadyRunningError)
  expect(lstatSync(path).isSocket()).toBe(true)
})

test("a plain file at the socket path is left alone", async () => {
  const path = join(folder(), "core.sock")
  writeFileSync(path, "not a socket")
  await expect(clearStaleSocket(path)).rejects.toBeInstanceOf(SocketPathOccupied)
  expect(readFileSync(path, "utf8")).toBe("not a socket")
})

test("a folder at the socket path is left alone", async () => {
  const path = join(folder(), "core.sock")
  mkdirSync(path)
  await expect(clearStaleSocket(path)).rejects.toThrow(/folder/)
  expect(lstatSync(path).isDirectory()).toBe(true)
})

test("a symlink at the socket path is left alone, and not followed", async () => {
  const dir = folder()
  const target = join(dir, "precious")
  writeFileSync(target, "keep me")
  const path = join(dir, "core.sock")
  symlinkSync(target, path)
  await expect(clearStaleSocket(path)).rejects.toThrow(/symlink/)
  expect(lstatSync(path).isSymbolicLink()).toBe(true)
  expect(readFileSync(target, "utf8")).toBe("keep me")
})

test("answers is false for a path with nothing there", async () => {
  expect(await answers(join(folder(), "none.sock"))).toBe(false)
})

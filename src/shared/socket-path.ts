// The socket rules. With the instance lock held, a socket at the core's path is either a
// core started without the lock, or a dead core's. Only a socket nobody answers on is removed; a file,
// folder or symlink at the path is never touched.
import { lstat, rm } from "node:fs/promises"
import { createConnection } from "node:net"
import { CoreAlreadyRunningError } from "./lock"

export class SocketPathOccupied extends Error {
  constructor(readonly socketPath: string, readonly kind: string) {
    super(`${socketPath} is a ${kind}, not a socket; refusing to remove it`)
    this.name = "SocketPathOccupied"
  }
}

export async function clearStaleSocket(path: string): Promise<void> {
  let info
  try {
    info = await lstat(path) // lstat: a symlink is reported as one, never followed
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
  if (!info.isSocket()) {
    throw new SocketPathOccupied(path, info.isSymbolicLink() ? "symlink" : info.isDirectory() ? "folder" : "file")
  }
  if (await answers(path)) throw new CoreAlreadyRunningError(undefined, path)
  await rm(path)
}

/** Whether something accepts a connection at `path` within half a second. */
export function answers(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createConnection(path)
    const done = (alive: boolean) => {
      s.destroy()
      resolve(alive)
    }
    s.once("connect", () => done(true))
    s.once("error", () => done(false))
    setTimeout(() => done(false), 500).unref()
  })
}

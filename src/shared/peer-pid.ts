// The pid of the process at the other end of a Unix socket, from the kernel, never from the client's
// say-so. The prompt pane's ticket is redeemed only by the launcher the view started: the view names its
// pid, and the core checks the connection's peer against it.
//
// Node and Bun have no call for it, so it's getsockopt through bun:ffi: SO_PEERCRED on Linux (a
// `struct ucred`, pid first), LOCAL_PEERPID on macOS (a pid_t). The socket's descriptor is Bun's
// `_handle.fd`, checked for at run time. Anything unreadable is undefined, and the caller refuses.
import { dlopen, FFIType, ptr } from "bun:ffi"
import type { Socket } from "node:net"

const LINUX = { lib: "libc.so.6", level: 1 /* SOL_SOCKET */, option: 17 /* SO_PEERCRED */, bytes: 12 }
const DARWIN = { lib: "libSystem.B.dylib", level: 0 /* SOL_LOCAL */, option: 2 /* LOCAL_PEERPID */, bytes: 4 }

type GetSockOpt = (fd: number, level: number, option: number, value: ReturnType<typeof ptr>, length: ReturnType<typeof ptr>) => number

let getsockopt: GetSockOpt | null | undefined

function load(): GetSockOpt | null {
  if (getsockopt !== undefined) return getsockopt
  const which = process.platform === "darwin" ? DARWIN : process.platform === "linux" ? LINUX : undefined
  try {
    if (!which) throw new Error("unsupported platform")
    const lib = dlopen(which.lib, { getsockopt: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 } })
    getsockopt = lib.symbols.getsockopt as unknown as GetSockOpt
  } catch {
    getsockopt = null
  }
  return getsockopt
}

/** The descriptor under a net.Socket, where Bun exposes it. */
export function socketFd(socket: Socket): number | undefined {
  const fd = (socket as unknown as { _handle?: { fd?: unknown } })._handle?.fd
  return typeof fd === "number" && Number.isInteger(fd) && fd >= 0 ? fd : undefined
}

/** The peer's pid on a connected Unix socket, or undefined when the kernel can't say. */
export function peerPid(socket: Socket): number | undefined {
  const fd = socketFd(socket)
  const call = load()
  if (fd === undefined || call === null) return undefined
  const which = process.platform === "darwin" ? DARWIN : LINUX
  const value = new Int32Array(3)
  const length = new Uint32Array([which.bytes])
  if (call(fd, which.level, which.option, ptr(value), ptr(length)) !== 0) return undefined
  const pid = value[0]!
  return pid > 0 ? pid : undefined
}

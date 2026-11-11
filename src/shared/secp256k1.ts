// An EVM wallet's address from a value that may be its private key: the key's point on secp256k1, then the last
// 20 bytes of Keccak-256 of that point. Bun's crypto has no secp256k1, so the point is worked out here, with
// BigInt. It only ever answers "whose address would this be"; it never signs, so it needn't run in constant
// time. A table of the generator's multiples, made once on first use, keeps each answer to at most 64 additions.
import { keccak256 } from "./keccak"

export const CURVE: { readonly p: bigint; readonly n: bigint; readonly gx: bigint; readonly gy: bigint } = {
  p: 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn,
  n: 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n,
  gx: 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
  gy: 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n,
}
const P = CURVE.p

interface Affine {
  x: bigint
  y: bigint
}
interface Jacobian {
  x: bigint
  y: bigint
  z: bigint
}

const mod = (a: bigint): bigint => {
  const r = a % P
  return r < 0n ? r + P : r
}

function inverse(a: bigint): bigint {
  let r0 = mod(a)
  let r1 = P
  let s0 = 1n
  let s1 = 0n
  while (r1 !== 0n) {
    const q = r0 / r1
    ;[r0, r1] = [r1, r0 - q * r1]
    ;[s0, s1] = [s1, s0 - q * s1]
  }
  return mod(s0)
}

/** 2·Q, for a curve with a = 0. */
function double(q: Jacobian): Jacobian | undefined {
  if (q.y === 0n) return undefined
  const a = mod(q.x * q.x)
  const b = mod(q.y * q.y)
  const c = mod(b * b)
  const d = mod(2n * (mod((q.x + b) * (q.x + b)) - a - c))
  const e = mod(3n * a)
  const x = mod(e * e - 2n * d)
  return { x, y: mod(e * (d - x) - 8n * c), z: mod(2n * q.y * q.z) }
}

/** Q + R, R in affine form; undefined is the point at infinity. */
function addAffine(q: Jacobian | undefined, r: Affine): Jacobian | undefined {
  if (!q) return { x: r.x, y: r.y, z: 1n }
  const zz = mod(q.z * q.z)
  const u2 = mod(r.x * zz)
  const s2 = mod(r.y * q.z * zz)
  const h = mod(u2 - q.x)
  const rr = mod(2n * (s2 - q.y))
  if (h === 0n) return rr === 0n ? double(q) : undefined
  const hh = mod(h * h)
  const i = mod(4n * hh)
  const j = mod(h * i)
  const v = mod(q.x * i)
  const x = mod(rr * rr - j - 2n * v)
  return { x, y: mod(rr * (v - x) - 2n * q.y * j), z: mod((q.z + h) * (q.z + h) - zz - hh) }
}

function toAffine(q: Jacobian): Affine {
  const zi = inverse(q.z)
  const zi2 = mod(zi * zi)
  return { x: mod(q.x * zi2), y: mod(q.y * zi2 * zi) }
}

/** table[w][d - 1] = d · 16^w · G, for d from 1 to 15. */
let table: Affine[][] | undefined

function generatorTable(): Affine[][] {
  if (table) return table
  const out: Affine[][] = []
  let base: Affine = { x: CURVE.gx, y: CURVE.gy }
  for (let w = 0; w < 64; w++) {
    const row: Affine[] = []
    let acc: Jacobian | undefined
    for (let d = 1; d <= 15; d++) {
      acc = addAffine(acc, base)
      row.push(toAffine(acc!))
    }
    out.push(row)
    base = toAffine(addAffine(acc, base)!)
  }
  table = out
  return out
}

/** The public point of a 32-byte private key; undefined when it's no key (zero, or not below the group's order). */
export function publicPoint(key: Uint8Array): Affine | undefined {
  if (key.length !== 32) return undefined
  const k = BigInt(`0x${Buffer.from(key).toString("hex")}`)
  if (k === 0n || k >= CURVE.n) return undefined
  const t = generatorTable()
  let acc: Jacobian | undefined
  for (let w = 0; w < 64; w++) {
    const digit = Number((k >> BigInt(4 * w)) & 15n)
    if (digit !== 0) acc = addAffine(acc, t[w]![digit - 1]!)
  }
  return acc ? toAffine(acc) : undefined
}

/** The EVM address (`0x` and 40 lower-case hex digits) whose private key `key` would be; undefined when it's no key. */
export function evmAddressOf(key: Uint8Array): string | undefined {
  const point = publicPoint(key)
  if (!point) return undefined
  const xy = Buffer.from(point.x.toString(16).padStart(64, "0") + point.y.toString(16).padStart(64, "0"), "hex")
  return `0x${keccak256(xy).subarray(12).toString("hex")}`
}

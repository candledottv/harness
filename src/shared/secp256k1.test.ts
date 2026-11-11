import { expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { CURVE, evmAddressOf, publicPoint } from "./secp256k1"

const scalar = (n: bigint) => Buffer.from(n.toString(16).padStart(64, "0"), "hex")
const onCurve = (x: bigint, y: bigint) => (y * y - (x * x * x + 7n)) % CURVE.p === 0n

test("the smallest keys give the addresses every EVM library gives them", () => {
  expect(evmAddressOf(scalar(1n))).toBe("0x7e5f4552091a69125d5dfcb7b8c2659029395bdf")
  expect(evmAddressOf(scalar(2n))).toBe("0x2b5ad5c4795c026514f8317c7a215e218dccd6cf")
  expect(evmAddressOf(scalar(3n))).toBe("0x6813eb9362372eef6200f3b1dbc3f819671cba69")
})

test("the public point: 1 is the generator, n − 1 its negation, and any key's point is on the curve and one step from the key before it", () => {
  expect(publicPoint(scalar(1n))).toEqual({ x: CURVE.gx, y: CURVE.gy })
  expect(publicPoint(scalar(CURVE.n - 1n))).toEqual({ x: CURVE.gx, y: CURVE.p - CURVE.gy })
  for (let i = 0; i < 8; i++) {
    const k = BigInt(`0x${randomBytes(32).toString("hex")}`) % (CURVE.n - 2n)
    const p = publicPoint(scalar(k + 1n))!
    expect(onCurve(p.x, p.y)).toBe(true)
    // (k + 2)·G − (k + 1)·G is G: the chord through Q and −P meets the curve at −G, whose x is G's.
    const q = publicPoint(scalar(k + 2n))!
    const slope = ((q.y + p.y) * modInverse(q.x - p.x)) % CURVE.p
    const x = (((slope * slope - p.x - q.x) % CURVE.p) + CURVE.p) % CURVE.p
    expect(x).toBe(CURVE.gx)
  }
})

test("zero and anything at or past the group's order are no key", () => {
  expect(publicPoint(scalar(0n))).toBeUndefined()
  expect(publicPoint(scalar(CURVE.n))).toBeUndefined()
  expect(publicPoint(Buffer.alloc(32, 0xff))).toBeUndefined()
  expect(publicPoint(Buffer.alloc(31, 1))).toBeUndefined()
})

function modInverse(a: bigint): bigint {
  let [r0, r1] = [((a % CURVE.p) + CURVE.p) % CURVE.p, CURVE.p]
  let [s0, s1] = [1n, 0n]
  while (r1 !== 0n) {
    const q = r0 / r1
    ;[r0, r1] = [r1, r0 - q * r1]
    ;[s0, s1] = [s1, s0 - q * s1]
  }
  return ((s0 % CURVE.p) + CURVE.p) % CURVE.p
}

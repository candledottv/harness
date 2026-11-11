// Keccak-256, the hash an EVM address is taken from: the reference Keccak-f[1600] permutation over 32-bit halves
// of each 64-bit lane, with a 136-byte rate. It differs from SHA3-256 only in its padding byte (0x01, not 0x06),
// which is why node's sha3-256 can't stand in for it, and why its sponge is tested against sha3-256 with SHA3's.

const ROUND_CONSTANTS = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n, 0x000000000000808bn, 0x0000000080000001n,
  0x8000000080008081n, 0x8000000000008009n, 0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n,
  0x000000000000800an, 0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
]
const RC_LO = Uint32Array.from(ROUND_CONSTANTS, (c) => Number(c & 0xffffffffn))
const RC_HI = Uint32Array.from(ROUND_CONSTANTS, (c) => Number(c >> 32n))
/** Each lane's rotation (rho), by lane index x + 5y. */
const ROTATION = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14]
/** Where pi moves each lane: (x, y) to (y, 2x + 3y). */
const PI_TO = Array.from({ length: 25 }, (_, i) => {
  const x = i % 5
  const y = Math.floor(i / 5)
  return y + 5 * ((2 * x + 3 * y) % 5)
})
const RATE = 136

/** The permutation, on 25 lanes held as low and high 32-bit halves (lane i at 2i and 2i + 1). */
function permute(s: Uint32Array): void {
  const cLo = new Uint32Array(5)
  const cHi = new Uint32Array(5)
  const bLo = new Uint32Array(25)
  const bHi = new Uint32Array(25)
  for (let round = 0; round < 24; round++) {
    // Theta: each column's parity, mixed into its neighbours.
    for (let x = 0; x < 5; x++) {
      cLo[x] = s[2 * x]! ^ s[2 * (x + 5)]! ^ s[2 * (x + 10)]! ^ s[2 * (x + 15)]! ^ s[2 * (x + 20)]!
      cHi[x] = s[2 * x + 1]! ^ s[2 * (x + 5) + 1]! ^ s[2 * (x + 10) + 1]! ^ s[2 * (x + 15) + 1]! ^ s[2 * (x + 20) + 1]!
    }
    for (let x = 0; x < 5; x++) {
      const nLo = cLo[(x + 1) % 5]!
      const nHi = cHi[(x + 1) % 5]!
      const dLo = cLo[(x + 4) % 5]! ^ ((nLo << 1) | (nHi >>> 31))
      const dHi = cHi[(x + 4) % 5]! ^ ((nHi << 1) | (nLo >>> 31))
      for (let y = 0; y < 25; y += 5) {
        s[2 * (x + y)] = s[2 * (x + y)]! ^ dLo
        s[2 * (x + y) + 1] = s[2 * (x + y) + 1]! ^ dHi
      }
    }
    // Rho and pi: each lane rotated, then moved.
    for (let i = 0; i < 25; i++) {
      const lo = s[2 * i]!
      const hi = s[2 * i + 1]!
      const r = ROTATION[i]!
      const to = PI_TO[i]!
      if (r === 0) {
        bLo[to] = lo
        bHi[to] = hi
      } else if (r < 32) {
        bLo[to] = (lo << r) | (hi >>> (32 - r))
        bHi[to] = (hi << r) | (lo >>> (32 - r))
      } else if (r === 32) {
        bLo[to] = hi
        bHi[to] = lo
      } else {
        const m = r - 32
        bLo[to] = (hi << m) | (lo >>> (32 - m))
        bHi[to] = (lo << m) | (hi >>> (32 - m))
      }
    }
    // Chi: each row mixed with the two lanes after it.
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) {
        const a = y + x
        const b = y + ((x + 1) % 5)
        const c = y + ((x + 2) % 5)
        s[2 * a] = bLo[a]! ^ (~bLo[b]! & bLo[c]!)
        s[2 * a + 1] = bHi[a]! ^ (~bHi[b]! & bHi[c]!)
      }
    }
    // Iota.
    s[0] = s[0]! ^ RC_LO[round]!
    s[1] = s[1]! ^ RC_HI[round]!
  }
}

/** The 256-bit sponge with the given padding byte: 0x01 is Keccak's, 0x06 SHA3's. */
export function keccakSponge(input: Uint8Array, pad: number): Buffer {
  const s = new Uint32Array(50)
  const bytes = new Uint8Array(s.buffer)
  const little = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1
  // Lanes are little-endian: on a big-endian machine each 32-bit half's bytes are read reversed.
  const at = (i: number) => (little ? i : (i & ~3) | (3 - (i & 3)))
  let off = 0
  for (; off + RATE <= input.length; off += RATE) {
    for (let i = 0; i < RATE; i++) bytes[at(i)] = bytes[at(i)]! ^ input[off + i]!
    permute(s)
  }
  const rest = input.length - off
  for (let i = 0; i < rest; i++) bytes[at(i)] = bytes[at(i)]! ^ input[off + i]!
  bytes[at(rest)] = bytes[at(rest)]! ^ pad
  bytes[at(RATE - 1)] = bytes[at(RATE - 1)]! ^ 0x80
  permute(s)
  const out = Buffer.alloc(32)
  for (let i = 0; i < 32; i++) out[i] = bytes[at(i)]!
  return out
}

/** Keccak-256 of `input`. */
export function keccak256(input: Uint8Array): Buffer {
  return keccakSponge(input, 0x01)
}

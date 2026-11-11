import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { keccak256, keccakSponge } from "./keccak"

test("Keccak-256 matches its published values", () => {
  expect(keccak256(Buffer.alloc(0)).toString("hex")).toBe("c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470")
  expect(keccak256(Buffer.from("abc")).toString("hex")).toBe("4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45")
  // A function selector is the first four bytes of its signature's hash.
  expect(keccak256(Buffer.from("transfer(address,uint256)")).subarray(0, 4).toString("hex")).toBe("a9059cbb")
})

test("the sponge absorbs any length: with SHA3's padding it matches SHA3-256 across one block, its edge and several", () => {
  for (const n of [0, 1, 55, 135, 136, 137, 271, 272, 273, 1000, 5000]) {
    const input = Buffer.from(Array.from({ length: n }, (_, i) => (i * 31 + 7) & 0xff))
    expect(keccakSponge(input, 0x06).toString("hex")).toBe(createHash("sha3-256").update(input).digest("hex"))
  }
})

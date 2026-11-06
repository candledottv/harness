// The docs' pictures are drawn from their kept frames, light from dark by role, and the check catches one that's stale.
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BUILT_IN, CANDLE_DARK, CANDLE_LIGHT, type Colours } from "../src/view/theme"
import { DEMO_SIZE, DEMO_STEPS, FRAMES_DIR, parseFrame, PICTURES, pictureProblems, README_DIR, README_PICTURES, renderAnimation, renderPictures, renderSvg, SHADES, TO_LIGHT, writePictures } from "./doc-images"

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})
const pictures = renderPictures()
const frame = (name: string) => parseFrame(readFileSync(join(FRAMES_DIR, `${name}.txt`), "utf8"))

describe("the docs' pictures", () => {
  test("each is drawn from a kept frame, in both shades, under 400 KB, with its words for a reader who can't see it", () => {
    expect(new Set(PICTURES.map((p) => p.name)).size).toBe(PICTURES.length)
    for (const p of PICTURES) {
      expect(existsSync(join(FRAMES_DIR, `${p.frame}.txt`))).toBe(true)
      for (const shade of ["dark", "light"]) {
        const svg = pictures[`${p.name}-${shade}.svg`]!
        expect(svg.length).toBeLessThan(400_000)
        expect(svg).toContain(`<title>${p.alt.replace(/&/g, "&amp;")}</title>`)
        expect(svg).toContain(`from test/fixtures/frames/${p.frame}.txt, in Candle ${shade}`)
      }
    }
  })

  test("Candle light's picture of a scene is the kept light frame of it: the dark frame's colours swapped by role", () => {
    for (const [dark, light] of [
      ["theme-candle-dark-140x40", "theme-candle-light-140x40"],
      ["theme-candle-dark-140x40-kill", "theme-candle-light-140x40-kill"],
    ] as const) {
      const d = frame(dark)
      const l = frame(light)
      const wrong: string[] = []
      d.forEach((row, y) =>
        row.forEach((c, x) => {
          const k = l[y]![x]!
          if (c.ch !== k.ch) wrong.push(`${x},${y}: ${c.ch} against ${k.ch}`)
          if (TO_LIGHT.get(c.bg) !== k.bg) wrong.push(`${x},${y}: bg ${c.bg} makes ${TO_LIGHT.get(c.bg)}, kept ${k.bg}`)
          if (c.ch !== " " && TO_LIGHT.get(c.fg) !== k.fg) wrong.push(`${x},${y}: fg ${c.fg} makes ${TO_LIGHT.get(c.fg)}, kept ${k.fg}`)
        }),
      )
      expect(wrong.slice(0, 5)).toEqual([])
    }
  })

  test("roles that share a colour in Candle dark share one in Candle light, so the swap is one colour for one", () => {
    const dark = BUILT_IN[CANDLE_DARK]!
    const light = BUILT_IN[CANDLE_LIGHT]!
    const roles = Object.keys(dark) as (keyof Colours)[]
    for (const a of roles) for (const b of roles) if (dark[a].toLowerCase() === dark[b].toLowerCase()) expect(`${a}/${b}: ${light[a]}`).toBe(`${a}/${b}: ${light[b]}`)
  })

  test("a colour that isn't Candle dark's has no light shade, and is refused rather than guessed", () => {
    const odd = parseFrame("x\n--- colours ---\n0: 123456/0b0d10×1\n")
    expect(() => renderSvg(odd, "light", { frame: "odd", alt: "odd" })).toThrow("#123456 isn't one of Candle dark's colours")
    expect(renderSvg(odd, "dark", { frame: "odd", alt: "odd" })).toContain("<svg")
  })

  test("box, block, braille and copy characters are shapes, never text a font may lack", () => {
    for (const svg of Object.values(pictures)) {
      const text = [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]).join("")
      expect(text).not.toMatch(/[─│┃╭╮╰╯╵╷╹╻╿╽▁-█▌▐⠀-⣿⧉]/)
    }
    const drawn = renderSvg(parseFrame("╭⧉⣿▄\n--- colours ---\n0: c9cfd9/111419×4\n"), "dark", { frame: "x", alt: "x" })
    expect(drawn).toContain("<path d=")
    expect(drawn.match(/<circle cx/g)!.length).toBe(3 + 8)
    expect(drawn).toContain('<rect x="41" y="37" width="9" height="9" fill="currentColor"/>')
    expect(drawn).not.toContain("<text")
  })

  test("written into a folder they pass the check; one edited or missing fails it", () => {
    const dir = mkdtempSync(join(tmpdir(), "doc-images-"))
    dirs.push(dir)
    expect(writePictures(dir).length).toBe(PICTURES.length * 2 + 2)
    expect(pictureProblems(dir)).toEqual([])
    writeFileSync(join(dir, "trade-dark.svg"), readFileSync(join(dir, "trade-dark.svg"), "utf8").replace("agent-a", "agent-z"))
    unlinkSync(join(dir, "pnl-light.svg"))
    expect(pictureProblems(dir)).toEqual(["trade-dark.svg isn't what its frame draws now: run bun scripts/doc-images.ts --write", "pnl-light.svg is missing"])
  })

  test("the docs site takes the dark shade alone, and its check asks for no light picture", () => {
    const dir = mkdtempSync(join(tmpdir(), "doc-images-"))
    dirs.push(dir)
    const written = writePictures(dir, ["dark"])
    expect(written.length).toBe(PICTURES.length + 1)
    expect(written.every((f) => f.endsWith("-dark.svg"))).toBe(true)
    expect(pictureProblems(dir, ["dark"])).toEqual([])
    expect(pictureProblems(dir)).toContain("trade-light.svg is missing")
  })

  test("the README's moving picture, in both shades, is what the frames draw now", () => {
    expect(pictureProblems(README_DIR, SHADES, README_PICTURES)).toEqual([])
    expect(readdirSync(README_DIR).sort()).toEqual([...README_PICTURES])
    const readme = readFileSync(join(import.meta.dir, "../README.md"), "utf8")
    for (const file of README_PICTURES) expect(readme).toContain(`.github/readme/${file}`)
  })

  test("the moving picture: every step a kept frame of its size, under 2 MB in each shade", () => {
    for (const st of DEMO_STEPS) {
      const f = frame(st.frame)
      expect(`${st.frame}: ${f[0]!.length}x${f.length}`).toBe(`${st.frame}: ${DEMO_SIZE[0]}x${DEMO_SIZE[1]}`)
    }
    for (const shade of ["dark", "light"]) expect(pictures[`demo-${shade}.svg`]!.length).toBeLessThan(2_000_000)
  })

  test("each step shows from its own time to the end of the loop, drawing only the rows it changed over the one before", () => {
    const frames = DEMO_STEPS.map((st) => frame(st.frame))
    const svg = renderAnimation(frames, DEMO_STEPS, "dark", "x")
    const total = DEMO_STEPS.reduce((sum, st) => sum + st.ms, 0)
    let at = 0
    DEMO_STEPS.forEach((st, k) => {
      if (k > 0) {
        expect(svg).toContain(`.s${k}{animation:s${k} ${total}ms step-end infinite}@keyframes s${k}{0%{opacity:0}${Math.round((at / total) * 10000) / 100}%{opacity:1}}`)
        const group = svg.slice(svg.indexOf(`<g class="s${k}">`), k + 1 < DEMO_STEPS.length ? svg.indexOf(`<g class="s${k + 1}">`) : svg.indexOf("</svg>"))
        const changed = frames[k]!.filter((row, y) => JSON.stringify(row) !== JSON.stringify(frames[k - 1]![y])).length
        expect(`step ${k}: ${(group.match(new RegExp(`<rect class="c\\d+" x="14" y="\\d+" width="${DEMO_SIZE[0] * 9}" height="18"/>`, "g")) ?? []).length >= changed}`).toBe(`step ${k}: true`)
        expect(changed).toBeGreaterThan(0)
      }
      at += st.ms
    })
  })
})

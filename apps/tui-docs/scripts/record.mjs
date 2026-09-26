/** Execute the docs' scripts in the actual TUI. Cache only after every assertion succeeds. */
import xterm from "@xterm/headless"
import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"
import { runtimeInputs } from "./inputs.mjs"
import { parseScripts } from "./scripts.mjs"
const here = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  root = resolve(here, "../.."),
  tuiRoot = join(root, "apps/tui")
const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((e) =>
    ["node_modules", ".git", ".astro", ".cache", "dist"].includes(e.name)
      ? []
      : e.isDirectory()
      ? walk(join(dir, e.name))
      : [join(dir, e.name)]
  )
const scripts = new Map()
for (const file of walk(join(tuiRoot, "docs")).filter((f) => f.endsWith(".md"))) {
  for (const script of parseScripts(readFileSync(file, "utf8"))) {
    const previous = scripts.get(script.id)
    if (previous && JSON.stringify(previous) !== JSON.stringify(script)) {
      throw new Error(`Conflicting recording ${script.id}`)
    }
    scripts.set(script.id, script)
  }
}
const output = join(here, "public/recordings"), cache = join(here, ".cache/recordings")
mkdirSync(output, { recursive: true })
mkdirSync(cache, { recursive: true })
const hash = createHash("sha256")
// Source bytes, fixture, lockfile, capture code, and tool versions all invalidate the local artifact cache.
for (
  const file of [
    ...runtimeInputs().map((file) => join(root, file)),
    ...walk(join(here, "scripts")),
    join(tuiRoot, "test/fixtures/fix-add.jsonl"),
    join(root, "pnpm-lock.yaml")
  ]
) {
  hash.update(file.slice(root.length))
  hash.update(readFileSync(file))
}
const bun = process.env.SMITHERS_DOCS_BUN || "bun", ffmpeg = process.env.FFMPEG || "ffmpeg"
for (const [tool, args] of [[bun, ["--version"]], [ffmpeg, ["-version"]], ["python3", ["--version"]]]) {
  const result = spawnSync(tool, args, { encoding: "utf8" })
  if (result.status !== 0) throw new Error(`Recording requires ${tool}`)
  hash.update(result.stdout.split("\n")[0])
}
hash.update(process.version + process.platform + process.arch)
const base = hash.digest("hex")
const keys = {
  Enter: "\r",
  "Ctrl+T": "\x14",
  "Ctrl+S": "\x13",
  "Ctrl+O": "\x0f",
  Home: "\x1b[H",
  End: "\x1b[F",
  Escape: "\x1b",
  ArrowLeft: "\x1b[D",
  ArrowRight: "\x1b[C"
}
const escape = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// Remove assets whose script was removed; retain the committed directory marker.
for (const file of readdirSync(output)) {
  if (file !== ".gitkeep" && !scripts.has(file.replace(/\.(gif|png|txt|json)$/, ""))) rmSync(join(output, file))
}
let browser
try {
  for (const script of scripts.values()) {
    const digest = createHash("sha256").update(base).update(JSON.stringify(script)).digest("hex")
    const dir = join(cache, digest), receiptFile = join(dir, "receipt.json")
    const valid = () => {
      if (!existsSync(receiptFile)) return false
      let receipt
      try {
        receipt = JSON.parse(readFileSync(receiptFile, "utf8"))
      } catch {
        return false
      }
      return ["gif", "txt", "png"].every((ext) =>
        existsSync(join(dir, `demo.${ext}`)) &&
        createHash("sha256").update(readFileSync(join(dir, `demo.${ext}`))).digest("hex") === receipt[ext]
      )
    }
    if (!valid()) {
      console.log(`record ${script.id}`)
      const scratch = mkdtempSync(join(tmpdir(), "smithers-docs-")),
        work = join(scratch, "workspace"),
        frames = join(scratch, "frames")
      mkdirSync(work)
      mkdirSync(frames)
      writeFileSync(join(work, "math.js"), "export const add = (a, b) => a - b\n")
      writeFileSync(
        join(work, "check.mjs"),
        "import { add } from \"./math.js\"\nif (add(2,3) !== 5) { console.error(\"add is wrong\"); process.exit(1) }\nconsole.log(\"ok\")\n"
      )
      const terminal = new xterm.Terminal({ cols: 100, rows: 28, allowProposedApi: true })
      const child = spawn("python3", [join(here, "scripts/terminal_capture.py")], { stdio: ["pipe", "pipe", "pipe"] })
      let stderr = "", stopped = false
      child.stderr.on("data", (b) => {
        stderr += b
      })
      const closed = new Promise((resolve) =>
        child.on("exit", () => {
          stopped = true
          resolve()
        })
      )
      createInterface({ input: child.stdout }).on("line", (line) => {
        terminal.write(Buffer.from(JSON.parse(line).data, "base64"))
      })
      child.stdin.write(
        JSON.stringify({
          cwd: work,
          argv: [bun, join(tuiRoot, "src/main.tsx"), work],
          env: {
            PATH: process.env.PATH,
            HOME: scratch,
            TMPDIR: scratch,
            TERM: "xterm-256color",
            COLORTERM: "truecolor",
            SMITHERS_TUI_REPLAY: join(tuiRoot, "test/fixtures/fix-add.jsonl"),
            SMITHERS_TUI_REPLAY_SPEED: "20",
            SMITHERS_TUI_SESSION_DIR: join(scratch, "sessions")
          }
        }) + "\n"
      )
      const screen = () =>
        Array.from(
          { length: 28 },
          (_, i) => terminal.buffer.active.getLine(terminal.buffer.active.viewportY + i)?.translateToString(true) ?? ""
        ).join("\n")
      const until = async (text) => {
        const end = Date.now() + 120_000
        while (!screen().includes(text)) {
          if (stopped || Date.now() > end) throw new Error(`Waiting for ${text}: ${stderr}\n${screen()}`)
          await sleep(100)
        }
      }
      const send = (data) => child.stdin.write(JSON.stringify({ input: Buffer.from(data).toString("base64") }) + "\n")
      const captured = []
      try {
        await until("↑")
        // Startup notices settle before the first documentation frame.
        await sleep(4500)
        if (!browser) {
          browser = await chromium.launch({
            headless: true,
            ...(process.env.CHROME_BIN
              ? { executablePath: process.env.CHROME_BIN }
              : process.platform === "darwin"
              ? { executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" }
              : {})
          })
        }
        const page = await browser.newPage({ viewport: { width: 880, height: 480 }, deviceScaleFactor: 1 })
        const capture = async (label) => {
          await sleep(200)
          const buffer = terminal.buffer.active, rows = []
          for (let row = 0; row < 28; row++) {
            let html = ""
            const line = buffer.getLine(buffer.viewportY + row)
            for (let col = 0; col < 100; col++) {
              const cell = line?.getCell(col)
              if (!cell || cell.getWidth() === 0) continue
              const fg = cell.isFgRGB() ? `#${cell.getFgColor().toString(16).padStart(6, "0")}` : "#d6deeb"
              const bg = cell.isBgRGB() ? `#${cell.getBgColor().toString(16).padStart(6, "0")}` : "transparent"
              html += `<span style="color:${fg};background:${bg}">${escape(cell.getChars() || " ")}</span>`
            }
            rows.push(html)
          }
          await page.setContent(
            `<body style="margin:0;background:#011627;color:#d6deeb"><pre style="margin:0;padding:10px;font:13px/16px Menlo,monospace">${
              rows.join("\n")
            }</pre>`
          )
          await page.screenshot({ path: join(frames, `${String(captured.length).padStart(3, "0")}.png`) })
          captured.push(`${label}\n${screen()}`)
        }
        for (const step of script.steps) {
          if (step.kind === "Type") {
            send(step.value)
            await sleep(150)
          }
          if (step.kind === "Press") {
            send(keys[step.value])
            await sleep(200)
            if (step.value === "Enter") await capture("Requested")
          }
          if (step.kind === "Wait for") await until(step.value)
          if (step.kind === "Capture") await capture(step.value)
        }
        if (spawnSync(process.execPath, ["check.mjs"], { cwd: work }).status !== 0) {
          throw new Error("The recorded agent did not fix the check")
        }
        await page.close()
        const staging = mkdtempSync(join(cache, `${digest}.`))
        const encoded = spawnSync(ffmpeg, [
          "-v",
          "error",
          "-y",
          "-framerate",
          "1/2",
          "-i",
          join(frames, "%03d.png"),
          "-filter_complex",
          "split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse",
          "-loop",
          "0",
          join(staging, "demo.gif")
        ], { encoding: "utf8" })
        if (encoded.status !== 0) throw new Error(encoded.stderr)
        writeFileSync(join(staging, "demo.txt"), captured.join("\n\n"))
        copyFileSync(join(frames, `${String(captured.length - 1).padStart(3, "0")}.png`), join(staging, "demo.png"))
        const receipt = {
          digest,
          script: script.id,
          ...Object.fromEntries(
            ["gif", "txt", "png"].map(
              (ext) => [ext, createHash("sha256").update(readFileSync(join(staging, `demo.${ext}`))).digest("hex")]
            )
          )
        }
        writeFileSync(join(staging, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n")
        rmSync(dir, { recursive: true, force: true })
        renameSync(staging, dir)
      } finally {
        child.stdin.end()
        const timer = setTimeout(() => child.kill("SIGTERM"), 5000)
        await closed
        clearTimeout(timer)
        terminal.dispose()
        rmSync(scratch, { recursive: true, force: true })
      }
    } else console.log(`cache hit ${script.id}`)
    for (const ext of ["gif", "txt", "png"]) copyFileSync(join(dir, `demo.${ext}`), join(output, `${script.id}.${ext}`))
    copyFileSync(receiptFile, join(output, `${script.id}.json`))
  }
} finally {
  await browser?.close()
}

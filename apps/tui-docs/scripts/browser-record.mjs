/** Record the real browser playground; only its provider transport is a controlled fixture. */
import { fork, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { once } from "node:events"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs"
import { join } from "node:path"
import { chromium } from "playwright"
const digestOf = (bytes) => createHash("sha256").update(bytes).digest("hex")
export async function recordBrowser({ scripts, base, here, output, cache, ffmpeg }) {
  let server, browser, origin
  try {
    for (const script of scripts) {
      const digest = digestOf(base + JSON.stringify(script)), dir = join(cache, digest)
      let receipt
      try {
        receipt = JSON.parse(readFileSync(join(dir, "receipt.json"), "utf8"))
      } catch {}
      const valid = receipt &&
        ["gif", "png", "txt"].every((ext) =>
          existsSync(join(dir, `demo.${ext}`)) && digestOf(readFileSync(join(dir, `demo.${ext}`))) === receipt[ext]
        )
      if (!valid) {
        console.log(`record ${script.id}`)
        if (!server) {
          const dist = join(here, ".cache/browser-site")
          const built = spawnSync("pnpm", ["exec", "astro", "build", "--outDir", dist], { cwd: here, encoding: "utf8" })
          if (built.status !== 0) throw new Error(built.stdout + built.stderr)
          server = fork(new URL("../server/serve.mjs", import.meta.url), [], {
            env: {
              PATH: process.env.PATH,
              PORT: "0",
              HOST: "127.0.0.1",
              DOCS_DIST: dist,
              DOCS_BUDGET_DB: join(here, ".cache/browser-record.sqlite")
            },
            stdio: ["ignore", "ignore", "inherit", "ipc"]
          })
          origin = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("Recording server did not start")), 20_000)
            server.once("message", (message) => {
              clearTimeout(timer)
              resolve(message.origin)
            })
            server.once("error", (error) => {
              clearTimeout(timer)
              reject(error)
            })
            server.once("exit", (code) => {
              clearTimeout(timer)
              reject(new Error(`Recording server exited ${code}`))
            })
          })
          browser = await chromium.launch({
            headless: true,
            ...(process.env.CHROME_BIN
              ? { executablePath: process.env.CHROME_BIN }
              : process.platform === "darwin"
              ? { executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" }
              : {})
          })
        }
        const staging = mkdtempSync(join(cache, `${digest}.`)), frames = join(staging, "frames")
        mkdirSync(frames)
        const page = await browser.newPage({ viewport: { width: 1360, height: 1000 }, reducedMotion: "reduce" }),
          captured = []
        try {
          const errors = []
          page.on("pageerror", (error) => errors.push(error.message))
          await page.route("**/api/playground/model", (route) =>
            route.fulfill({
              json: {
                choices: [{
                  finish_reason: "stop",
                  message: {
                    content:
                      "```cell\nawait ctx.call(\"read\", {path:\"math.js\"}); await ctx.call(\"write\", {path:\"math.js\",content:\"export const add = (a, b) => a + b\\n\"}); console.log(await ctx.call(\"check\",{})); ctx.done(\"Fixed math.js. Both checks pass.\");\n```"
                  }
                }]
              }
            }))
          await page.goto(origin)
          await page.locator("#run").waitFor()
          for (const step of script.steps) {
            if (step.kind === "Click") await page.getByRole("button", { name: step.value, exact: true }).click()
            else if (step.kind === "Fill") await page.getByLabel(step.target, { exact: true }).fill(step.value)
            else if (step.kind === "Wait for") {
              await page.waitForFunction(
                (text) => document.querySelector("#run-status")?.textContent?.includes(text),
                step.value
              )
            } else if (step.kind === "Capture") {
              await page.waitForTimeout(300)
              const subject = await page.locator("#settings").evaluate((el) => el.open)
                ? page.locator("#settings")
                : page.locator(".playground")
              await subject.screenshot({ path: join(frames, `${String(captured.length).padStart(3, "0")}.png`) })
              captured.push(`${step.value}\n${await subject.innerText()}`)
            } else throw new Error(`Unsupported browser step: ${step.kind}`)
          }
          if (errors.length) throw new Error(errors.join("\n"))
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
          copyFileSync(join(frames, `${String(captured.length - 1).padStart(3, "0")}.png`), join(staging, "demo.png"))
          writeFileSync(join(staging, "demo.txt"), captured.join("\n\n"))
          receipt = {
            digest,
            script: script.id,
            scenario: "browser",
            captions: captured.map((frame) => frame.split("\n")[0]),
            ...Object.fromEntries(
              ["gif", "png", "txt"].map((ext) => [ext, digestOf(readFileSync(join(staging, `demo.${ext}`)))])
            )
          }
          writeFileSync(join(staging, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n")
          rmSync(frames, { recursive: true })
          rmSync(dir, { recursive: true, force: true })
          renameSync(staging, dir)
        } finally {
          await page.close()
          rmSync(staging, { recursive: true, force: true })
        }
      } else console.log(`cache hit ${script.id}`)
      for (const ext of ["gif", "png", "txt"]) {
        copyFileSync(join(dir, `demo.${ext}`), join(output, `${script.id}.${ext}`))
      }
      copyFileSync(join(dir, "receipt.json"), join(output, `${script.id}.json`))
    }
  } finally {
    await browser?.close()
    if (server && server.exitCode === null) {
      const stopped = once(server, "exit")
      server.kill()
      await stopped
    }
  }
}

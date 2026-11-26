// M3 release gate over the production frontend in apps/mvp/dist: no legacy `jjhub` codename, no bundled secret or
// `.env` file, and no frame that pairs `allow-same-origin` with markup the app does not already own and document.
// It reads the build `pnpm run build` leaves behind, and builds it first when dist/ is absent.
import { spawnSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { beforeAll, describe, expect, it } from "vitest"

const MVP = fileURLToPath(new URL("..", import.meta.url))
const ROOT = join(MVP, "..", "..")
const DIST = join(MVP, "dist")

/** Every emitted file under dist/, relative to dist/. */
const files = (directory: string = DIST): ReadonlyArray<string> =>
  readdirSync(directory).flatMap((name) => {
    const path = join(directory, name)
    return statSync(path).isDirectory() ? files(path) : [relative(DIST, path)]
  })

/** The user-facing text assets: what a browser parses as script, markup or style. */
const isText = (file: string) => /\.(?:m?js|html|css|json|webmanifest|svg|txt)$/.test(file) || file === "_headers"
const isScriptOrMarkup = (file: string) => /\.(?:m?js|html)$/.test(file)

const read = (file: string) => readFileSync(join(DIST, file), "utf8")

/** Lines of `text` around each match of `pattern`, for a failure message that names the offending context. */
const contexts = (text: string, pattern: RegExp): ReadonlyArray<string> =>
  [...text.matchAll(new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`))].map((match) =>
    text.slice(Math.max(0, match.index - 80), match.index + match[0].length + 80)
  )

beforeAll(() => {
  if (existsSync(join(DIST, "index.html"))) return
  const vite = join(MVP, "node_modules", "vite", "bin", "vite.js")
  const built = spawnSync(process.execPath, [vite, "build"], { cwd: MVP, stdio: "inherit", timeout: 600_000 })
  if (built.status !== 0) throw new Error(`vite build exited ${built.status}`)
}, 660_000)

describe("apps/mvp/dist hygiene", () => {
  it("holds a real build: index.html and its script assets", () => {
    const all = files()
    expect(all).toContain("index.html")
    expect(all.filter((file) => file.startsWith("assets/") && file.endsWith(".js")).length).toBeGreaterThan(10)
  })

  it("emits no legacy jjhub codename in any JS, HTML or CSS asset", () => {
    const found = files().filter(isText).flatMap((file) =>
      contexts(read(file), /jjhub/i).map((context) => `${file}: ${context}`)
    )
    expect(found).toEqual([])
  })

  it("emits no .env file and no secret-shaped value", () => {
    expect(files().filter((file) => /(?:^|\/)\.env(?:\.|$)|(?:^|\/)\.dev\.vars$/.test(file))).toEqual([])

    // Shapes a real credential has; library code carries the PEM header alone, never a header and a body.
    const shapes: ReadonlyArray<[string, RegExp]> = [
      ["PEM private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----\s*[A-Za-z0-9+/=]{40}/],
      ["Anthropic key", /sk-ant-[A-Za-z0-9_-]{20,}/],
      ["OpenAI key", /\bsk-(?:proj-)?[A-Za-z0-9]{32,}/],
      ["GitHub token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{40,}/],
      ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
      ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
      ["Stripe secret key", /\b[sr]k_live_[A-Za-z0-9]{20,}/]
    ]
    const found = files().filter(isText).flatMap((file) => {
      const text = read(file)
      return shapes.flatMap(([name, shape]) => (shape.test(text) ? [`${file}: ${name}`] : []))
    })
    expect(found).toEqual([])
  })

  it("emits no secret value from this environment or any local .env or .dev.vars file", () => {
    const secretName = /SECRET|TOKEN|PASSWORD|PRIVATE|CREDENTIAL|API_KEY|_KEY$|^DATABASE_URL$/i
    const values = new Map<string, string>()
    for (const [name, value] of Object.entries(process.env)) {
      if (secretName.test(name) && value !== undefined && value.length >= 12) values.set(value, `env ${name}`)
    }
    for (const directory of [ROOT, MVP]) {
      for (const name of readdirSync(directory).filter((each) => /^\.env(?:\..+)?$|^\.dev\.vars$/.test(each))) {
        for (const line of readFileSync(join(directory, name), "utf8").split("\n")) {
          const pair = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*["']?([^"'\n#]*)["']?/.exec(line)
          if (pair === null || !secretName.test(pair[1]!) || pair[2]!.trim().length < 12) continue
          values.set(pair[2]!.trim(), `${relative(ROOT, join(directory, name))} ${pair[1]}`)
        }
      }
    }
    // Every emitted byte, binary included: a value can ride in any asset. Name the source, never the value.
    const found = files().flatMap((file) => {
      const bytes = readFileSync(join(DIST, file), "latin1")
      return [...values].flatMap(([value, source]) => (bytes.includes(value) ? [`${file}: ${source}`] : []))
    })
    expect(found).toEqual([])
  })

  it("emits no <iframe markup with allow-same-origin", () => {
    const found = files().filter(isScriptOrMarkup).flatMap((file) =>
      contexts(read(file), /<iframe\b[^>]*allow-same-origin/i).map((context) => `${file}: ${context}`)
    )
    expect(found).toEqual([])
  })

  // The two allow-same-origin strings the bundle owns, each pinned so a third one fails here:
  // - @smthrs/ui's WEB_PAGE_SANDBOX, which frames only https pages of another site (src/features/web/url.ts,
  //   docs/features/web-pages.md#security) under `frame-src https:` and an app that refuses to be framed;
  // - CodeMirror's HTML completion table, which lists the iframe sandbox tokens as attribute values.
  it("carries allow-same-origin only in WebPageView's cross-site sandbox and CodeMirror's attribute table", () => {
    const owned = [
      /allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox/g,
      /sandbox:\[[`'"]allow-top-navigation[`'"],[`'"]allow-same-origin[`'"]/g
    ]
    const stray = files().filter(isScriptOrMarkup).flatMap((file) => {
      const text = owned.reduce((rest, pattern) => rest.replace(pattern, ""), read(file))
      return contexts(text, /allow-same-origin/).map((context) => `${file}: ${context}`)
    })
    expect(stray).toEqual([])
    const sandbox = new RegExp(owned[0]!.source)
    const sandboxes = files().filter(isScriptOrMarkup).filter((file) => sandbox.test(read(file)))
    expect(sandboxes.length).toBe(1)
  })
})

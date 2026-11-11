import { spawnSync } from "node:child_process"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { describe, expect, test } from "vitest"
import { digestOf, validationErrors } from "../scripts/refresh-failure-codes.mjs"

const sourceScript = fileURLToPath(new URL("../scripts/refresh-failure-codes.mjs", import.meta.url))

const fixture = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "smithers rpc failure codes-")))
  const script = join(root, "packages", "rpc", "scripts", "refresh-failure-codes.mjs")
  const source = join(root, "plue", "docs", "failure-codes.json")
  const vendored = join(root, "packages", "rpc", "src", "plue-failure-codes.json")
  const generated = join(root, "packages", "rpc", "src", "PlueFailureCodes.ts")
  for (const path of [script, source, vendored]) mkdirSync(dirname(path), { recursive: true })
  copyFileSync(sourceScript, script)
  const codes = [{ code: "quota_exceeded", fault: "wait", status: 429, retry_after: 60, doc: "Account cap" }]
  const document = { schema_version: 1, digest: digestOf(codes), faults: ["wait"], codes }
  const text = `${JSON.stringify(document)}\n`
  writeFileSync(source, text)
  const run = (...args: ReadonlyArray<string>) =>
    spawnSync(process.execPath, [script, ...args], { encoding: "utf8", timeout: 5_000 })
  return { root, source, plue: join(root, "plue"), vendored, generated, text, document, run }
}

describe("failure-code refresh CLI", () => {
  test.each(["C:\\missing\\failure-codes.json", "C:/missing/failure-codes.json"])(
    "treats the absolute drive path %s as a file rather than a URL scheme",
    (path) => {
      const files = fixture()
      try {
        const result = files.run("--from", path)
        expect(result.status).toBe(1)
        expect(result.stderr).toContain("ENOENT")
        expect(result.stderr).not.toContain("only https:// URLs or local files are read")
      } finally {
        rmSync(files.root, { recursive: true, force: true })
      }
    }
  )

  test("refuses to write without --from and writes nothing", () => {
    const files = fixture()
    try {
      const refused = files.run()
      expect(refused.status).toBe(1)
      expect(refused.stderr).toContain("--from")
      expect(existsSync(files.vendored)).toBe(false)
      expect(existsSync(files.generated)).toBe(false)
    } finally {
      rmSync(files.root, { recursive: true, force: true })
    }
  })

  test("writes a faithful vendored document and checks both generated artifacts without modifying them", () => {
    const files = fixture()
    try {
      const refresh = files.run("--from", files.plue)
      expect(refresh.status).toBe(0)
      expect(refresh.stdout).toContain("refresh-failure-codes: wrote")
      expect(readFileSync(files.vendored, "utf8")).toBe(files.text)
      const generated = readFileSync(files.generated, "utf8")
      expect(generated).toContain("\"quota_exceeded\": { fault: \"wait\", status: 429, retryAfter: 60 }")
      expect(generated).toContain(`export const PLUE_FAILURE_DIGEST = "${files.document.digest}"`)

      const check = files.run("--check")
      expect(check.status).toBe(0)
      expect(check.stdout).toContain("fresh against")
      expect(readFileSync(files.vendored, "utf8")).toBe(files.text)
      expect(readFileSync(files.generated, "utf8")).toBe(generated)

      expect(files.run("--check", "--from", files.plue).status).toBe(0)

      writeFileSync(files.vendored, "stale vendored document")
      const staleJson = files.run("--check", "--from", files.plue)
      expect(staleJson.status).toBe(1)
      expect(staleJson.stderr).toContain("plue-failure-codes.json")
      expect(readFileSync(files.vendored, "utf8")).toBe("stale vendored document")

      writeFileSync(files.vendored, files.text)
      writeFileSync(files.generated, "stale generated types")
      const staleTypes = files.run("--check")
      expect(staleTypes.status).toBe(1)
      expect(staleTypes.stderr).toContain("PlueFailureCodes.ts")
      expect(readFileSync(files.generated, "utf8")).toBe("stale generated types")
    } finally {
      rmSync(files.root, { recursive: true, force: true })
    }
  })

  test("rejects a forged digest before writing and can import a valid local document", () => {
    const files = fixture()
    try {
      const external = join(files.root, "external.json")
      writeFileSync(external, files.text)
      writeFileSync(files.vendored, "old vendored document")
      const imported = files.run("--from", external)
      expect(imported.status).toBe(0)
      expect(imported.stdout).toContain("refresh-failure-codes: wrote")
      expect(readFileSync(files.vendored, "utf8")).toBe(files.text)

      const forged = { ...files.document, digest: `sha256:${"0".repeat(64)}` }
      writeFileSync(external, JSON.stringify(forged))
      const refused = files.run("--from", external)
      expect(refused.status).toBe(1)
      expect(refused.stderr).toContain("rows hash to")
      expect(readFileSync(files.vendored, "utf8")).toBe(files.text)
    } finally {
      rmSync(files.root, { recursive: true, force: true })
    }
  })

  test("refuses a row whose fields would render as code, even with a matching digest", () => {
    const files = fixture()
    try {
      const generatedBefore = files.run("--from", files.plue)
      expect(generatedBefore.status).toBe(0)
      const clean = readFileSync(files.generated, "utf8")
      const external = join(files.root, "external.json")
      const hostile = [
        { code: "x", fault: "wait", status: "500 }; globalThis.PWNED = 1; ({ a: 1", retry_after: 0, doc: "d" },
        { code: "x", fault: "wait", status: 500, retry_after: "0 }; globalThis.PWNED = 1; ({ a: 1", doc: "d" },
        { code: "x\"]: 1 }; globalThis.PWNED = 1; //", fault: "wait", status: 500, retry_after: 0, doc: "d" },
        { code: "x", fault: "nobody", status: 500, retry_after: 0, doc: "d" }
      ]
      for (const row of hostile) {
        const codes = [row as never]
        writeFileSync(external, JSON.stringify({ schema_version: 1, digest: digestOf(codes), faults: ["wait"], codes }))
        const refused = files.run("--from", external)
        expect(refused.status).toBe(1)
        expect(refused.stderr).toContain("is not a failure-code document")
        expect(readFileSync(files.generated, "utf8")).toBe(clean)
        expect(readFileSync(files.vendored, "utf8")).toBe(files.text)
      }
      const schemaVersion = { ...files.document, schema_version: "1; globalThis.PWNED = 1" }
      writeFileSync(external, JSON.stringify(schemaVersion))
      expect(files.run("--from", external).status).toBe(1)
      expect(readFileSync(files.generated, "utf8")).toBe(clean)
    } finally {
      rmSync(files.root, { recursive: true, force: true })
    }
  })

  test.each([" ", "\n"])("escapes every documentation comment terminator with separator %j", (separator) => {
    const files = fixture()
    try {
      const doc = [
        "Account cap */ \"injected\": { fault: \"wait\", status: 500, retryAfter: 0 }, /*",
        "*/ \"injected_again\": { fault: \"wait\", status: 500, retryAfter: 0 }, /*"
      ].join(separator)
      const codes = files.document.codes.map((row) => ({ ...row, doc }))
      const document = { ...files.document, digest: digestOf(codes), codes }
      writeFileSync(files.source, JSON.stringify(document))

      const refresh = files.run("--from", files.plue)
      expect(refresh.status, refresh.stderr).toBe(0)
      expect(JSON.parse(readFileSync(files.vendored, "utf8"))).toEqual(document)

      const imported = spawnSync(process.execPath, [
        "--input-type=module",
        "--eval",
        "import * as registry from " + JSON.stringify(pathToFileURL(files.generated).href)
        + "\nconsole.log(JSON.stringify({ codes: registry.PLUE_FAILURE_CODES, failures: registry.PLUE_FAILURES }))"
      ], { encoding: "utf8", timeout: 5_000 })
      expect(imported.status, imported.stderr).toBe(0)
      expect(JSON.parse(imported.stdout)).toEqual({
        codes: ["quota_exceeded"],
        failures: { quota_exceeded: { fault: "wait", status: 429, retryAfter: 60 } }
      })
      expect(readFileSync(files.generated, "utf8")).toContain("*\\/")
    } finally {
      rmSync(files.root, { recursive: true, force: true })
    }
  })

  test("refuses a plain-http or other non-https --from URL before fetching", () => {
    const files = fixture()
    try {
      for (const from of ["http://127.0.0.1:1", "ftp://example.com/codes.json", "file:///etc/passwd"]) {
        const refused = files.run("--from", from)
        expect(refused.status).not.toBe(0)
        expect(refused.stderr).toContain("only https:// URLs or local files are read")
      }
      expect(existsSync(files.vendored)).toBe(false)
    } finally {
      rmSync(files.root, { recursive: true, force: true })
    }
  })

  test("every row of the vendored registry passes validation", () => {
    const vendored = JSON.parse(
      readFileSync(fileURLToPath(new URL("../src/plue-failure-codes.json", import.meta.url)), "utf8")
    )
    expect(validationErrors(vendored)).toEqual([])
  })
})

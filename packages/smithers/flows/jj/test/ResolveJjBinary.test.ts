/**
 * The `jj` resolution order `smithers doctor` reports on.
 *
 * The 0.x requirement this carries forward (`packages/vcs/tests/
 * resolve-jj-binary.test.js`, `jj-eacces-and-fallbacks.test.js`): an explicit
 * `SMITHERS_JJ_PATH` that names a real file stays authoritative even when the
 * file cannot be executed, and a host with no usable `jj` falls back to the
 * bare command name rather than failing at resolution time.
 */
import { describe, expect, it } from "@effect/vitest"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join, relative } from "node:path"
import * as Resolve from "../src/node/resolveJjBinary.ts"

const staged = <A>(use: (directory: string) => A): A => {
  const directory = mkdtempSync(join(tmpdir(), "resolve-jj-"))
  try {
    return use(directory)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

const write = (file: string, mode: number): string => {
  writeFileSync(file, "#!/bin/sh\nexit 0\n")
  chmodSync(file, mode)
  return file
}

describe("resolveJjBinary", () => {
  it("honours SMITHERS_JJ_PATH when it names an executable file", () =>
    staged((directory) => {
      const binary = write(join(directory, "jj"), 0o755)
      const resolved = Resolve.resolveJjBinary({ environment: { SMITHERS_JJ_PATH: binary }, platform: "linux" })

      expect(resolved).toEqual({ path: binary, source: "env", executable: true, variable: "SMITHERS_JJ_PATH" })
      expect(Resolve.describe(resolved)).toBe(`jj: ${binary} (SMITHERS_JJ_PATH)`)
      expect(Resolve.describe({ path: binary, source: "env", executable: true })).toBe(
        `jj: ${binary} (SMITHERS_JJ_PATH)`
      )
    }))

  it("returns an absolute host path for a relative override", () =>
    staged((directory) => {
      const binary = write(join(directory, process.platform === "win32" ? "jj.exe" : "jj"), 0o755)
      expect(Resolve.resolveJjBinary({ environment: { SMITHERS_JJ_PATH: relative(process.cwd(), binary) } }).path)
        .toBe(binary)
    }))

  it("skips a relative PATH entry instead of resolving it against the working directory", () =>
    staged((directory) => {
      // `NodeJj.layer` treats the process working directory as the repository
      // and agents write files there. With `.` or `bin` on PATH ahead of the
      // real jj, the resolver selected `./jj` and the host ran what an agent
      // wrote. The entry is relative, holds an executable jj, and must lose.
      const binary = write(join(directory, process.platform === "win32" ? "jj.exe" : "jj"), 0o755)
      const entry = relative(process.cwd(), directory)
      expect(Resolve.resolveJjBinary({ environment: { PATH: entry } })).toMatchObject({
        path: "jj",
        source: "path",
        executable: false
      })
      expect(Resolve.resolveJjBinary({ environment: { PATH: `.${delimiter}${entry}${delimiter}${directory}` } }).path)
        .toBe(binary)
    }))

  it("keeps a non-executable override authoritative and explains why it fails", () =>
    staged((directory) => {
      const binary = write(join(directory, "jj"), 0o644)
      const resolved = Resolve.resolveJjBinary({ environment: { SMITHERS_JJ_PATH: binary }, platform: "linux" })

      expect(resolved.source).toBe("env")
      expect(resolved.executable).toBe(false)
      expect(resolved.hint).toContain("chmod +x")
      expect(resolved.hint).not.toContain("xattr")
      expect(Resolve.describe(resolved)).toContain("chmod +x")
    }))

  it("adds the macOS quarantine tip only on darwin", () => {
    expect(Resolve.permissionHint("/opt/jj", "darwin")).toContain("xattr -d com.apple.quarantine")
    expect(Resolve.permissionHint("/opt/jj", "linux")).not.toContain("xattr")
  })

  it("ignores an empty or missing override and searches PATH", () =>
    staged((directory) => {
      const binary = write(join(directory, "jj"), 0o755)
      const environment = {
        SMITHERS_JJ_PATH: join(directory, "absent"),
        PATH: `${join(directory, "empty")}${delimiter}${directory}`
      }

      const resolved = Resolve.resolveJjBinary({ environment, platform: "linux" })

      expect(resolved).toEqual({
        path: binary,
        source: "path",
        executable: true,
        ignored: { variable: "SMITHERS_JJ_PATH", path: join(directory, "absent") }
      })
      expect(Resolve.describe(resolved)).toBe(
        `jj: ${binary} - SMITHERS_JJ_PATH names ${join(directory, "absent")}, which does not exist, and was ignored`
      )
    }))

  it("reports a skipped override alongside the no-jj-anywhere hint", () =>
    staged((directory) => {
      const resolved = Resolve.resolveJjBinary({
        environment: { SMITHERS_JJ_PATH: join(directory, "absent") },
        platform: "linux"
      })

      expect(resolved).toMatchObject({ path: "jj", source: "path", executable: false })
      expect(Resolve.describe(resolved)).toBe(
        `jj: not found - ${Resolve.resolveJjBinary({ environment: {}, platform: "linux" }).hint}`
          + `; SMITHERS_JJ_PATH names ${join(directory, "absent")}, which does not exist, and was ignored`
      )
    }))

  it("renders a pasteable path in the permission hint, whatever the path contains", () => {
    // The hint is remediation an operator pastes into a shell, and the path is
    // whatever they put in SMITHERS_JJ_PATH.
    expect(Resolve.shellQuote("/opt/my jj/jj")).toBe("'/opt/my jj/jj'")
    expect(Resolve.shellQuote("/opt/it's/jj")).toBe(`'/opt/it'\\''s/jj'`)
    expect(Resolve.permissionHint("/opt/jj; rm -rf /", "linux"))
      .toContain("chmod +x '/opt/jj; rm -rf /';")
    expect(Resolve.permissionHint("/opt/$(whoami)/jj", "darwin"))
      .toContain("xattr -d com.apple.quarantine '/opt/$(whoami)/jj';")
    expect(Resolve.permissionHint("/opt/a\nb/jj", "linux")).toContain("chmod +x '/opt/a\nb/jj';")
  })

  it("skips empty PATH entries and looks for jj.exe on Windows", () =>
    staged((directory) => {
      const binary = write(join(directory, "jj.exe"), 0o644)
      const resolved = Resolve.resolveJjBinary({
        environment: { Path: `${delimiter}${directory}` },
        platform: "win32"
      })

      expect(resolved).toEqual({ path: binary, source: "path", executable: true })
    }))

  it("falls back to the bare command name when nothing on PATH is jj", () => {
    const resolved = Resolve.resolveJjBinary({ environment: {}, platform: "linux" })

    expect(resolved).toEqual({
      path: "jj",
      source: "path",
      executable: false,
      hint: "No jj on PATH. Install jj (https://jj-vcs.github.io) or set SMITHERS_JJ_PATH."
    })
    expect(Resolve.describe(resolved)).toContain("not found")
  })

  it("searches every PATH entry before giving up on the bare name", () =>
    staged((directory) => {
      // A populated PATH that simply holds no jj: the search runs to the end
      // and reports the absence, rather than stopping at the first entry.
      write(join(directory, "git"), 0o755)
      const resolved = Resolve.resolveJjBinary({
        environment: { PATH: `${directory}${delimiter}${join(directory, "nowhere")}` },
        platform: "linux"
      })

      expect(resolved).toMatchObject({ path: "jj", source: "path", executable: false })
      expect(resolved.hint).toContain("No jj on PATH")
    }))

  it("skips a directory named jj on PATH and keeps searching", () =>
    staged((directory) => {
      // A jj source checkout sitting in a PATH directory: directories pass the
      // execute-bit probe, but spawning one fails with EACCES.
      const checkout = join(directory, "src")
      mkdirSync(join(checkout, "jj"), { recursive: true })
      const bin = join(directory, "bin")
      mkdirSync(bin)
      const binary = write(join(bin, "jj"), 0o755)

      expect(Resolve.resolveJjBinary({ environment: { PATH: `${checkout}${delimiter}${bin}` }, platform: "linux" }))
        .toEqual({ path: binary, source: "path", executable: true })
      expect(Resolve.resolveJjBinary({ environment: { PATH: checkout }, platform: "linux" }))
        .toMatchObject({ path: "jj", source: "path", executable: false })
    }))

  it("reports a directory override as unusable instead of executable", () =>
    staged((directory) => {
      const resolved = Resolve.resolveJjBinary({ environment: { SMITHERS_JJ_PATH: directory }, platform: "linux" })

      expect(resolved).toMatchObject({ path: directory, source: "env", executable: false })
      expect(resolved.hint).toContain(directory)
    }))

  it("treats an empty PATH the same as an unset one", () => {
    expect(Resolve.resolveJjBinary({ environment: { PATH: "" }, platform: "linux" }).path).toBe("jj")
  })

  it("probes execute access on POSIX and existence on Windows", () => {
    const calls: Array<readonly [string, number]> = []
    const access = (file: string, mode: number) => {
      calls.push([file, mode])
    }

    expect(Resolve.isExecutable("/tmp/jj", { platform: "linux", access })).toBe(true)
    expect(Resolve.isExecutable("C:\\jj.exe", { platform: "win32", access })).toBe(true)
    expect(calls).toEqual([["/tmp/jj", 1], ["C:\\jj.exe", 0]])
  })

  it("reports a candidate the operating system refuses as not executable", () => {
    const access = () => {
      throw new Error("EACCES: permission denied")
    }

    expect(Resolve.isExecutable("/tmp/jj", { platform: "linux", access })).toBe(false)
  })

  it("resolves against the real process environment by default", () =>
    staged((directory) => {
      const previousPath = process.env.PATH
      const previousOverride = process.env.SMITHERS_JJ_PATH
      process.env.PATH = directory
      delete process.env.SMITHERS_JJ_PATH
      try {
        expect(Resolve.resolveJjBinary()).toEqual({
          path: "jj",
          source: "path",
          executable: false,
          hint: "No jj on PATH. Install jj (https://jj-vcs.github.io) or set SMITHERS_JJ_PATH."
        })
        const binary = write(join(directory, process.platform === "win32" ? "jj.exe" : "jj"), 0o755)
        const resolved = Resolve.resolveJjBinary()
        expect(resolved).toEqual({ path: binary, source: "path", executable: true })
        expect(Resolve.isExecutable(resolved.path)).toBe(true)
        process.env.SMITHERS_JJ_PATH = binary
        expect(Resolve.resolveJjBinary()).toEqual({
          path: binary,
          source: "env",
          executable: true,
          variable: "SMITHERS_JJ_PATH"
        })
      } finally {
        if (previousPath === undefined) delete process.env.PATH
        else process.env.PATH = previousPath
        if (previousOverride === undefined) delete process.env.SMITHERS_JJ_PATH
        else process.env.SMITHERS_JJ_PATH = previousOverride
      }
    }))
})

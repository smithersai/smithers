import { execFileSync, spawn } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, isAbsolute, join, relative, sep } from "node:path"
import { expect, it } from "vitest"
import { electrobun, waitForNativeSpawn } from "./native/config.ts"
import { nativeLibrariesAvailable, nativeTools, nativeUnavailableReason } from "./native/prerequisites.ts"

it("keeps transient coverage reports outside the workspace declaration walk", () => {
  const output = execFileSync("node", [
    "--input-type=module",
    "--eval",
    `
    import config from "./vitest.config.ts";
    import { realpathSync } from "node:fs";
    const directory = config.test.coverage.reportsDirectory;
    console.log(JSON.stringify({
      directory: realpathSync(directory),
      workspace: realpathSync("../../../..")
    }));
    `
  ], { cwd: join(import.meta.dirname, ".."), encoding: "utf8" })
  const { directory, workspace } = JSON.parse(output) as { directory: string; workspace: string }
  const path = relative(workspace, directory)
  const outside = path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)
  expect({ directory, outside }).toMatchObject({ outside: true })
})

it("keeps desktop setup out of a Node run without native tools", () => {
  const output = execFileSync(process.execPath, [
    "--input-type=module",
    "--eval",
    `
    import config from "./vitest.config.ts";
    console.log(JSON.stringify(config.test));
    `
  ], { cwd: join(import.meta.dirname, ".."), env: { ...process.env, PATH: "" }, encoding: "utf8" })
  const config = JSON.parse(output) as {
    globalSetup?: Array<string>
    projects?: Array<{ test: { name: string; globalSetup?: Array<string> } }>
  }
  expect((config.globalSetup ?? []).map((path) => path.split(sep).join("/"))).not.toContainEqual(
    expect.stringContaining("test/native/config.ts")
  )
  expect(config.projects?.map((project) => project.test.name)).toEqual(["portable"])
})

it("admits only a Linux Node collector with every executable and Chromium installed", () => {
  const directory = mkdtempSync(join(tmpdir(), "native-prerequisites-"))
  try {
    expect(nativeLibrariesAvailable(join(directory, "missing-python3"))).toBe(false)
    const browser = join(directory, "chromium")
    const options = { platform: "linux", bun: false, path: directory, browser: () => browser, libraries: () => true }
    for (const tool of [...nativeTools, "chromium"]) writeFileSync(join(directory, tool), "", { mode: 0o700 })
    expect(nativeUnavailableReason(options)).toBeUndefined()
    for (const platform of ["darwin", "win32"]) {
      expect(nativeUnavailableReason({ ...options, platform })).toBe("the native fixture requires Linux")
    }
    expect(nativeUnavailableReason({ ...options, bun: true })).toBe("the native collector requires Node/V8")
    for (const tool of nativeTools) {
      rmSync(join(directory, tool))
      expect(nativeUnavailableReason(options)).toBe(`missing ${tool}`)
      writeFileSync(join(directory, tool), "", { mode: 0o700 })
      if (process.platform !== "win32") {
        chmodSync(join(directory, tool), 0o600)
        expect(nativeUnavailableReason(options)).toBe(`missing ${tool}`)
        chmodSync(join(directory, tool), 0o700)
      }
    }
    expect(nativeUnavailableReason({ ...options, libraries: () => false })).toBe(
      "missing native desktop shared libraries"
    )
    expect(nativeUnavailableReason({
      ...options,
      browser: () => {
        throw new Error("Playwright is not installed")
      }
    })).toBe("missing Playwright Chromium")
    rmSync(browser)
    expect(nativeUnavailableReason(options)).toBe("missing Playwright Chromium")
    expect(nativeUnavailableReason({ ...options, path: "" })).toBe("missing flock")
    rmSync(join(directory, "flock"))
    mkdirSync(join(directory, "flock"))
    expect(nativeUnavailableReason(options)).toBe("missing flock")
    // Unsupported runtimes must not touch any optional native dependency.
    const unavailableBrowser = () => {
      throw new Error("must not resolve the optional browser")
    }
    expect(nativeUnavailableReason({ ...options, platform: "darwin", browser: unavailableBrowser })).toBe(
      "the native fixture requires Linux"
    )
    expect(nativeUnavailableReason({ ...options, bun: true, browser: unavailableBrowser })).toBe(
      "the native collector requires Node/V8"
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

it("reports a real Xvfb spawn error without an unhandled child error", async () => {
  const directory = mkdtempSync(join(tmpdir(), "native-spawn-"))
  try {
    const child = spawn(join(directory, "missing-Xvfb"), [])
    await expect(waitForNativeSpawn(child, "Xvfb")).rejects.toMatchObject({
      message: "Native fixture Xvfb failed to start",
      cause: { code: "ENOENT" }
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
  const child = spawn(process.execPath, ["--eval", "process.exit(0)"])
  await expect(waitForNativeSpawn(child, "Node")).resolves.toBeUndefined()
  await new Promise((resolve) => child.once("close", resolve))
})

// The fixture is Linux-only, and Windows runs no sh launcher.
it.skipIf(process.platform === "win32")("launches this package's Electrobun from the native fixture directory", () => {
  // A `node` that prints what it is handed stands in for the one the launcher runs, so no CLI is downloaded or built.
  const directory = mkdtempSync(join(tmpdir(), "native-electrobun-"))
  try {
    writeFileSync(join(directory, "node"), "#!/bin/sh\nprintf '%s\\n' \"$@\"\n", { mode: 0o700 })
    const output = execFileSync(electrobun, ["build"], {
      cwd: join(import.meta.dirname, "native"),
      env: { ...process.env, PATH: `${directory}${delimiter}${process.env.PATH ?? ""}` },
      encoding: "utf8"
    })
    expect(output.trim().split("\n")).toEqual([expect.stringMatching(/\/electrobun\/bin\/electrobun\.cjs$/), "build"])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

it("collects only the native consumer in the native project", () => {
  const output = execFileSync(process.execPath, [
    "--input-type=module",
    "--eval",
    `
    import { createVitest } from "vitest/node";
    import { relative, sep } from "node:path";
    import config, { projects } from "./vitest.config.ts";
    const vitest = await createVitest({ config: false, watch: false }, {
      ...config,
      test: { ...config.test, projects: projects(true), coverage: { enabled: false } }
    });
    try {
      const files = (await vitest.globTestSpecifications()).map(s => ({
        project: s.project.name,
        file: relative(process.cwd(), s.moduleId).split(sep).join("/"),
        setup: s.project.config.globalSetup.map(path => path.split(sep).join("/"))
      }));
      const selected = (await vitest.globTestSpecifications(["CoverageWorkspace.test.ts"])).map(s => s.project.name);
      console.log("COLLECTION " + JSON.stringify({ files, selected }));
    } finally {
      await vitest.close();
    }
    `
  ], { cwd: join(import.meta.dirname, ".."), encoding: "utf8", timeout: 25_000 })
  const { files, selected } = JSON.parse(output.split("COLLECTION ")[1]!) as {
    files: Array<{ project: string; file: string; setup: Array<string> }>
    selected: Array<string>
  }
  expect(files.filter((file) => file.project === "native").map((file) => file.file)).toEqual(["test/native.test.vibe"])
  const portable = files.filter((file) => file.project === "portable")
  expect(portable.length).toBeGreaterThan(0)
  expect(portable.some((file) => file.file === "test/native.test.vibe")).toBe(false)
  for (const file of portable) expect(file.setup).not.toContainEqual(expect.stringContaining("test/native/config.ts"))
  expect(selected).toEqual(["portable"])
})

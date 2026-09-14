import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { packagedBuildRuntimeCommand } from "./PackagedBuildCommand"

test("packaging copies locally without invoking root or package deploy scripts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "smithers-package-dispatch-"))
  let child: ReturnType<typeof Bun.spawn> | undefined
  try {
    const root = await Bun.file(new URL("../../../package.json", import.meta.url)).json()
    const trap = "node -e \"require('node:fs').writeFileSync('DEPLOY_SCRIPT_RAN', 'unexpected')\""
    await mkdir(join(directory, "package"))
    await writeFile(join(directory, "package.json"), JSON.stringify({
      name: "packaging-dispatch-fixture", private: true, packageManager: root.packageManager,
      scripts: { deploy: trap }
    }))
    await writeFile(join(directory, "pnpm-workspace.yaml"), "packages:\n  - package\n")
    await writeFile(join(directory, "package", "package.json"), JSON.stringify({
      name: "@smthrs/build-cli", version: "1.0.0", files: ["entry.js"],
      scripts: { deploy: trap, prepare: trap, postinstall: trap }
    }))
    await writeFile(join(directory, "package", "entry.js"), "export const local = true\n")
    const destination = join(directory, "output")
    const running = Bun.spawn(packagedBuildRuntimeCommand(destination), {
      cwd: directory,
      env: { ...process.env, CI: "1" },
      stdout: "pipe", stderr: "pipe", stdin: "ignore"
    })
    child = running
    const [code, stdout, stderr] = await Promise.all([
      running.exited, new Response(running.stdout).text(), new Response(running.stderr).text()
    ])
    expect({ code, output: `${stdout}${stderr}` }).toMatchObject({ code: 0 })
    expect(await Bun.file(join(destination, "entry.js")).text()).toBe("export const local = true\n")
    for (const path of [directory, join(directory, "package"), destination]) {
      expect(await Bun.file(join(path, "DEPLOY_SCRIPT_RAN")).exists()).toBe(false)
    }
  } finally {
    child?.kill()
    await child?.exited
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)

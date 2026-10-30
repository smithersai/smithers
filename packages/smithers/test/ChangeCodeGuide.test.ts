/** The public coding recipe crosses the CLI, agent writes, diff and a person's push. */
import { spawn } from "node:child_process"
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"
import { childEnvironment } from "./support/node-child.ts"

it.each(["jj", "git"])("executes the coding guide with %s and pushes to origin main", async (vcs) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "smithers-change-guide-")))
  try {
    const doc = await readFile(new URL("../docs/guides/change-code.md", import.meta.url), "utf8")
    const blocks = [...doc.matchAll(/```bash\n([\s\S]*?)\n```/g)].map((match) => match[1]!)
    const script = [
      "trap 'printf \"Failed command at line %s: %s\\n\" \"$LINENO\" \"$BASH_COMMAND\" >&2' ERR",
      "smthrs() { \"$GUIDE_NODE\" --no-warnings --import \"$GUIDE_PRELOAD\" \"$GUIDE_BIN\" \"$@\"; }",
      "git init --bare origin.git",
      // Installation and login were measured live. Only the provider transport
      // is replaced here, so this offline test cannot spend a subscription.
      vcs === "jj" ? blocks[1] : blocks[1]!.split("jj git init .")[0]! + blocks[2]! + "\njj git init --colocate .",
      blocks[3],
      `"$GUIDE_NODE" --input-type=module -e 'import { readFileSync, writeFileSync } from "node:fs"; const p = ".smithers/flows/coding/flow.ts"; writeFileSync(p, readFileSync(p, "utf8").replaceAll("openai:gpt-6-sol", "openai:gpt-6.1-sol"));'`,
      blocks[5],
      blocks[6]!.replace("run-2", "run-1"),
      blocks[7],
      vcs === "jj"
        ? blocks[8]!.replace("/path/to/your/origin.git", "../origin.git")
        : blocks[9]!.replace("/path/to/your/origin.git", "../origin.git"),
      "git --git-dir=../origin.git show main:index.js",
      "git --git-dir=../origin.git show main:index.test.js",
      "test \"$(git --git-dir=../origin.git rev-parse main)\" = \"$(git rev-parse HEAD)\""
    ].join("\n")
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn("/bin/bash", ["--norc", "--noprofile", "-euE", "-o", "pipefail", "-c", script], {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
        env: childEnvironment({
          PATH: process.env.PATH,
          TMPDIR: process.env.TMPDIR,
          HOME: root,
          XDG_CONFIG_HOME: join(root, "config"),
          XDG_DATA_HOME: join(root, "data"),
          SMITHERS_WORKSPACE_JJ_EXPORT_BINARY: process.env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY,
          OPENAI_API_KEY: "fixture-never-sent",
          SMITHERS_BACKEND: "sqlite",
          GUIDE_NODE: process.execPath,
          GUIDE_BIN: fileURLToPath(new URL("../src/bin.ts", import.meta.url)),
          GUIDE_PRELOAD: fileURLToPath(new URL("./fixtures/coding-native-host.ts", import.meta.url))
        }),
        timeout: 120_000
      })
      let stdout = ""
      let stderr = ""
      child.stdout.on("data", (data) => {
        stdout += data
      })
      child.stderr.on("data", (data) => {
        stderr += data
      })
      child.on("error", reject)
      child.on("close", (code) => resolve({ code, stdout, stderr }))
    })
    expect(
      result.code,
      `commands:\n${
        script.split("\n").map((line, index) => `${index + 1}: ${line}`).join("\n")
      }\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    ).toBe(0)
    expect(result.stdout).toContain("status: completed")
    expect(result.stdout).toContain("Modified regular file index.js")
    expect(result.stdout).toContain("Added regular file index.test.js")
    expect(result.stdout).toContain("fail 0")
    expect(result.stdout).toContain("export function slugify")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 150_000)

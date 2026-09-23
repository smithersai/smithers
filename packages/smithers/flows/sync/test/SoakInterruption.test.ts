import { expect, it } from "@effect/vitest"
import { execFileSync, spawn } from "node:child_process"
import { access, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { type Artifact, verify } from "./soakArtifact.ts"

it.skipIf(process.platform === "win32")(
  "writes explicit failed evidence and releases resources after a real SIGTERM",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "sync-soak-interruption-"))
    try {
      const artifactPath = join(directory, "interrupted.json")
      // The scheduled soak records Git provenance. Run its real source in an
      // isolated checkout so the test also works from a non-colocated jj workspace.
      const source = fileURLToPath(new URL("../", import.meta.url))
      const checkout = join(directory, "checkout")
      await mkdir(join(checkout, "test", "fixtures"), { recursive: true })
      await Promise.all([
        cp(join(source, "src"), join(checkout, "src"), { recursive: true }),
        cp(join(source, "package.json"), join(checkout, "package.json")),
        cp(join(source, "test", "soakArtifact.ts"), join(checkout, "test", "soakArtifact.ts")),
        cp(
          join(source, "test", "fixtures", "long-soak-child.ts"),
          join(checkout, "test", "fixtures", "long-soak-child.ts")
        ),
        symlink(join(source, "node_modules"), join(checkout, "node_modules"), "junction"),
        mkdir(join(directory, "hooks")),
        writeFile(join(checkout, ".gitignore"), "node_modules\n")
      ])
      const git = (args: Array<string>): string =>
        execFileSync("git", ["-c", `core.hooksPath=${join(directory, "hooks")}`, ...args], {
          cwd: checkout,
          encoding: "utf8",
          timeout: 5_000
        })
      git(["init", "--quiet", "--initial-branch=main"])
      git(["add", "--force", "src", "package.json", "test", ".gitignore"])
      git([
        "-c",
        "user.name=Sync fixture",
        "-c",
        "user.email=sync-fixture@example.invalid",
        "commit",
        "--quiet",
        "--no-gpg-sign",
        "-m",
        "sync soak fixture"
      ])
      const head = git(["rev-parse", "HEAD"]).trim()
      const child = spawn(process.execPath, [
        "--expose-gc",
        join(checkout, "test", "fixtures", "long-soak-child.ts")
      ], {
        env: { ...process.env, SMITHERS_SOAK_MINUTES: "1", SMITHERS_SOAK_ARTIFACT: artifactPath }
      })
      let stdout = ""
      let stderr = ""
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk)
      })
      const exited = new Promise<number | null>((resolve) => child.once("exit", resolve))
      const watchdog = setTimeout(() => child.kill("SIGKILL"), 10_000)
      try {
        const ready = await new Promise<{ directory: string; phase: string }>((resolve, reject) => {
          child.stdout.on("data", (chunk) => {
            stdout += String(chunk)
            if (stdout.includes("\n")) resolve(JSON.parse(stdout.slice(0, stdout.indexOf("\n"))))
          })
          child.once("error", reject)
          child.once("exit", () => reject(new Error(`No ready barrier: ${stderr}`)))
        })
        expect(ready.phase).toBe("ready")
        child.kill("SIGTERM")
        expect(await exited, stderr).toBe(1)
        const artifact = JSON.parse(await readFile(artifactPath, "utf8")) as Artifact
        expect(artifact.candidate.head).toBe(head)
        expect(artifact.candidate.dirty).toBe(false)
        expect(artifact.status).toBe("failed")
        expect(artifact.failure).toBeTruthy()
        expect(artifact.cleanup).toEqual({ activeReads: 0, pendingWrites: 0, slowSubscribers: 0, sockets: 0 })
        expect(() => verify(artifact, 1)).toThrow()
        await expect(access(ready.directory)).rejects.toThrow()
      } finally {
        clearTimeout(watchdog)
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
        await exited
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
  15_000
)

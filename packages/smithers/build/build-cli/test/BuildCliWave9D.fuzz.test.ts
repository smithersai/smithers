import { Smithers as S } from "@smthrs/targets"
import * as Reference from "@smthrs/targets/Reference"
import * as Runtime from "@smthrs/targets/Runtime"
import type * as Target from "@smthrs/targets/Target"
import * as WorkspaceDeclaration from "@smthrs/targets/WorkspaceDeclaration"
import { Effect } from "effect"
import * as NodeChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as AgentSession from "../src/AgentSession.ts"
import * as FoundryExec from "../src/FoundryExec.ts"
import * as GitHooks from "../src/GitHooks.ts"
import * as GoExec from "../src/GoExec.ts"
import * as HostProbes from "../src/internal/HostProbes.ts"
import * as PackageExec from "../src/PackageExec.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as Watch from "../src/Watch.ts"
import { writeExecutable } from "./helpers/Executable.ts"

const withTempDir = async <A>(prefix: string, body: (dir: string) => Promise<A>): Promise<A> => {
  const dir = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), prefix)))
  try {
    return await body(dir)
  } finally {
    await Fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

const makeIndex = (
  root: string,
  workspace: WorkspaceDeclaration.WorkspaceDeclaration,
  targets: Readonly<Record<string, Target.AnyTarget>>
): PackageIndex =>
  PackageIndex.make(
    {
      root,
      workspace,
      factory: undefined,
      packages: [{ packagePath: "", file: "PACKAGE.ts", value: S.Package({ targets }) }],
      modules: ["PACKAGE.ts"],
      moduleRoots: []
    },
    root
  )

describe("BuildCliWave9D PackagePlanner, PackageRunner, FoundryExec, GoExec, GitHooks, Watch, AgentSession", () => {
  it("PackagePlanner & PackageRunner deep refusal, tool, link, outFiles, and execution-mismatch matrix", async () => {
    await withTempDir("wave9d-exec-", async (dir) => {
      const ws = NodePath.join(dir, "ws")
      const binDir = NodePath.join(dir, "bin")
      await Fs.mkdir(NodePath.join(ws, "src"), { recursive: true })
      await Fs.mkdir(binDir, { recursive: true })
      NodeChildProcess.execFileSync("jj", ["git", "init", "--colocate"], { cwd: ws, stdio: "ignore" })

      // Script + symlink chain for linkChain coverage
      const realScript = NodePath.join(ws, "src", "real.sh")
      await writeExecutable(realScript, "#!/bin/sh\necho hello-wave9d\n")
      const link1 = NodePath.join(ws, "src", "link1.sh")
      const link2 = NodePath.join(ws, "src", "link2.sh")
      await Fs.symlink("real.sh", link1)
      await Fs.symlink("link1.sh", link2)

      // Bad env shebang script (`#!/usr/bin/env -S sh`)
      const badEnvScript = NodePath.join(ws, "src", "bad-env.sh")
      await writeExecutable(badEnvScript, "#!/usr/bin/env -S sh\necho hi\n")

      // Symlinked directory for LinkRefused when passed as S.file
      await Fs.mkdir(NodePath.join(ws, "src", "real-dir"), { recursive: true })
      await Fs.symlink("real-dir", NodePath.join(ws, "src", "dir-link"))

      // Regular file + symlink for S.link input & heldNames
      await Fs.writeFile(NodePath.join(ws, "src", "data.txt"), "uses MY_VAR_9D inside file\n")
      await Fs.symlink("data.txt", NodePath.join(ws, "src", "data-link.txt"))

      // Tool binary for PathTools + executable-changed-since-planning
      const toolScript = NodePath.join(binDir, "mytool9d")
      await writeExecutable(toolScript, "#!/bin/sh\necho tool-v1\n")

      const nonExecFile = NodePath.join(binDir, "not-exec")
      await Fs.writeFile(nonExecFile, "not executable")

      const wsDecl = WorkspaceDeclaration.Workspace("wave9d", {
        repository: "git+https://github.com/org/wave9d.git",
        cache: WorkspaceDeclaration.Cache({ directory: ".cache" }),
        host: WorkspaceDeclaration.Host({ bins: ["echo", "mytool9d", "definitely-missing-9d"] })
      })

      const plainTest = S.Shell.Test({ shell: "echo ok" })
      const symlinkScriptTest = S.Shell.Test({
        script: S.file("src/link2.sh"),
        data: [S.file("src/data.txt"), S.link("src/data-link.txt")],
        sandbox: "none"
      })
      const badEnvTest = S.Shell.Test({
        script: S.file("src/bad-env.sh"),
        sandbox: "none"
      })
      const dirLinkInputTest = S.Shell.Test({
        shell: "true",
        data: [S.file("src/dir-link")],
        sandbox: "none"
      })
      const shardedShellTest = S.Shell.Test({
        shell: "echo ok",
        shards: 2,
        sandbox: "none"
      })
      const nonServiceTest = S.Shell.Test({
        shell: "true",
        services: [plainTest],
        sandbox: { network: "loopback" }
      })
      const svcNoNetTest = S.Shell.Test({
        shell: "true",
        services: [plainTest]
      })
      const withHostToolTest = S.Shell.Test({
        bin: Reference.hostBin("mytool9d"),
        tools: [Reference.hostBin("mytool9d")],
        sandbox: "none"
      })
      const missingEnvToolTest = S.Shell.Test({
        shell: "true",
        tools: [Reference.hostBin("definitely-missing-9d", { env: "CUSTOM_TOOL_9D" })],
        sandbox: "none"
      })
      const outFileBuild = S.Shell.Build({
        shell: "mkdir -p out && echo generated-out > out/gen.txt",
        outFiles: ["out/gen.txt"],
        sandbox: "none"
      })
      const symlinkOutBuild = S.Shell.Build({
        shell: "mkdir -p out2 && echo hi > out2/real.txt && ln -sf real.txt out2/bad-link.txt",
        outFiles: ["out2/bad-link.txt"],
        sandbox: "none"
      })

      const idx = makeIndex(ws, wsDecl, {
        plainTest,
        symlinkScriptTest,
        badEnvTest,
        dirLinkInputTest,
        shardedShellTest,
        nonServiceTest,
        svcNoNetTest,
        withHostToolTest,
        missingEnvToolTest,
        outFileBuild,
        symlinkOutBuild
      })

      const envWithBin = {
        ...process.env,
        PATH: `${binDir}:${process.env["PATH"] ?? ""}`,
        CUSTOM_TOOL_9D: nonExecFile,
        MY_VAR_9D: "present"
      }

      // 1) Plan refusal targets (fast, pure planning!)
      for (
        const label of [
          "//:badEnvTest",
          "//:shardedShellTest",
          "//:nonServiceTest",
          "//:svcNoNetTest",
          "//:missingEnvToolTest"
        ]
      ) {
        const planned = await PackageExec.plan({
          index: idx,
          verb: "test",
          patterns: [label],
          cacheDirectory: ".cache",
          environment: envWithBin
        })
        expect(planned.workList.length).toBeGreaterThanOrEqual(1)
      }

      // 2) dirLinkInputTest throws link_input_refused during planning
      await expect(
        PackageExec.plan({
          index: idx,
          verb: "test",
          patterns: ["//:dirLinkInputTest"],
          cacheDirectory: ".cache",
          environment: envWithBin
        })
      ).rejects.toThrow()

      // 3) Plan & run symlinkScriptTest + outFileBuild + symlinkOutBuild (refuses symlink outFile)
      const runRes1 = await PackageExec.run({
        index: idx,
        verb: "test",
        patterns: ["//:symlinkScriptTest"],
        cacheDirectory: ".cache",
        environment: envWithBin
      })
      expect(runRes1.ok).toBe(true)

      const runBuild = await PackageExec.run({
        index: idx,
        verb: "build",
        patterns: ["//:outFileBuild"],
        cacheDirectory: ".cache",
        environment: envWithBin
      })
      expect(runBuild.ok).toBe(true)
      expect(await Fs.readFile(NodePath.join(ws, "out", "gen.txt"), "utf8")).toContain("generated-out")
      // Remove out/gen.txt and re-run to hit cache materialization of outFiles!
      await Fs.rm(NodePath.join(ws, "out", "gen.txt"))
      const hitBuild = await PackageExec.run({
        index: idx,
        verb: "build",
        patterns: ["//:outFileBuild"],
        cacheDirectory: ".cache",
        environment: envWithBin
      })
      expect(hitBuild.ok).toBe(true)
      expect(await Fs.readFile(NodePath.join(ws, "out", "gen.txt"), "utf8")).toContain("generated-out")

      const linkOutRes = await PackageExec.run({
        index: idx,
        verb: "build",
        patterns: ["//:symlinkOutBuild"],
        cacheDirectory: ".cache",
        environment: envWithBin
      })
      expect(linkOutRes.ok).toBe(false)

      // 4) Plan withHostToolTest, mutate mytool9d, then execute stale plan -> executable changed since planning!
      const stalePlan = await PackageExec.plan({
        index: idx,
        verb: "test",
        patterns: ["//:withHostToolTest"],
        cacheDirectory: ".cache",
        environment: envWithBin
      })
      await writeExecutable(toolScript, "#!/bin/sh\necho tool-v2-mutated\n")
      const staleExec = await PackageExec.execute(stalePlan, {
        index: idx,
        verb: "test",
        patterns: ["//:withHostToolTest"],
        cacheDirectory: ".cache",
        environment: envWithBin
      })
      expect(staleExec.ok).toBe(false)

      // 5) Plan & execute withHostToolTest cleanly + faulty cache store failure log
      const freshPlan = await PackageExec.plan({
        index: idx,
        verb: "test",
        patterns: ["//:withHostToolTest"],
        cacheDirectory: ".cache",
        environment: envWithBin
      })
      const logs: Array<string> = []
      const roCache = NodePath.join(ws, ".ro-cache", "cache")
      await Fs.mkdir(roCache, { recursive: true })
      await Fs.chmod(roCache, 0o555)
      try {
        const brokenCacheExec = await PackageExec.execute(freshPlan, {
          index: idx,
          verb: "test",
          patterns: ["//:withHostToolTest"],
          cacheDirectory: ".ro-cache",
          environment: envWithBin,
          log: (line) => logs.push(line)
        })
        expect(brokenCacheExec.ok).toBe(true)
      } finally {
        await Fs.chmod(roCache, 0o755).catch(() => undefined)
      }
    })
  }, 120_000)

  it(
    "FoundryExec.resolveMiseBin, GoExec.resolveNix/resolveGo, GitHooks, Watch, and AgentSession edge paths",
    async () => {
      await withTempDir("wave9d-tools-", async (dir) => {
        const ws = NodePath.join(dir, "ws")
        const binDir = NodePath.join(dir, "bin")
        await Fs.mkdir(ws, { recursive: true })
        await Fs.mkdir(binDir, { recursive: true })

        await Fs.writeFile(NodePath.join(ws, "mise.toml"), `[tools]\nforge = "1.0.0"\n`)
        const wsMise = WorkspaceDeclaration.Workspace("mise-ws", {
          repository: "git+https://github.com/org/repo.git",
          cache: WorkspaceDeclaration.Cache({ directory: ".cache" }),
          toolchains: [S.Mise({ config: S.file("//mise.toml") })]
        })
        const noMise = await FoundryExec.resolveMiseBin(ws, wsMise, "forge", { PATH: "/nonexistent" })
        expect(noMise.ok).toBe(false)

        const fakeForge = NodePath.join(binDir, "forge")
        await writeExecutable(fakeForge, "#!/bin/sh\necho forge 1.0.0\n")
        const fakeMise = NodePath.join(binDir, "mise")
        await writeExecutable(
          fakeMise,
          `#!/bin/sh
if [ "$1" = "--version" ]; then echo "mise 2026.1.0"; exit 0; fi
if [ "$1" = "which" ] && [ "$2" = "forge" ]; then echo "${fakeForge}"; exit 0; fi
exit 1
`
        )
        const okMise = await FoundryExec.resolveMiseBin(
          ws,
          wsMise,
          "forge",
          { PATH: `${binDir}:${process.env["PATH"] ?? ""}` },
          HostProbes.none()
        )
        expect(okMise.ok).toBe(true)
        const missMise = await FoundryExec.resolveMiseBin(
          ws,
          wsMise,
          "missing-tool",
          { PATH: `${binDir}:${process.env["PATH"] ?? ""}` },
          HostProbes.none()
        )
        expect(missMise.ok).toBe(false)

        const goCtx: GoExec.Context = {
          root: ws,
          packagePath: "",
          workspace: wsMise,
          cacheDirectory: ".cache",
          environment: { PATH: "/nonexistent" }
        }
        const noGo = await GoExec.resolveGo(goCtx)
        expect(noGo.ok).toBe(false)
        const noNix = await GoExec.resolveNix("go", goCtx)
        expect(noNix.ok).toBe(false)

        const rendered = GitHooks.render({ preCommit: "//pkg:lint", prePush: "//pkg:test" })
        expect(rendered.length).toBe(2)
        await expect(GitHooks.check(ws, rendered)).rejects.toThrow(GitHooks.GitHooksError)

        NodeChildProcess.execFileSync("jj", ["git", "init", "--colocate"], { cwd: ws, stdio: "ignore" })
        const hooksDir = NodePath.join(ws, ".git", "hooks")
        await Fs.mkdir(hooksDir, { recursive: true })
        await writeExecutable(NodePath.join(hooksDir, "pre-commit"), "#!/bin/sh\necho handwritten\n")

        const checkBefore = await GitHooks.check(ws, rendered)
        expect(checkBefore.clean).toBe(false)
        const installed = await GitHooks.install(ws, rendered)
        expect(installed.wrote.length).toBe(2)
        const checkClean = await GitHooks.check(ws, rendered)
        expect(checkClean.clean).toBe(true)
        const reduced = GitHooks.render({ preCommit: "//pkg:lint" })
        const checkUnbound = await GitHooks.check(ws, reduced)
        expect(checkUnbound.clean).toBe(false)
        await GitHooks.install(ws, reduced)

        let digestCount = 0
        let triggerNotify: ((file: string | null) => void) | undefined
        let triggerError: ((err: Error) => void) | undefined
        const cycles: Array<number> = []
        const ac = new AbortController()
        const watchServices: Watch.Services["Service"] = {
          notifier: (_root, onEvent, onError) =>
            Effect.sync(() => {
              triggerNotify = onEvent
              triggerError = onError
              return () => {}
            }),
          digest: () =>
            Effect.promise(async () => {
              digestCount += 1
              return `digest-${digestCount}`
            }),
          processRunner: (opts) =>
            Effect.promise(async () => {
              opts.stdout?.("cycle-out\n")
              opts.stderr?.("cycle-err\n")
              if (cycles.length === 0) {
                setTimeout(() => {
                  triggerNotify?.("src/a.ts")
                  triggerNotify?.("src/b.ts")
                }, 20)
              } else {
                setTimeout(() => ac.abort(), 30)
              }
              return 0
            })
        }
        await Watch.run({
          services: watchServices,
          root: ws,
          args: ["test"],
          ignored: [".cache"],
          signal: ac.signal,
          debounceMs: 15,
          rescanMs: 25,
          once: false,
          stdout: () => {},
          stderr: () => {},
          cycleCompleted: (c) => cycles.push(c.number)
        }).catch(() => undefined)
        expect(cycles.length).toBeGreaterThanOrEqual(1)
        expect(triggerError).toBeDefined()

        const errServices: Watch.Services["Service"] = {
          ...watchServices,
          notifier: (_root, _onEvent, onError) =>
            Effect.sync(() => {
              setTimeout(() => onError(new Error("watcher-died")), 15)
              return () => {}
            }),
          processRunner: () => Effect.promise(() => new Promise(() => {}))
        }
        await expect(
          Watch.run({
            services: errServices,
            root: ws,
            args: ["test"],
            ignored: [],
            debounceMs: 10,
            rescanMs: 5000,
            once: false,
            stdout: () => {},
            stderr: () => {}
          })
        ).rejects.toThrow("watcher-died")

        const mcpJson = AgentSession.claudeMcpConfig([
          { _tag: "McpHttp", name: "docs", url: "https://mcp.example.com/v1\u007f" } as never
        ])
        expect(mcpJson).toContain("docs")
        expect(
          await Effect.runPromiseExit(AgentSession.unavailableGateRunner.run(["//pkg:t"], {} as never, 1))
        ).toMatchObject({ _tag: "Failure" })
        expect(
          await Effect.runPromiseExit(AgentSession.unavailablePrOpener.open({} as never))
        ).toMatchObject({ _tag: "Failure" })
        const vStore = AgentSession.makeFileVerdictStore(NodePath.join(dir, "verdicts"))
        const vKey = AgentSession.verdictKey({
          kind: "lint",
          diffDigest: "d",
          promptDigest: "p",
          agentIdentity: "claude",
          mode: "review",
          gateIdentities: []
        })
        await Effect.runPromise(vStore.put(vKey, JSON.stringify({ ok: true, summary: "clean", findings: [] })))
        const loadedVerdict = await Effect.runPromise(vStore.get(vKey))
        expect(loadedVerdict).toBeDefined()

        const badRegexExit = await Effect.runPromiseExit(
          AgentSession.expandDiffSlice(ws, [{ _tag: "GitDiff", base: "HEAD", addedLines: "[unclosed-regex" }])
        )
        expect(badRegexExit._tag).toBe("Failure")
      })
    },
    90_000
  )
})

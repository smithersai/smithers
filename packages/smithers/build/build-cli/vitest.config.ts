import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import vibelang from "vibelang-vite"
import { defineConfig } from "vitest/config"

/** Implementation files at 100% on every metric in the full suite. */
const complete = [
  "src/Affected.ts",
  "src/AgentFake.ts",
  "src/AgentSession.ts",
  "src/Ansi.ts",
  "src/AnvilExec.ts",
  "src/Audience.ts",
  "src/Cache.ts",
  "src/CacheAdmin.ts",
  "src/Cli.ts",
  "src/Diagnostic.ts",
  "src/DockerExec.ts",
  "src/Entry.ts",
  "src/Environment.ts",
  "src/Executor.ts",
  "src/FactoryLoader.ts",
  "src/FactoryProjectionExec.ts",
  "src/FetchExec.ts",
  "src/FoundryExec.ts",
  "src/GitCommit.ts",
  "src/GitHooks.ts",
  "src/GitSubmoduleExec.ts",
  "src/GithubRender.ts",
  "src/GoExec.ts",
  "src/GraphOutput.ts",
  "src/KnownRed.ts",
  "src/Label.ts",
  "src/MarkdownCodeBlocks.ts",
  "src/MemoryBackend.ts",
  "src/Mount.ts",
  "src/NixExec.ts",
  "src/OutputStream.ts",
  "src/OverlayExec.ts",
  "src/Owners.ts",
  "src/PackageDiscovery.ts",
  "src/PackageError.ts",
  "src/PackageExec.ts",
  "src/PackageIndex.ts",
  "src/PackageLoader.ts",
  "src/PackageTree.ts",
  "src/Planner.ts",
  "src/Positionals.ts",
  "src/Query.ts",
  "src/RepoResolution.ts",
  "src/Reporter.ts",
  "src/Resolver.ts",
  "src/RspackRunner.ts",
  "src/ServiceSupervisor.ts",
  "src/StampExec.ts",
  "src/TargetExecution.ts",
  "src/TargetIndex.ts",
  "src/TrustedReview.ts",
  "src/Watch.ts",
  "src/Workspace.ts",
  "src/WorkspaceLoader.ts",
  "src/WorkspaceToolchain.ts",
  "src/effect-resolution.d.ts",
  "src/effect-resolution.js",
  "src/engine.ts",
  "src/index.ts",
  "src/internal/ApprovalBridge.ts",
  "src/internal/Attrs.ts",
  "src/internal/CacheCredentials.ts",
  "src/internal/ContainedProcess.ts",
  "src/internal/CoreRuleSelection.ts",
  "src/internal/DeclarationDependencies.ts",
  "src/internal/DeclarationLabels.ts",
  "src/internal/DigestIndexFile.ts",
  "src/internal/FilePublicationHost.ts",
  "src/internal/Fs.ts",
  "src/internal/GitPathspecBatches.ts",
  "src/internal/GoCache.ts",
  "src/internal/HostProbes.ts",
  "src/internal/InputPackage.ts",
  "src/internal/OutputCas.ts",
  "src/internal/PackageOptions.ts",
  "src/internal/ParseModule.ts",
  "src/internal/Path.ts",
  "src/internal/PathTools.ts",
  "src/internal/RemoteCi.ts",
  "src/internal/RepositoryProcess.ts",
  "src/internal/RuleContract.ts",
  "src/internal/RulePolicy.ts",
  "src/internal/Shards.ts",
  "src/internal/Text.ts",
  "src/internal/TreeGate.ts",
  "src/internal/UnrecordedGates.ts",
  "src/internal/js-extension-siblings.d.ts",
  "src/internal/js-extension-siblings.js",
  "src/internal/rules/DocsCheckRule.ts",
  "src/internal/rules/FetchExecutor.ts",
  "src/internal/rules/FetchPlan.ts",
  "src/internal/rules/FetchRule.ts",
  "src/internal/rules/NativeArtifactOutput.ts",
  "src/internal/rules/NativeFileRule.ts",
  "src/internal/rules/NativeRules.ts",
  "src/internal/rules/SkillsInstallRule.ts",
  "src/main.js",
  "src/main.ts"
]

export default defineConfig({
  plugins: [vibelang({ project: "tsconfig.test.json" })],
  test: {
    globalSetup: [
      fileURLToPath(new URL("../../../repo-targets/test-utils/coverage-teardown.mjs", import.meta.url)),
      fileURLToPath(new URL("../../../repo-targets/test-utils/test-process-environment.mjs", import.meta.url))
    ],
    environment: "node",
    include: ["test/**/*.test.{ts,vibe}"],
    // Execution fixtures launch real toolchains, containers, and child CLIs;
    // planner fixtures copy and fingerprint production implementation trees.
    // The time is spread over 183 files: on a 4-vCPU box the serial pool took
    // 1,863 s, the slowest file 147 s and the ten slowest 600 s of it. Two
    // workers took 1,180 s in the same box (2026-11-12). Four took 661 to 744 s,
    // but WatchContainment's "leader ignores TERM" case then failed in 2 of 4
    // runs: when its cycle reported completion, a fixture process still
    // answered `kill(pid, 0)`. Raise the bound once that race is found. A fixed bound
    // rather than the host's core count keeps a large workstation from
    // multiplying the contention these fixtures create. Tests that wait on a
    // process they start are bounded by the test's own timeout through
    // `signal`, not by a wall-clock cap the pool can exceed.
    maxWorkers: 2,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    coverage: {
      // Enabled so the thresholds below actually gate every run; without
      // this flag they were declared and never computed.
      enabled: true,
      reportOnFailure: true,
      autoAttachSubprocess: true,
      provider: "v8",
      reportsDirectory: join(tmpdir(), `flows-build-cli-coverage-${process.pid}`),
      include: ["src/**"],
      // Measured full-suite floors only rise as behavioral cases close the gaps.
      // Keep every implementation file in the denominator; the goal remains 100%.
      // A file that reaches 100% joins `complete` and may not fall below it.
      thresholds: {
        branches: 99.97,
        functions: 100,
        lines: 100,
        statements: 100,
        ...Object.fromEntries(
          complete.map((file) => [file, { branches: 100, functions: 100, lines: 100, statements: 100 }])
        )
      }
    }
  }
})

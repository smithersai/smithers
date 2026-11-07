// The whole clone against the real services (docs/features/repo.md#tests): RepoApi's handler over this file's schema
// of the compose Postgres, `repo/Clone` on the Node host, the real GitHub and the real Code Storage organization. It
// clones the tiny public `octocat/Spoon-Knife` (an idempotent import by name), then reads its tree and README through
// the GET routes. It skips, saying which credential is missing, without CODE_STORAGE_ORG and CODE_STORAGE_KEY.
import { ConfigProvider, Effect, Option } from "effect"
import { FetchHttpClient } from "effect/http"
import { beforeEach, describe, expect, test } from "vitest"
import { blobRoute, treeRoute } from "../src/features/repo/contract.ts"
import * as RepoConfig from "./RepoConfig.ts"
import { RepoUpstream } from "./RepoUpstream.vibe"
import { testFile } from "./test/harness.ts"
import { repoHarness, repositoryRow, resetRepos } from "./test/repos.ts"

const missing = ["CODE_STORAGE_ORG", "CODE_STORAGE_KEY"].filter((name) => process.env[name] === undefined)
if (missing.length > 0) console.warn(`The live clone is skipped: ${missing.join(" and ")} unset.`)

const runtime = testFile("repo_live")

beforeEach(() => resetRepos(runtime))

const live = <A, E>(effect: Effect.Effect<A, E, never>) =>
  Effect.runPromise(effect.pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv()))))

describe("live", () => {
  test.skipIf(missing.length > 0)("clones octocat/Spoon-Knife into Code Storage and reads it back", async () => {
    const codeStorage = Option.getOrThrow(await live(RepoConfig.codeStorage.pipe(Effect.provide(FetchHttpClient.layer))))
    const upstream = await live(
      Effect.service(RepoUpstream).pipe(Effect.provide(RepoUpstream.layerConfig), Effect.provide(FetchHttpClient.layer)),
    )
    const h = await repoHarness(runtime, { codeStorage, upstream })
    const response = await h.clone("octocat", "Spoon-Knife")
    expect(response.status).toBe(202)
    await h.settled()
    const row = await repositoryRow(runtime, "github/octocat/spoon-knife")
    // Ready, or refused by a budget when GitHub rate limited the unauthenticated size call: both are true outcomes.
    expect(["ready", "capacity"]).toContain(row!.status)
    if (row!.status === "capacity") {
      expect(row!.capacity).toBe("size_unknown")
      console.warn("The live clone was refused size_unknown: GitHub rate limited the size call. Set GITHUB_TOKEN.")
      return
    }
    expect(row).toMatchObject({ defaultBranch: "main", headSha: expect.stringMatching(/^[0-9a-f]{40}$/) })
    const tree = (await (await h.fetch(treeRoute("octocat", "Spoon-Knife", row!.headSha!))).json()) as { paths: Array<string> }
    expect(tree.paths).toContain("README.md")
    const readme = await h.fetch(blobRoute("octocat", "Spoon-Knife", row!.headSha!, "README.md"))
    expect(readme.status).toBe(200)
    expect((await readme.text()).length).toBeGreaterThan(0)
  }, 180_000)
})

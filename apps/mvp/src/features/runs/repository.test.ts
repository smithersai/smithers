import { expect, test } from "vitest"
import { runRepository } from "./repository"
import type { CloudRun, RunPage } from "./schema"

const cloud = (runId: string, repo: string | null) => ({ runId, repo }) as unknown as CloudRun
const read = (parentRunId: string | null) => ({ id: "child", state: "read", inspection: { run: { parentRunId } } }) as unknown as RunPage

// Astra on c64fd4bc: `/app/runs/$runId` showed a refused repository's run, and its jobs, because the page named no
// repository. The run's own Cloudflare row names it, and a job inherits its parent's.
test("a run's repository comes from its Cloudflare row, else its parent's; a person's own run has none", () => {
  const runs = [cloud("root", "acme/private"), cloud("mine", null)]
  expect(runRepository("root", undefined, runs)).toBe("acme/private")
  expect(runRepository("child", read("root"), runs)).toBe("acme/private")
  expect(runRepository("mine", undefined, runs)).toBeNull()
  expect(runRepository("local", read(null), runs)).toBeNull()
})

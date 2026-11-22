// One part of //packages/ci:test (vitest.config.ts says why): the cases under test/cli, holding what `held.cli` names.
import { heldBy, partWorkers, suite } from "./vitest.config.ts"

export default suite({
  include: ["test/cli/**/*.test.{ts,vibe}"],
  ...heldBy("cli"),
  workers: partWorkers.cli,
  part: { name: "testCli", cases: "test/cli" }
})

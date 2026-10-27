import { expect, test } from "vitest"
import { branchWords, flowWords } from "./words"
test("run names use product words and branch refs retain the actual name", () => {
  expect(["ci", "todo", "watch/set", "My flow"].map(flowWords)).toEqual(["CI", "TODO", "Follow", "My flow"])
  expect(["refs/heads/feature/a", "main", "refs/tags/v1"].map(branchWords)).toEqual(["feature/a", "main", "refs/tags/v1"])
})

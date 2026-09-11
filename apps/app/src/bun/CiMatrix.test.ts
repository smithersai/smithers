import { expect, test } from "bun:test"
import { parseWorkflowYaml } from "./CiMatrix"

test("CI parser extracts jobs, smthrs targets, and matrix axes", () => {
  const workflow = parseWorkflowYaml(".github/workflows/ci.yml", `
name: ci
jobs:
  verify:
    name: Verify targets
    strategy:
      matrix:
        shard: [1/3, 2/3, 3/3]
        os:
          - ubuntu-latest
          - macos-latest
    steps:
      - run: pnpm smthrs test '//src:test'
      - run: smthrs //src:lint
`)
  expect(workflow.name).toBe("ci")
  expect(workflow.jobs).toEqual([{ name: "Verify targets", targets: ["//src:test", "//src:lint"], matrix: { shard: ["1/3", "2/3", "3/3"], os: ["ubuntu-latest", "macos-latest"] } }])
})

import { expect, test } from "vitest"
import { actionRunPath, actionsPath, settledState } from "./contract"

test("repository list links use canonical Runs while saved detail URLs remain valid", () => {
  expect(actionsPath("Octo", "Hello World")).toBe("/Octo/Hello%20World/runs")
  expect(actionRunPath("Octo", "Hello World", "ci:1")).toBe("/Octo/Hello%20World/actions/runs/ci%3A1")
})

test("terminal engine outcomes name repository outcomes", () => {
  expect(settledState("completed")).toBe("done")
  expect(settledState("failed")).toBe("failed")
  expect(settledState("cancelled")).toBe("stopped")
})

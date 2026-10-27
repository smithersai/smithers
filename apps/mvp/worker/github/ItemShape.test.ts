import { expect, test } from "vitest"
import { itemShape } from "./ItemShape"

test("detail shapes narrow the repository using bound item parameters", () => {
  expect(itemShape("/api/shapes/items", "repo_id = $1", "github/o/n", "42")).toEqual({
    where: "repo_id = $1 AND number = $2", params: { "1": "github/o/n", "2": "42" },
  })
  expect(itemShape("/api/shapes/comments", "repo_id = $1", "github/o/n", "42")).toEqual({
    where: "repo_id = $1 AND item_id = $2", params: { "1": "github/o/n", "2": "github/o/n#42" },
  })
  for (const number of ["0", "-1", "01", "2147483648", "1 OR TRUE", ""]) {
    expect(itemShape("/api/shapes/items", "repo_id = $1", "github/o/n", number)).toBeUndefined()
  }
  expect(itemShape("/api/shapes/items", "repo_id = $1", "github/o/n", "2147483647")?.params["2"]).toBe("2147483647")
})

test("repository-wide readers and summary shapes retain their existing scope", () => {
  for (const [path, number] of [["/api/shapes/items", null], ["/api/shapes/item-summaries", "42"]] as const) {
    expect(itemShape(path, "repo_id = $1", "github/o/n", number)).toEqual({ where: "repo_id = $1", params: { "1": "github/o/n" } })
  }
})

import { expect, test } from "bun:test"
import { declarationBindings } from "./DeclarationBindings"

test("exported and indented const bindings have non-overlapping source boundaries", () => {
  const preamble = 'import { Smithers as S } from "@smthrs/targets"\r\n\r\n'
  const blocks = [
    'const first = S.file("first.ts")\r\n',
    'export const second = S.file("second.ts")\r\n',
    '\t export\tconst $third = S.glob([\r\n  "third.ts"\r\n])\r\n'
  ]
  const source = preamble + blocks.join("")
  const bindings = declarationBindings(source)
  expect(bindings.map((binding) => binding.name)).toEqual(["first", "second", "$third"])
  expect(bindings.map((binding) => source.slice(binding.start, binding.end))).toEqual(blocks)
  expect(bindings.map((binding) => source.slice(0, binding.start).split("\n").length)).toEqual([3, 4, 5])
  expect(bindings[0]?.start).toBe(preamble.length)
  expect(bindings.at(-1)?.end).toBe(source.length)
})

test("empty sources and lines without a const assignment have no bindings", () => {
  expect(declarationBindings("")).toEqual([])
  expect(declarationBindings("// const ignored = 1\nlet value = 2\nexport { value }\n")).toEqual([])
})

import { expect, test } from "vitest"
import { sourceText } from "../../../../../packages/repo-targets/test-utils/source-readers.mjs"

test.each(["create", "publish", "update"])("the Worker source asset contains the authored %s flow module byte for byte", async (name) => {
  const source = sourceText(new URL(`./${name}.ts`, import.meta.url))
  await expect(`${JSON.stringify(source)}\n`).toMatchFileSnapshot(`./${name}.source.json`)
})

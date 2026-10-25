import { readFileSync } from "node:fs"
import { expect, test } from "vitest"

test.each(["create", "publish", "update"])("the Worker source asset contains the authored %s flow module byte for byte", async (name) => {
  const source = readFileSync(new URL(`./${name}.ts`, import.meta.url), "utf8")
  await expect(`${JSON.stringify(source)}\n`).toMatchFileSnapshot(`./${name}.source.json`)
})

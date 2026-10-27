import { expect, it } from "vitest"
import { catalogDescriptors } from "../src/Catalog.ts"

// Known broken (cli-1): these advertised install doors have no transport.
it.fails.each(["flow.plan", "flow.source"])("provides an install transport for %s", (name) => {
  const descriptor = catalogDescriptors.find((row) => row.name === name)!
  expect(descriptor.http ?? descriptor.client).toBeDefined()
  expect(descriptor.http ?? descriptor.client).not.toBeNull()
})

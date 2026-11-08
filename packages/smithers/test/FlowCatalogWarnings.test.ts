/** A discovery warning must survive the CLI renderer's plain-data boundary. */
import { Descriptor } from "@smthrs/registry"
import { expect, it } from "vitest"
import * as FlowCatalog from "../src/commands/FlowCatalog.vibe"

it.each([undefined, "refined"])("renders a discovery warning as plain data (name: %s)", (name) => {
  const warning = new Descriptor.DiscoveryWarning({
    code: "unsupported_input_schema",
    path: ".smithers/flows/refined/flow.ts",
    ...(name === undefined ? {} : { name }),
    message: "The input schema requires module evaluation.",
    cause: new Error("private diagnostic")
  })
  const result = FlowCatalog.listing([], "/missing-project", [warning])
  expect(result.warnings).toStrictEqual([{
    code: warning.code,
    path: warning.path,
    ...(name === undefined ? {} : { name }),
    message: warning.message
  }])
})

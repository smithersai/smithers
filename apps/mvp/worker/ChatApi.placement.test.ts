// Where ChatApi runs (worker/ChatApi.ts `placementOf`): a deployment's cloud region, or nothing for the public stack.
import { expect, test } from "vitest"
import { placementOf } from "./ChatApi.ts"

test("a deployment's region places ChatApi beside it; unset, the default; anything else refuses the deploy", () => {
  expect(placementOf("aws:us-east-1")).toEqual({ placement: { region: "aws:us-east-1" } })
  expect([placementOf(undefined), placementOf("")]).toEqual([{}, {}])
  for (const region of ["us-east-1", "enam", "aws:US-EAST-1", "aws:us-east-1 "]) expect(() => placementOf(region)).toThrow("CHATAPI_PLACEMENT_REGION")
})

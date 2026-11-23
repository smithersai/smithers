import { describe, test } from "vitest"
import {
  ERROR_REFERENCE_URL,
  getSmithersErrorDefinition,
  hasSmithersErrorShape,
  isSmithersError,
  isSmithersErrorCode,
  SmithersError,
  smithersErrorCodes
} from "../src/index.ts"

const sampleCode = smithersErrorCodes[0]!
const sampleDetails = { adapter: "github", status: 429, retryAfterMs: 1_500 }
const sampleError = new SmithersError(sampleCode, "Rate limit exceeded", sampleDetails)
const foreignShape = {
  name: "SmithersError",
  _tag: "SmithersError",
  code: sampleCode,
  summary: "Rate limit exceeded",
  message: `Rate limit exceeded See ${ERROR_REFERENCE_URL}`,
  docsUrl: ERROR_REFERENCE_URL,
  details: sampleDetails
}
const nonError = { code: "NOT_A_CODE", message: "nope" }
const repeatedSuffixSummary = `Rate limit exceeded See ${ERROR_REFERENCE_URL} See ${ERROR_REFERENCE_URL}`

describe("@smthrs/errors", () => {
  test("new SmithersError (with details + suffix stripping)", async ({ bench }) => {
    await bench("new SmithersError", () => {
      new SmithersError(sampleCode, repeatedSuffixSummary, sampleDetails)
    }).run({ time: 120, warmupTime: 30 })
  })

  test("isSmithersError + hasSmithersErrorShape classification", async ({ bench }) => {
    await bench("classify error shapes", () => {
      isSmithersError(sampleError)
      hasSmithersErrorShape(foreignShape)
      hasSmithersErrorShape(nonError)
    }).run({ time: 120, warmupTime: 30 })
  })

  test("isSmithersErrorCode + getSmithersErrorDefinition lookup", async ({ bench }) => {
    await bench("code table lookups", () => {
      for (let index = 0; index < smithersErrorCodes.length; index++) {
        const code = smithersErrorCodes[index]!
        if (isSmithersErrorCode(code)) getSmithersErrorDefinition(code)
      }
      isSmithersErrorCode("__proto__")
    }).run({ time: 120, warmupTime: 30 })
  })

  test("SmithersError.toJSON serialization", async ({ bench }) => {
    await bench("toJSON", () => {
      sampleError.toJSON()
    }).run({ time: 120, warmupTime: 30 })
  })
})

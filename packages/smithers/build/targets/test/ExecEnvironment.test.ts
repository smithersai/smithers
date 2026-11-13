import { describe, expect, it } from "vitest"
import * as Environment from "../src/internal/ExecEnvironment.ts"

describe("execution environment host rules", () => {
  it("folds names only on Windows", () => {
    expect(Environment.nameKey("sensitive_token", "win32")).toBe("SENSITIVE_TOKEN")
    expect(Environment.nameKey("sensitive_token", "linux")).toBe("sensitive_token")
  })

  it("inherits Windows names without case sensitivity and omits absent names", () => {
    const env = { Path: "tools", MISSING: undefined }
    expect(Environment.hostValue("PATH", env, "win32")).toBe("tools")
    expect(Environment.hostValue("OTHER", env, "win32")).toBeUndefined()
    expect(Environment.hostValue("MISSING", env, "win32")).toBeUndefined()
    expect(Environment.hostValue("PATH", env, "linux")).toBeUndefined()
    expect(Environment.hostValue("Path", env, "linux")).toBe("tools")
  })

  it("supplies both Unix proxy spellings and one Windows spelling", () => {
    const endpoint = "http://127.0.0.1:3456"
    expect(Environment.proxyVariables(endpoint, "win32")).toEqual({
      HTTP_PROXY: endpoint,
      HTTPS_PROXY: endpoint
    })
    expect(Environment.proxyVariables(endpoint, "linux")).toEqual({
      HTTP_PROXY: endpoint,
      HTTPS_PROXY: endpoint,
      http_proxy: endpoint,
      https_proxy: endpoint
    })
  })
})

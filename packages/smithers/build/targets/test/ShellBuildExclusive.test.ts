import { describe, expect, it } from "vitest"
import { Smithers as S } from "../src/index.ts"
import * as Target from "../src/Target.ts"

describe("Shell.Build exclusive tier", () => {
  it("accepts exclusive: true on Shell.Build and marks the target exclusive", () => {
    const bench = S.Shell.Build({
      shell: "echo ok > report.json",
      outFiles: ["report.json"],
      exclusive: true
    })
    const meta = Target.metadata(bench)
    expect(Target.isExclusive(meta.attrs)).toBe(true)
  })

  it("defaults Shell.Build to non-exclusive when exclusive is omitted", () => {
    const build = S.Shell.Build({
      shell: "echo ok > report.json",
      outFiles: ["report.json"]
    })
    const meta = Target.metadata(build)
    expect(Target.isExclusive(meta.attrs)).toBe(false)
  })
})

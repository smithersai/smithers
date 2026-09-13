import { describe, expect, it } from "@effect/vitest"
import { readFileSync } from "node:fs"

describe("HostLiveness signal-error documentation", () => {
  for (
    const path of [
      "../src/HostLiveness.ts",
      "../docs/guides/answer-run-ownership.md",
      "../docs/troubleshooting.md"
    ]
  ) {
    it(`documents the shared ESRCH-only rule in ${path}`, () => {
      const text = readFileSync(new URL(path, import.meta.url), "utf8")
        .replace(/^ \* ?/gm, "")
        .replace(/\s+/g, " ")

      expect(text).toContain("Both probes use the same `ESRCH`-only death rule.")
      expect(text).toContain("`EPERM`, `EINVAL`, and unknown signal errors preserve liveness.")
      expect(text).not.toContain("code === \"EPERM\"")
    })
  }
})

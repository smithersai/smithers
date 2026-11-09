import { readFileSync } from "node:fs"
import { expect, it } from "vitest"

it.each(["../src/EventSink.vibe", "../docs/guides/model-backed-steps.md", "../docs/api.md"])(
  "%s states that model events reach the sink live",
  (path) => {
    const text = readFileSync(new URL(path, import.meta.url), "utf8").replace(/\s*\*?\s+/g, " ")
    expect(text).toContain("sealed model-call boundary")
    expect(text).toContain("while the provider is still streaming")
    expect(text).not.toContain("after the provider stream settles")
    expect(text).toContain("replay")
  }
)

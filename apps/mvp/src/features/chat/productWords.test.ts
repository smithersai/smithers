import { describe, expect, test } from "vitest"
import { internalNames } from "./productWords"
import { names } from "../../flows/registry.vibe"

describe("internalNames", () => {
  test("reads past a fenced code block the person asked to see: their own code may name a flow", () => {
    const fence = "`".repeat(3)
    expect(internalNames(`Here it is:\n${fence}ts\nflows: ["app/web/open"]\n${fence}\nIt opens the docs.`)).toEqual([])
    expect(internalNames(`${fence}ts\nconst a = 1\n${fence}\nI ran app/web/open.`)).toEqual(["app/web/open"])
    // A longer fence closes a shorter one, as Markdown renders it: what follows is prose.
    expect(internalNames(`${fence}ts\nconst a = 1\n${fence}\`\nI ran app/web/open.\n${fence}\n`)).toEqual(["app/web/open"])
    expect(internalNames(`~~~\nflows: ["app/web/open"]\n~~~~\nDone.`)).toEqual([])
    // Up to three spaces may indent a fence, at either end.
    expect(internalNames(`${fence}ts\nconst a = 1\n  ${fence}\nI ran app/web/open.\n${fence}`)).toEqual(["app/web/open"])
    expect(internalNames(`   ${fence}ts\nflows: ["app/web/open"]\n ${fence}\nDone.`)).toEqual([])
    // A shorter fence never closes a longer one.
    expect(internalNames(`~~~~\napp/web/open\n~~~`)).toEqual(["app/web/open"])
    expect(internalNames(`${fence}\`\napp/web/open\n${fence}`)).toEqual(["app/web/open"])
    // A fence never closed hides nothing.
    expect(internalNames(`${fence}ts\nI ran app/web/open.`)).toEqual(["app/web/open"])
  })

  test("finds the machinery the evals caught, each once, in order", () => {
    expect(
      internalNames(
        "app/web/open refused the javascript: URL (flow_failed): Flow app/web/open failed: WebPageRefused. " +
          "viewId 3f2c1d4e-0a1b-4c2d-8e9f-0123456789ab",
      ),
    ).toEqual(["app/web/open", "flow_failed", "WebPageRefused", "viewId", "3f2c1d4e-0a1b-4c2d-8e9f-0123456789ab"])
  })

  test("finds every registered flow's name, standing alone or in quotes, brackets or code", () => {
    for (const name of names) {
      expect(internalNames(`I called ${name}.`)).toEqual([name])
      expect(internalNames(`(\`${name}\`)`)).toEqual([name])
    }
  })

  test("finds the cell's names, the codes a failed call reads, and a typed failure's tag", () => {
    expect(internalNames("ctx.call then ctx.done")).toEqual(["ctx.call", "ctx.done"])
    expect(internalNames("it was rate_limited, then unknown_flow")).toEqual(["rate_limited", "unknown_flow"])
    expect(internalNames("NavigationRefused, FlowNotFound, NameTaken, DraftNotReady, NotApproved")).toEqual([
      "NavigationRefused",
      "FlowNotFound",
      "NameTaken",
      "DraftNotReady",
      "NotApproved",
    ])
    // The flows eval's flow-delete-denied, 2026-10-22: "the delete was refused (NotApproved)". A plain word passes.
    expect(internalNames("Approved, then not approved.")).toEqual([])
  })

  test("passes what a person reads: slash commands, repositories, paths, URLs, their own flows, plain words", () => {
    for (
      const text of [
        "Dark mode is on. Next time, type /theme dark.",
        "Opened /octocat/Spoon-Knife/blob/main/README.md?L=12 in your tab.",
        "Opened the Effect docs (https://effect.website/docs) in the chat.",
        "See https://example.com/app/navigate and https://example.com/flow/new.",
        "Your flow effect-docs is drafted; save it from its card. Run it with /flow.run effect-docs.",
        "I couldn't open that page: only https pages open. The run was refused, not found or denied.",
        "main is at 6dcb09b5b57875f334f61aebed695e2e4193db5e.",
        "",
      ]
    ) expect([text, internalNames(text)]).toEqual([text, []])
  })
})

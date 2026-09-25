import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, expect, test } from "bun:test"
import { CardSchema } from "@smthrs/rpc/Cards"
import { payloadFor } from "../flows/SlashPayload"

// Other files in the full suite can load React before installing a DOM.
// This browser interaction needs React to detect the real input event path.
if (process.env.SMITHERS_ISSUE_COMMENT_DOM_CHILD !== "1") {
  test("the comment composer preserves Markdown through its browser input and submit events", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, SMITHERS_ISSUE_COMMENT_DOM_CHILD: "1" },
      stdout: "pipe",
      stderr: "pipe"
    })
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text()
    ])
    expect(status, `${stdout}\n${stderr}`).toBe(0)
  }, 10_000)
} else {
  /*
   * react-dom decides at import whether the DOM fires `input` for a controlled
   * field's onChange, so the DOM registers before react-dom and the card load.
   */
  GlobalRegistrator.register()
  const { flushSync } = await import("react-dom")
  const { createRoot } = await import("react-dom/client")
  const { IssueCardBody } = await import("./IssueCards")
  afterAll(async () => {
    for (let tick = 0; tick < 3; tick++) await new Promise(resolve => setTimeout(resolve, 0))
    await GlobalRegistrator.unregister()
  })

  const COMMENT = "First paragraph.\n\n```ts\nconst  x = 1\n  return x\n```\n\n- one\n- two"

  /*
   * The composer's submit is the button door: whatever the person typed reaches
   * issues.comment's grammar byte for byte, and the card's repository is the
   * target even when the known-repository set has not loaded it.
   */
  test("a multi-paragraph Markdown comment reaches issues.comment with its whitespace and repository intact", () => {
    const card = CardSchema.parse({ id: "issue", title: "Issue", status: "active", createdAt: 0, ordinal: 0, kind: "issue", payload: {
      repo: "will/flows", number: 3, title: "Crash", source: "smithers-cloud", state: "open", author: null, issueBody: "", labels: [], comments: []
    } })
    if (card.kind !== "issue") throw Error("Wrong card")
    const commands: Array<readonly [string, string | undefined]> = []
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    flushSync(() => root.render(<IssueCardBody card={card} onRunCommand={(name, args) => { commands.push([name, args]) }} />))
    try {
      const textarea = host.querySelector<HTMLTextAreaElement>("textarea.ghc-composer-input")!
      // React tracks a controlled field's value on the element; a browser types through the prototype setter.
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, `  ${COMMENT}  `)
      flushSync(() => textarea.dispatchEvent(new Event("input", { bubbles: true })))
      flushSync(() => host.querySelector<HTMLButtonElement>('button[data-flow="issues.comment"]')!.click())

      expect(commands.map(([name]) => name)).toEqual(["issues.comment"])
      expect(payloadFor("issues.comment", commands[0]![1], undefined, new Set())).toEqual({
        payload: { number: 3, text: COMMENT, repo: "will/flows" }
      })
      expect(textarea.value).toBe("")
    } finally {
      flushSync(() => root.unmount())
      host.remove()
    }
  })
}

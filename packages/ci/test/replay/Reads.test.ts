import { describe, expect, it } from "vitest"
import { unjailed } from "../../src/replay/Jail.ts"
import { cannotRecord, inPlainWords, readsListener } from "../../src/replay/Reads.vibe"

const line =
  "smthrs: reads are not observed on this host: strace is not installed; a target that asks for it is keyed by its declared inputs\n"
const sentence =
  "this machine cannot record what a step reads (strace is not installed). A step that names no inputs runs on every commit. On Linux, install strace."

describe("readsListener", () => {
  it("gives the sentence for the line, once", () => {
    const hear = readsListener()
    expect(hear(`//:a  ran\n${line}`)).toBe(sentence)
    expect(hear(line)).toBeUndefined()
  })

  it("finds a line that arrives in two chunks", () => {
    const hear = readsListener()
    expect(hear(line.slice(0, 30))).toBeUndefined()
    expect(hear(line.slice(30))).toBe(sentence)
  })

  it("finds the line behind the frame of the display", () => {
    expect(readsListener()(`│  ${line}`)).toBe(sentence)
  })

  it("keeps a reason with no text after it", () => {
    expect(readsListener()("smthrs: reads are not observed on this host: no tracer\r\n")).toBe(
      cannotRecord("no tracer")
    )
  })

  it("ignores a step that prints the words inside its own line", () => {
    const hear = readsListener()
    expect(hear(`//:a: ${line}`)).toBeUndefined()
    expect(hear("nothing to see\n")).toBeUndefined()
  })
})

describe("what a Mac is told", () => {
  // The two reasons as Smithers build and its sandbox give them on macOS.
  const noJail = "write protection needs bubblewrap, which runs only on Linux; this host is darwin"
  const noReads = "reads cannot be observed on darwin"

  it("names the system macOS, as a person does", () => {
    expect(unjailed(noJail)).toBe(
      "steps run without a file-system jail: write protection needs bubblewrap, which runs only on Linux; this host is macOS. Each step still gets a home directory of its own and cannot push with git or start docker or podman by name"
    )
    expect(cannotRecord(noReads)).toBe(
      "this machine cannot record what a step reads (reads cannot be observed on macOS). A step that names no inputs runs on every commit. On Linux, install strace."
    )
    expect(inPlainWords("this host is win32, not darwin; darwin has no strace")).toBe(
      "this host is Windows, not macOS; macOS has no strace"
    )
  })

  it("leaves every other reason as it was given", () => {
    expect(inPlainWords("bubblewrap is not installed; install it with apt-get install bubblewrap")).toBe(
      "bubblewrap is not installed; install it with apt-get install bubblewrap"
    )
    // A word that only holds the name is not the name.
    expect(inPlainWords("the darwinian step")).toBe("the darwinian step")
  })
})

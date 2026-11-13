import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Vm from "node:vm"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as Diagnostic from "../src/Diagnostic.ts"

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "smthrs-diagnostic-fallbacks-"))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

const receipt = (rendered: string): string => readFileSync(rendered.split("Diagnostics: ")[1]!, "utf8")

describe("Diagnostic fallbacks", () => {
  it("answers the fallback when a non-Proxy object throws while its message is inspected", () => {
    // A context global is not a Proxy, yet its property lookup is delegated to
    // the sandbox; this sandbox refuses every descriptor query.
    const sandbox = new Proxy({}, {
      getOwnPropertyDescriptor: () => {
        throw new Error("descriptor query refused")
      }
    })
    const global: unknown = Vm.runInContext("globalThis", Vm.createContext(sandbox))
    expect(Diagnostic.message(global, "inspection refused")).toBe("inspection refused")
  })

  it("answers the fallback when a native Error's message accessor yields a non-string", () => {
    class NumericMessage extends Error {
      override get message(): string {
        return 42 as unknown as string
      }
    }
    expect(Diagnostic.describe(new NumericMessage(), "no readable message")).toBe("no readable message")
  })

  it("answers the fallback when a native Error's message accessor throws", () => {
    class RefusingMessage extends Error {
      override get message(): string {
        throw new Error("accessor refused")
      }
    }
    expect(Diagnostic.describe(new RefusingMessage(), "no readable message")).toBe("no readable message")
  })

  it("presents a designed Error with an empty message as the unknown failure, verbose or not", () => {
    const silent = new Error("")
    expect(Diagnostic.present(silent, { verbose: false })).toBe(Diagnostic.unknownFailure)
    expect(Diagnostic.present(silent, { verbose: true })).toBe(Diagnostic.unknownFailure)
  })

  it("tags a rejected primitive as UnknownFailure with no diagnostic message", () => {
    const rendered = Diagnostic.unexpected("private primitive", directory)
    expect(rendered.startsWith(`${Diagnostic.unknownFailure}\nUnknownFailure: No diagnostic message\n`)).toBe(true)
    expect(receipt(rendered)).toBe("UnknownFailure: No diagnostic message\n")
  })

  it("tags a plain object without _tag as UnknownFailure and keeps its message", () => {
    const rendered = Diagnostic.unexpected({ message: "plain object failure" }, directory)
    expect(receipt(rendered)).toBe("UnknownFailure: plain object failure\n")
  })

  it("names a native Error with no reachable name as Error", () => {
    const orphan = new Error("orphaned failure")
    Object.setPrototypeOf(orphan, null)
    const rendered = Diagnostic.unexpected(orphan, directory)
    expect(receipt(rendered)).toBe("Error: orphaned failure\n")
  })
})

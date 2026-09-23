import { expect, it, vi } from "vitest"
import * as Options from "../../src/flow/Options.ts"

vi.mock("node:path", async (importOriginal) => {
  const path = await importOriginal<typeof import("node:path")>()
  return { ...path.win32, default: path.win32 }
})

it.each(["C:\\", "C:\\work\\project", "\\\\server\\share\\", "\\\\server\\share\\project"])(
  "accepts normalized Windows project root %s",
  (root) => expect(Options.layoutIssue({ root })).toBeUndefined()
)

it.each(["C:", "C:project", "C:\\work\\..\\project", "C:\\work\\project\\", "\\\\server\\share\\project\\"])(
  "refuses non-absolute or non-normalized Windows project root %s",
  (root) => expect(Options.layoutIssue({ root })).toMatch(/absolute|normalized/)
)

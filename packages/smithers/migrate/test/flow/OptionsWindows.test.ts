import { expect, it } from "vitest"
import * as Options from "../../src/flow/Options.ts"

it.each(["C:\\", "C:\\work\\project", "\\\\server\\share\\", "\\\\server\\share\\project"])(
  "accepts normalized Windows project root %s",
  (root) => expect(Options.layoutIssue({ root })).toBeUndefined()
)

it.each(["C:", "C:project", "C:\\work\\..\\project", "C:\\work\\project\\", "\\\\server\\share\\project\\"])(
  "refuses non-absolute or non-normalized Windows project root %s",
  (root) => expect(Options.layoutIssue({ root })).toMatch(/absolute|normalized/)
)

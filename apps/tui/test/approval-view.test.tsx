import { testRender } from "@opentui/react/test-utils"
import { afterEach, expect, test } from "bun:test"
import { act } from "react"
import * as Approvals from "../src/approvals.ts"
import * as View from "../src/view.tsx"

let setup: Awaited<ReturnType<typeof testRender>> | undefined
afterEach(async () => {
  await act(async () => {
    setup?.renderer.destroy()
    setup = undefined
  })
})

test.each([
  { name: "long ASCII", content: `${"x".repeat(90)}; console.log(1)`, visible: `${"x".repeat(74)}…` },
  { name: "wide characters", content: "界".repeat(38), visible: `${"界".repeat(37)}…` },
  { name: "emoji graphemes", content: "👨‍👩‍👧‍👦".repeat(38), visible: `${"👨‍👩‍👧‍👦".repeat(37)}…` },
  { name: "combining marks", content: "é".repeat(76), visible: `${"é".repeat(74)}…` },
  { name: "exact fit", content: "x".repeat(75), visible: "x".repeat(75) },
  { name: "tabs", content: "a\tb", visible: "a  b" }
])("approval bounds $name content with visible omissions at 80×24", async ({ content, visible }) => {
  setup = await testRender(
    <View.Approval
      request={{ flow: "edit", subject: "math.js", preview: { added: 1, removed: 0, lines: [`+${content}`] } }}
      width={80}
      choices={Approvals.choices({ action: "fs:write", flow: "edit", always: true })}
      armed
      more={0}
      lines={1}
    />,
    { width: 80, height: 24 }
  )
  await setup.renderOnce()
  const frame = setup.captureCharFrame()
  const rows = frame.split("\n").filter((row) => row.trim() !== "")
  expect(rows).toHaveLength(3)
  expect(rows[0]).toContain("? edit math.js  +1 −0")
  expect(rows[1]?.trim()).toBe(`+ ${visible}`)
  expect(rows[2]).toContain("y Allow once  n Deny change  a Allow edits this run")
})

test("a bash approval shows each line the shell runs on its own row, never one joined command", async () => {
  setup = await testRender(
    <View.Approval
      request={{ flow: "bash", subject: "echo ok\nrm -rf x" }}
      width={80}
      choices={Approvals.choices({ action: "proc:spawn", flow: "bash", always: true })}
      armed
      more={0}
      lines={1}
    />,
    { width: 80, height: 24 }
  )
  await setup.renderOnce()
  const rows = setup.captureCharFrame().split("\n").filter((row) => row.trim() !== "")
  expect(rows[0]?.trim()).toBe("? run echo ok⏎")
  expect(rows[1]?.trim()).toBe("rm -rf x")
  expect(rows.join("\n")).not.toContain("echo ok rm -rf x")
})

test("a bash approval shows bidi overrides and zero-width characters as �, and keeps spacing", () => {
  expect(Approvals.legible("echo ‮abc​")).toBe("echo �abc�")
  expect(Approvals.legible("a  b\tc")).toBe("a  b⇥c")
  expect(Approvals.legible("a b\r\nc")).toBe("a�b�⏎\nc")
  expect(Approvals.refusal({ flow: "bash", subject: "echo ‮ok" })).toContain("bash echo �ok.")
})

import { describe, expect, it } from "bun:test"

import { pickDirectoryWithNativeDialog } from "@/services/native-folder-picker-service"

describe("pickDirectoryWithNativeDialog", () => {
  it("returns the selected absolute path from osascript", () => {
    const path = pickDirectoryWithNativeDialog({
      platform: "darwin",
      runCommand: () => ({
        exitCode: 0,
        stdout: "/Users/alex/code/repo/\n",
        stderr: "",
      }),
    })

    expect(path).toBe("/Users/alex/code/repo")
  })

  it("returns null when the picker is canceled", () => {
    const path = pickDirectoryWithNativeDialog({
      platform: "darwin",
      runCommand: () => ({
        exitCode: 1,
        stdout: "",
        stderr: "execution error: User canceled. (-128)",
      }),
    })

    expect(path).toBeNull()
  })

  it("throws for unsupported platforms", () => {
    expect(() =>
      pickDirectoryWithNativeDialog({
        platform: "linux",
        runCommand: () => ({
          exitCode: 0,
          stdout: "",
          stderr: "",
        }),
      })
    ).toThrow("Native folder picker is currently supported only on macOS")
  })
})

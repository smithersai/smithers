import { describe, expect, test } from "bun:test"
import { darwinKeychain } from "./CloudAuth"
import type { KeychainRun } from "./CloudAuth"

/*
 * The macOS keychain writer's process boundary. The serialized
 * CloudCredentials carry the Smithers Cloud PAT, and a child's argv is
 * readable by every same-user process and recorded by exec auditing, so the
 * secret must reach `security` on stdin only. A recording run double stands
 * in for the real binary.
 */
const recordingRun = (): KeychainRun & { readonly calls: Array<{ readonly argv: ReadonlyArray<string>; readonly stdin: string | undefined }> } => {
  const calls: Array<{ readonly argv: ReadonlyArray<string>; readonly stdin: string | undefined }> = []
  const run = async (argv: ReadonlyArray<string>, stdin?: string) => {
    calls.push({ argv, stdin })
    return { code: 0, stdout: "" }
  }
  return Object.assign(run, { calls })
}

describe("darwin keychain writer", () => {
  const token = "smithers_pat_7f3c9a"
  const secret = JSON.stringify({ token, username: "octo \"cat\"", email: null, expiresAt: null })

  test("keeps the token and the serialized credentials out of argv", async () => {
    const run = recordingRun()
    await darwinKeychain(run).write("smithers-cloud", "api.smithers.sh", secret)

    expect(run.calls).toHaveLength(1)
    const [call] = run.calls
    for (const arg of call!.argv) {
      expect(arg).not.toContain(token)
      expect(arg).not.toContain(secret)
    }
    expect(call!.stdin).toBeDefined()
    expect(call!.stdin).not.toContain(token)
  })

  test("sends the secret on stdin as the hex password of an interactive add", async () => {
    const run = recordingRun()
    await darwinKeychain(run).write("smithers-cloud", "api.smithers.sh", secret)

    const [call] = run.calls
    expect(call!.argv).toEqual(["security", "-i"])
    const hex = Buffer.from(secret, "utf8").toString("hex")
    expect(call!.stdin).toBe(`add-generic-password -U -s "smithers-cloud" -a "api.smithers.sh" -X ${hex}\n`)
  })

  test("refuses a service or account that would break the command line", async () => {
    const run = recordingRun()
    await darwinKeychain(run).write("smithers-cloud", "evil\" -w x\nhost", secret)
    expect(run.calls).toHaveLength(0)
  })
})

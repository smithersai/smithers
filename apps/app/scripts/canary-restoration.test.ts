import { describe, expect, test } from "bun:test"
import { RestorationFailure, withVerifiedRestoration } from "./canary-restoration.ts"

describe("withVerifiedRestoration", () => {
  test("restores and verifies after the protected work fails", async () => {
    const calls: string[] = []
    await expect(
      withVerifiedRestoration(
        async () => {
          calls.push("work")
          throw new Error("probe failed")
        },
        async () => {
          calls.push("restore")
        },
        async () => {
          calls.push("verify")
        },
        "manual recovery"
      )
    ).rejects.toThrow("probe failed")
    expect(calls).toEqual(["work", "restore", "verify"])
  })

  test("makes restoration failure louder than the probe failure", async () => {
    const result = withVerifiedRestoration(
      async () => {
        throw new Error("probe failed")
      },
      async () => {
        throw new Error("restore returned HTTP 500")
      },
      async () => {},
      "re-add the fixture out of band"
    )
    await expect(result).rejects.toBeInstanceOf(RestorationFailure)
    await expect(result).rejects.toThrow("RECOVERY REQUIRED: re-add the fixture out of band")
  })

  test("treats a failed restored-state read as restoration failure", async () => {
    await expect(
      withVerifiedRestoration(
        async () => "result",
        async () => {},
        async () => {
          throw new Error("state is still mutated")
        },
        "restore it manually"
      )
    ).rejects.toBeInstanceOf(RestorationFailure)
  })
})

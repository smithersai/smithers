import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { commandRunner } from "../release-support/io.ts"
import { redactingTail } from "../release-support/redaction.ts"
import { ReleaseError } from "../release-support/schema.ts"

test("command failures redact credentials under any credential name and across the tail cut", async (test) => {
  const root = await mkdtemp(join(tmpdir(), "release-redaction-"))
  test.after(() => rm(root, { recursive: true, force: true }))
  const pat = "ghp_fakePersonalAccessTokenValue"
  const auth = "npm-fake-auth-value-for-redaction"
  const explicit = "explicit-step-secret-value-0123"
  // The PAT straddles the 6000-character stdout tail cut.
  const script = [
    "const e = process.env",
    "process.stdout.write(e.GH_PAT.slice(0, 10) + e.GH_PAT.slice(10) + 'x'.repeat(6000 - e.GH_PAT.length + 10))",
    "process.stderr.write(e.NPM_CONFIG__AUTH + ' ' + e.STEP_VALUE + ' ' + e.DEPLOY_CREDENTIAL)",
    "process.exitCode = 1"
  ].join(";")
  await assert.rejects(
    commandRunner(root)(process.execPath, ["-e", script], {
      env: { GH_PAT: pat, NPM_CONFIG__AUTH: auth, STEP_VALUE: explicit, DEPLOY_CREDENTIAL: "cred-9876" }
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      for (const leaked of [pat.slice(10), auth, explicit, "cred-9876"]) {
        assert.ok(!error.message.includes(leaked), `diagnostic leaked ${leaked}`)
      }
      return true
    }
  )
})

test("command failures keep benign session and socket values legible", async (test) => {
  const root = await mkdtemp(join(tmpdir(), "release-redaction-"))
  test.after(() => rm(root, { recursive: true, force: true }))
  const sessionKey = "sess-fake-key-0123"
  // Inherited, as on a Linux release runner; only the step's own values are explicit.
  const saved = { XDG_SESSION_CLASS: process.env.XDG_SESSION_CLASS, SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK }
  test.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  process.env.XDG_SESSION_CLASS = "user"
  process.env.SSH_AUTH_SOCK = root
  const script = [
    "const e = process.env",
    "process.stderr.write([e.XDG_SESSION_CLASS, e.SSH_AUTH_SOCK, e.APP_SESSION_KEY].join(' '))",
    "process.exitCode = 1"
  ].join(";")
  await assert.rejects(
    commandRunner(root)(process.execPath, ["-e", script], {
      env: { APP_SESSION_KEY: sessionKey }
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, new RegExp(`user ${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} <redacted>`))
      assert.ok(!error.message.includes(sessionKey), "diagnostic leaked the session key")
      return true
    }
  )
})

// A credential exceeds the rolling stderr window and crosses several real pipe writes.
for (const inherited of [false, true]) {
  test(`command failures redact long ${inherited ? "inherited" : "explicit"} credentials before trimming stderr`, async (t) => {
    const key = inherited ? "TEST_CREDENTIAL" : "STEP_VALUE"
    const secret = "credential-prefix:" + "sensitive-value-".repeat(2700) + ":credential-suffix"
    const previous = process.env[key]
    if (inherited) {
      process.env[key] = secret
      t.after(() => {
        if (previous === undefined) delete process.env[key]
        else process.env[key] = previous
      })
    }
    const script = [
      "const value = process.env." + key,
      "process.stderr.write('discarded'.repeat(4000) + '\\nstart:')",
      "process.stderr.write(value.slice(0, 12000))",
      "setTimeout(() => { process.stderr.write(value.slice(12000, 33000)); setTimeout(() => { process.stderr.write(value.slice(33000) + ':end'); process.exitCode = 1 }, 25) }, 25)"
    ].join(";")
    await assert.rejects(
      commandRunner(import.meta.dirname)(process.execPath, ["-e", script], {
        env: inherited ? {} : { [key]: secret }
      }),
      (error: unknown) => {
        assert.ok(error instanceof ReleaseError)
        assert.ok(!error.message.includes("sensitive-value"), "stderr exposed a credential fragment")
        assert.ok(!error.message.includes("credential-suffix"), "stderr exposed the credential suffix")
        assert.ok(
          error.message.endsWith("\nstart:<redacted>:end"),
          "stderr lost the redacted credential or safe context"
        )
        assert.ok(error.message.length <= process.execPath.length + 6020)
        return true
      }
    )
  })
}

test("redacted tails preserve safe text for every split of overlapping and literal credentials", () => {
  const cases: ReadonlyArray<readonly [ReadonlyArray<string>, string, string]> = [
    [[], "", ""],
    [[], "ordinary output", "ordinary output"],
    [[""], "no credential", "no credential"],
    [["abc", "abcdef"], "xabcdefabc-y", "x<redacted><redacted>-y"],
    [["def", "abc"], "abcdef", "<redacted><redacted>"],
    [["abc", "bcde"], "abcde", "<redacted>"],
    [["abcd", "cdef"], "abcdef", "<redacted>"],
    [["aba"], "ababa", "<redacted>"],
    [["aab"], "aaaab-aab-aax", "aa<redacted>-<redacted>-aax"],
    [["🔑秘密cred"], "before:🔑秘密cred:after", "before:<redacted>:after"],
    [["[a-z]+$"], "[a-z]+$ then [a-z]+", "<redacted> then [a-z]+"],
    [["credential"], "creden", "creden"]
  ]
  for (const [secrets, input, expected] of cases) {
    for (let split = 0; split <= input.length; split++) {
      const tail = redactingTail(secrets, 100)
      tail.write(input.slice(0, split))
      assert.equal(tail.end(input.slice(split)), expected, `split ${split} of ${input}`)
    }
    const tail = redactingTail(secrets, 100)
    for (const character of input) tail.write(character)
    assert.equal(tail.end(), expected)
  }
})

test("redacted tails trim redacted output, keeping surrounding diagnostics across the rolling boundary", () => {
  const secret = "private-credential-" + "s".repeat(40_000)
  const tail = redactingTail([secret, "short-secret"], 32_000)
  tail.write("discarded".repeat(4000) + "\nstart:")
  for (let offset = 0; offset < secret.length; offset += 997) tail.write(secret.slice(offset, offset + 997))
  tail.write(":middle:short-")
  tail.write("secret:end")
  const diagnostic = tail.end()
  assert.equal(diagnostic.length, 32_000)
  assert.ok(diagnostic.endsWith("\nstart:<redacted>:middle:<redacted>:end"))
  assert.ok(!diagnostic.includes("private-credential"))
  assert.ok(!diagnostic.includes("ss"))
  assert.equal(redactingTail([], 5).end("0123456789"), "56789")
})

test("redacted tails cover a long credential beginning inside an earlier short match", () => {
  const long = "credential" + "x".repeat(40_000)
  const input = "before:prefix-" + long + ":end"
  for (const size of [1, 997, input.length]) {
    const tail = redactingTail(["prefix-credential", long], 32_000)
    for (let offset = 0; offset < input.length; offset += size) tail.write(input.slice(offset, offset + size))
    assert.equal(tail.end(), "before:<redacted>:end")
  }
})

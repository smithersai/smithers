import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it, vi } from "vitest"
import { stackName } from "../deployment.ts"
import {
  defaultStateDirectory,
  maximumStateFileBytes,
  redactAlchemyState,
  resolveRedactionOptions
} from "./redact-state.ts"
import { acquireStateOwnership } from "./state-ownership.ts"

const sentinel = "__SMITHERS_CACHE_TOKEN_REDACTED__"
const infraRoot = NodePath.resolve(fileURLToPath(new URL("..", import.meta.url).href))
const script = fileURLToPath(new URL("./redact-state.ts", import.meta.url).href)
const verifierOf = (token: string): string => createHash("sha256").update(token, "utf8").digest("hex")

const workerState = (bindingName: string, value: string): string =>
  JSON.stringify({
    props: { env: { [bindingName]: { __redacted__: value } } },
    bindings: [{
      sid: bindingName,
      data: { bindings: [{ type: "secret_text", name: bindingName, text: value }] }
    }]
  })

const withFixture = async <A>(use: (root: string) => Promise<A>): Promise<A> => {
  const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smithers-build-redaction-")))
  try {
    return await use(root)
  } finally {
    await Fs.rm(root, { recursive: true, force: true })
  }
}

describe("redactAlchemyState", () => {
  it("atomically replaces every matching legacy token representation", async () => {
    await withFixture(async (root) => {
      const directory = NodePath.join(root, "nested")
      const file = NodePath.join(directory, "CacheWorker.json")
      const token = "this-is-a-raw-secret-token"
      await Fs.mkdir(directory)
      await Fs.writeFile(
        file,
        JSON.stringify({
          props: { env: { CACHE_TOKEN: { __redacted__: token } } },
          bindings: [{
            sid: "CACHE_TOKEN",
            data: {
              bindings: [
                { type: "secret_text", name: "CACHE_TOKEN", text: token },
                { type: "secret_text", name: "OTHER_TOKEN", text: token }
              ]
            }
          }]
        }),
        { mode: 0o644 }
      )

      expect(await redactAlchemyState({ directory: root, bearerToken: token })).toBe(1)
      const text = await Fs.readFile(file, "utf8")
      expect(JSON.parse(text)).toEqual({
        props: { env: { CACHE_TOKEN: { __redacted__: "__SMITHERS_CACHE_TOKEN_REDACTED__" } } },
        bindings: [{
          sid: "CACHE_TOKEN",
          data: {
            bindings: [
              { type: "secret_text", name: "CACHE_TOKEN", text: "__SMITHERS_CACHE_TOKEN_REDACTED__" },
              { type: "secret_text", name: "OTHER_TOKEN", text: token }
            ]
          }
        }]
      })
      if (process.platform !== "win32") expect((await Fs.stat(file)).mode & 0o777).toBe(0o600)
    })
  })

  /**
   * The Worker's one credential became two, so its bindings are named
   * `CACHE_READ_TOKEN` and `CACHE_WRITE_TOKEN`. Redaction that still looked
   * only for `CACHE_TOKEN` would silently stop scrubbing anything.
   */
  it.each(["CACHE_READ_TOKEN", "CACHE_WRITE_TOKEN"])("redacts the %s binding too", async (name) => {
    await withFixture(async (root) => {
      const file = NodePath.join(root, "CacheWorker.json")
      const token = "this-is-a-raw-secret-token"
      await Fs.writeFile(
        file,
        JSON.stringify({
          props: { env: { [name]: { __redacted__: token } } },
          bindings: [{
            sid: name,
            data: { bindings: [{ type: "secret_text", name, text: token }] }
          }]
        })
      )

      expect(await redactAlchemyState({ directory: root, bearerToken: token })).toBe(1)
      expect(await Fs.readFile(file, "utf8")).not.toContain(token)
    })
  })

  it("leaves state that already holds only the sentinel and the current verifier", async () => {
    await withFixture(async (root) => {
      const token = "the-currently-configured-bearer"
      const file = NodePath.join(root, "CacheWorker.json")
      await Fs.writeFile(
        file,
        JSON.stringify({
          props: { env: { CACHE_READ_TOKEN: { __redacted__: verifierOf(token) } } },
          bindings: [{
            sid: "CACHE_TOKEN",
            data: { bindings: [{ type: "secret_text", name: "CACHE_TOKEN", text: sentinel }] }
          }]
        })
      )
      const before = await Fs.stat(file, { bigint: true })

      expect(await redactAlchemyState({ directory: root, bearerToken: token })).toBe(0)

      const after = await Fs.stat(file, { bigint: true })
      expect(after.ino).toBe(before.ino)
      expect(after.mtimeNs).toBe(before.mtimeNs)
    })
  })

  /**
   * Matching known bearer values only ever scrubbed what the current
   * environment already knew. A credential rotated away, or a deployment run
   * without the previous variable, left the old value in place while the
   * wrapper still printed a successful redaction count.
   */
  it("replaces a credential value that no configured bearer derives", async () => {
    await withFixture(async (root) => {
      const file = NodePath.join(root, "CacheWorker.json")
      await Fs.writeFile(file, workerState("CACHE_WRITE_TOKEN", verifierOf("the-previous-bearer")))

      expect(await redactAlchemyState({ directory: root, bearerToken: "the-rotated-in-bearer" })).toBe(1)

      const state = await Fs.readFile(file, "utf8")
      expect(state).not.toContain(verifierOf("the-previous-bearer"))
      expect(JSON.parse(state).props.env.CACHE_WRITE_TOKEN.__redacted__).toBe(sentinel)
      // A second pass has nothing left to do.
      expect(await redactAlchemyState({ directory: root, bearerToken: "the-rotated-in-bearer" })).toBe(0)
    })
  })

  it.each([
    ["credential members", `{"props":{"env":{"CACHE_WRITE_TOKEN":"raw-token","CACHE_WRITE_TOKEN":"${sentinel}"}}}`],
    ["escaped credential members", String.raw`{"props":{"env":{"CACHE_WRITE_TOKEN":"raw-token","CACHE_WRITE_\u0054OKEN":"${sentinel}"}}}`],
    ["ancestor members", '{"props":{"env":{"CACHE_WRITE_TOKEN":"raw-token"}},"props":{}}'],
    ["escaped ancestor members", String.raw`{"props":{"env":{"CACHE_WRITE_TOKEN":"raw-token"}},"\u0070rops":{}}`],
    ["members in an array", '[{"extra":"raw-token","extra":null}]']
  ])("refuses duplicate %s before declaring the original bytes clean", async (_case, input) => {
    await withFixture(async (root) => {
      const file = NodePath.join(root, "CacheWorker.json")
      await Fs.writeFile(file, input)

      await expect(redactAlchemyState({ directory: root, bearerToken: "token" })).rejects.toThrow(
        /duplicate object member name/
      )
      expect(await Fs.readFile(file, "utf8")).toBe(input)
    })
  })

  it("keeps equal member names in separate objects and escaped string contents", async () => {
    await withFixture(async (root) => {
      const file = NodePath.join(root, "CacheWorker.json")
      const input = JSON.stringify({
        first: { same: 'braces {}, commas, colon: and a quote " and slash \\' },
        second: [{ same: null }, { same: true }],
        empty: {},
        tail: false
      }, null, 2)
      await Fs.writeFile(file, input)

      expect(await redactAlchemyState({ directory: root, bearerToken: "token" })).toBe(0)
      expect(await Fs.readFile(file, "utf8")).toBe(input)
    })
  })

  it.each(["null", "true", "5", '"text"', '[{"CACHE_TOKEN":"' + sentinel + '"}]'])(
    "leaves a provably clean root %s unchanged",
    async (input) => {
      await withFixture(async (root) => {
        const file = NodePath.join(root, "CacheWorker.json")
        await Fs.writeFile(file, input)

        expect(await redactAlchemyState({ directory: root, bearerToken: "token" })).toBe(0)
        expect(await Fs.readFile(file, "utf8")).toBe(input)
      })
    }
  )

  it("refuses a credential-bearing array root", async () => {
    await withFixture(async (root) => {
      const file = NodePath.join(root, "CacheWorker.json")
      const input = `[${workerState("CACHE_WRITE_TOKEN", "raw-token")}]`
      await Fs.writeFile(file, input)

      await expect(redactAlchemyState({ directory: root, bearerToken: "token" })).rejects.toThrow(
        /unrecognized shape for credential binding CACHE_WRITE_TOKEN/
      )
      expect(await Fs.readFile(file, "utf8")).toBe(input)
    })
  })

  it.each(["CacheWorker.json.123.abc.tmp", "CacheWorker.json.backup"])(
    "scrubs a leftover %s beside the current state",
    async (name) => {
      await withFixture(async (root) => {
        await Fs.writeFile(NodePath.join(root, "CacheWorker.json"), workerState("CACHE_TOKEN", sentinel))
        const file = NodePath.join(root, name)
        await Fs.writeFile(file, workerState("CACHE_TOKEN", "raw-token"))

        expect(await redactAlchemyState({ directory: root, bearerToken: "token" })).toBe(1)
        expect(await Fs.readFile(file, "utf8")).not.toContain("raw-token")
        expect(await redactAlchemyState({ directory: root, bearerToken: "token" })).toBe(0)
      })
    }
  )

  it("refuses an unreadable Alchemy temporary sibling", async () => {
    await withFixture(async (root) => {
      await Fs.writeFile(NodePath.join(root, "CacheWorker.json"), "{}")
      await Fs.writeFile(NodePath.join(root, "CacheWorker.json.123.abc.tmp"), "{")

      await expect(redactAlchemyState({ directory: root, bearerToken: "token" })).rejects.toThrow(/not valid JSON/)
    })
  })

  it("can redact a deeply nested replacement again", async () => {
    await withFixture(async (root) => {
      const file = NodePath.join(root, "CacheWorker.json")
      // robustness-2.ts: indentation expands this 180 KB input past 16 MiB.
      const filler = `${"[".repeat(100)}${"0,".repeat(89_999)}0${"]".repeat(100)}`
      const input = `{"props":{"env":{"CACHE_TOKEN":{"__redacted__":"old"}}},"filler":${filler}}`
      expect(Buffer.byteLength(input)).toBeLessThan(maximumStateFileBytes)
      await Fs.writeFile(file, input)

      expect(await redactAlchemyState({ directory: root, bearerToken: "token" })).toBe(1)
      expect(await redactAlchemyState({ directory: root, bearerToken: "token" })).toBe(0)
      const output = await Fs.readFile(file, "utf8")
      expect(Buffer.byteLength(output)).toBeLessThanOrEqual(maximumStateFileBytes)
      expect(JSON.parse(output)).toEqual({
        ...JSON.parse(input),
        props: { env: { CACHE_TOKEN: { __redacted__: sentinel } } }
      })
    })
  })

  it("scrubs every credential environment variable when no token is supplied", async () => {
    await withFixture(async (root) => {
      const configured = "the-read-bearer"
      vi.stubEnv("SMITHERS_CACHE_READ_TOKEN", configured)
      vi.stubEnv("SMITHERS_CACHE_WRITE_TOKEN", "")
      vi.stubEnv("SMITHERS_CACHE_TOKEN", "the-legacy-bearer")
      try {
        const file = NodePath.join(root, "CacheWorker.json")
        await Fs.writeFile(
          file,
          JSON.stringify({
            props: {
              env: {
                CACHE_READ_TOKEN: { __redacted__: verifierOf(configured) },
                CACHE_WRITE_TOKEN: { __redacted__: "a-value-no-configured-bearer-derives" },
                CACHE_TOKEN: { __redacted__: "the-legacy-bearer" }
              }
            }
          })
        )

        // This is the only path scripts/deploy.ts ever takes.
        expect(await redactAlchemyState({ directory: root })).toBe(1)

        const state = JSON.parse(await Fs.readFile(file, "utf8"))
        expect(state.props.env.CACHE_READ_TOKEN.__redacted__).toBe(verifierOf(configured))
        expect(state.props.env.CACHE_WRITE_TOKEN.__redacted__).toBe(sentinel)
        expect(state.props.env.CACHE_TOKEN.__redacted__).toBe(sentinel)
      } finally {
        vi.unstubAllEnvs()
      }
    })
  })

  it("replaces a credential value that is not a string at all", async () => {
    await withFixture(async (root) => {
      const file = NodePath.join(root, "CacheWorker.json")
      // A string-only match walks past both of these while the wrapper still
      // prints a successful redaction count.
      await Fs.writeFile(
        file,
        JSON.stringify({
          props: {
            env: {
              CACHE_WRITE_TOKEN: { __redacted__: { raw: "rotated-away-bearer" } },
              CACHE_TOKEN: "a-directly-stored-bearer"
            }
          },
          bindings: [{
            sid: "CACHE_WRITE_TOKEN",
            data: {
              bindings: [{ type: "secret_text", name: "CACHE_WRITE_TOKEN", text: { raw: "rotated-away-bearer" } }]
            }
          }]
        })
      )

      expect(await redactAlchemyState({ directory: root, bearerToken: "the-current-bearer" })).toBe(1)

      const state = await Fs.readFile(file, "utf8")
      expect(state).not.toContain("rotated-away-bearer")
      expect(state).not.toContain("a-directly-stored-bearer")
      const parsed = JSON.parse(state)
      expect(parsed.props.env.CACHE_WRITE_TOKEN.__redacted__).toBe(sentinel)
      expect(parsed.props.env.CACHE_TOKEN).toBe(sentinel)
      expect(parsed.bindings[0].data.bindings[0].text).toBe(sentinel)
    })
  })

  it("refuses a credential binding whose shape it cannot prove is credential free", async () => {
    await withFixture(async (root) => {
      await Fs.writeFile(
        NodePath.join(root, "CacheWorker.json"),
        JSON.stringify({ props: { env: { CACHE_READ_TOKEN: { unexpected: "shape" } } } })
      )

      await expect(redactAlchemyState({ directory: root, bearerToken: "the-current-bearer" })).rejects.toThrow(
        /unrecognized shape for credential binding CACHE_READ_TOKEN/
      )
    })
  })

  it("refuses sibling fields beside a recognized environment verifier", async () => {
    await withFixture(async (root) => {
      await Fs.writeFile(
        NodePath.join(root, "CacheWorker.json"),
        JSON.stringify({
          props: {
            env: {
              CACHE_READ_TOKEN: {
                __redacted__: sentinel,
                raw: "bearer-hidden-beside-the-sentinel"
              }
            }
          }
        })
      )

      await expect(redactAlchemyState({ directory: root, bearerToken: "token" })).rejects.toThrow(
        /unrecognized shape for credential binding CACHE_READ_TOKEN/
      )
    })
  })

  it("refuses a bearer token that is the redaction sentinel", async () => {
    await expect(redactAlchemyState({ directory: Os.tmpdir(), bearerToken: sentinel })).rejects.toThrow(
      /must not be the redaction sentinel/
    )
  })

  it("redacts a credential-named native binding regardless of its declared type", async () => {
    await withFixture(async (root) => {
      const file = NodePath.join(root, "CacheWorker.json")
      await Fs.writeFile(
        file,
        JSON.stringify({
          bindings: [{
            sid: "CACHE_TOKEN",
            data: { bindings: [{ type: "plain_text", name: "CACHE_TOKEN", text: "public" }] }
          }]
        })
      )

      expect(await redactAlchemyState({ directory: root, bearerToken: "token" })).toBe(1)
      expect(JSON.parse(await Fs.readFile(file, "utf8")).bindings[0].data.bindings[0].text).toBe(sentinel)
    })
  })

  it("redacts a credential-named native binding beneath an unrelated outer binding", async () => {
    await withFixture(async (root) => {
      const file = NodePath.join(root, "CacheWorker.json")
      await Fs.writeFile(
        file,
        JSON.stringify({
          bindings: [{
            sid: "OTHER_BINDING",
            data: { bindings: [{ type: "plain_text", name: "CACHE_TOKEN", text: "raw-token" }] }
          }]
        })
      )

      expect(await redactAlchemyState({ directory: root, bearerToken: "token" })).toBe(1)
      expect(JSON.parse(await Fs.readFile(file, "utf8")).bindings[0].data.bindings[0].text).toBe(sentinel)
    })
  })

  it.each([
    [
      "an outer credential binding without a credential-named native entry",
      {
        bindings: [{
          sid: "CACHE_TOKEN",
          data: { bindings: [{ type: "plain_text", name: "OTHER_TOKEN", text: "raw-token" }] }
        }]
      },
      "CACHE_TOKEN"
    ],
    [
      "a credential-named native entry nested below the supported shape",
      {
        bindings: [{
          sid: "OTHER_BINDING",
          data: {
            bindings: [{
              type: "wrapper",
              name: "OTHER_TOKEN",
              value: { type: "secret_text", name: "CACHE_READ_TOKEN", text: "raw-token" }
            }]
          }
        }]
      },
      "CACHE_READ_TOKEN"
    ],
    [
      "a credential moved outside props.env",
      { props: { legacy: { CACHE_WRITE_TOKEN: "raw-token" } } },
      "CACHE_WRITE_TOKEN"
    ]
  ])("refuses %s", async (_case, state, name) => {
    await withFixture(async (root) => {
      await Fs.writeFile(NodePath.join(root, "CacheWorker.json"), JSON.stringify(state))

      await expect(redactAlchemyState({ directory: root, bearerToken: "token" })).rejects.toThrow(
        new RegExp(`unrecognized shape for credential binding ${name}`)
      )
    })
  })

  /**
   * The document-wide audit refuses a credential name it cannot prove clean.
   * It must not refuse one it can: an Alchemy state file that echoes the
   * worker's inputs into a second field carries the same already-scrubbed
   * value there, and refusing that would fail every deployment after the
   * first with no credential at risk.
   */
  it.each([
    ["a record echo of the current verifier", { __redacted__: verifierOf("token") }],
    ["a record echo of the sentinel", { __redacted__: sentinel }],
    ["a bare sentinel string", sentinel]
  ])("accepts %s under a credential name outside the handled shapes", async (_case, echo) => {
    await withFixture(async (root) => {
      const file = NodePath.join(root, "CacheWorker.json")
      await Fs.writeFile(
        file,
        JSON.stringify({
          props: { env: { CACHE_READ_TOKEN: { __redacted__: verifierOf("token") } } },
          output: { env: { CACHE_READ_TOKEN: echo } }
        })
      )

      expect(await redactAlchemyState({ directory: root, bearerToken: "token" })).toBe(0)
      expect(JSON.parse(await Fs.readFile(file, "utf8")).output.env.CACHE_READ_TOKEN).toEqual(echo)
    })
  })

  it("refuses an unhandled credential name whose echo is not provably clean", async () => {
    await withFixture(async (root) => {
      await Fs.writeFile(
        NodePath.join(root, "CacheWorker.json"),
        JSON.stringify({
          props: { env: { CACHE_READ_TOKEN: { __redacted__: verifierOf("token") } } },
          output: { env: { CACHE_READ_TOKEN: { __redacted__: "raw-token" } } }
        })
      )

      await expect(redactAlchemyState({ directory: root, bearerToken: "token" })).rejects.toThrow(
        /unrecognized shape for credential binding CACHE_READ_TOKEN/
      )
    })
  })

  it("refuses unknown fields on a credential-named native binding", async () => {
    await withFixture(async (root) => {
      await Fs.writeFile(
        NodePath.join(root, "CacheWorker.json"),
        JSON.stringify({
          bindings: [{
            sid: "OTHER_BINDING",
            data: {
              bindings: [{
                type: "secret_text",
                name: "CACHE_WRITE_TOKEN",
                text: sentinel,
                raw: "bearer-hidden-beside-the-sentinel"
              }]
            }
          }]
        })
      )

      await expect(redactAlchemyState({ directory: root, bearerToken: "token" })).rejects.toThrow(
        /unrecognized shape for credential binding CACHE_WRITE_TOKEN/
      )
    })
  })

  it.each([
    ["non-record data", null],
    ["a non-array native binding list", { bindings: {} }],
    ["a non-record native binding", { bindings: [null] }],
    ["a credential-named native binding without text", {
      bindings: [{ type: "secret_text", name: "CACHE_WRITE_TOKEN" }]
    }],
    ["a credential-named native binding with a non-string type", {
      bindings: [{ type: { raw: "bearer" }, name: "CACHE_WRITE_TOKEN", text: sentinel }]
    }]
  ])("refuses %s under a credential binding", async (_case, data) => {
    await withFixture(async (root) => {
      await Fs.writeFile(
        NodePath.join(root, "CacheWorker.json"),
        JSON.stringify({ bindings: [{ sid: "CACHE_WRITE_TOKEN", data }] })
      )

      await expect(redactAlchemyState({ directory: root, bearerToken: "token" })).rejects.toThrow(
        /unrecognized shape for credential binding CACHE_WRITE_TOKEN/
      )
    })
  })

  it("refuses state that is not valid UTF-8 or is nested past its budget", async () => {
    await withFixture(async (root) => {
      await Fs.writeFile(NodePath.join(root, "CacheWorker.json"), Buffer.from([0x7b, 0xff, 0x7d]))
      await expect(redactAlchemyState({ directory: root, bearerToken: "token" })).rejects.toThrow(
        /not valid UTF-8/
      )
    })
    await withFixture(async (root) => {
      const deep = `${"[".repeat(200)}0${"]".repeat(200)}`
      await Fs.writeFile(NodePath.join(root, "CacheWorker.json"), deep)
      await expect(redactAlchemyState({ directory: root, bearerToken: "token" })).rejects.toThrow(
        /nested too deeply/
      )
    })
  })

  it("refuses a state path that is not a regular file", async () => {
    await withFixture(async (root) => {
      await Fs.mkdir(NodePath.join(root, "CacheWorker.json"))
      // Walking past a directory by that name would report success over
      // whatever it hides.
      await expect(redactAlchemyState({ directory: root, bearerToken: "token" })).rejects.toThrow(
        /Alchemy Worker state is not a regular file/
      )
    })
  })

  it("refuses a state file that has a second hard link", async () => {
    await withFixture(async (root) => {
      const file = NodePath.join(root, "CacheWorker.json")
      await Fs.writeFile(file, workerState("CACHE_TOKEN", "raw-token"))
      await Fs.link(file, NodePath.join(root, "alias.json"))

      // A second name for the inode would keep the raw value reachable after
      // the rename published the scrubbed copy, so the file is refused before
      // anything is written.
      await expect(redactAlchemyState({ directory: root, bearerToken: "raw-token" })).rejects.toThrow(
        /not a singly linked regular file/
      )
      expect(await Fs.readFile(file, "utf8")).toContain("raw-token")
    })
  })

  it("looks under the stack name the deployment actually uses", () => {
    // A renamed stack would make discovery find nothing and report success.
    expect(stackName).toBe("SmithersBuildRemoteCache")
  })

  it("bounds state reads before parsing", async () => {
    await withFixture(async (root) => {
      const file = NodePath.join(root, "CacheWorker.json")
      await Fs.writeFile(file, Buffer.alloc(maximumStateFileBytes + 1, 0x20))
      await expect(redactAlchemyState({ directory: root, bearerToken: "token" })).rejects.toThrow(
        /exceeds .* bytes/
      )
    })
  })

  it("bounds aggregate JSON members", async () => {
    await withFixture(async (root) => {
      await Fs.writeFile(NodePath.join(root, "CacheWorker.json"), `[${"0,".repeat(100_000)}0]`)

      await expect(redactAlchemyState({ directory: root, bearerToken: "token" })).rejects.toThrow(
        /too many JSON members/
      )
    })
  })

  it("refuses state text it cannot re-encode as well-formed Unicode", async () => {
    await withFixture(async (root) => {
      // An unpaired surrogate escape survives JSON.parse, so the parsed tree
      // carries text no encoder can round-trip. The shared admission refuses
      // it and the redactor fails closed rather than rewriting a file it
      // cannot audit, which is the same posture as the fatal UTF-8 decode.
      await Fs.writeFile(NodePath.join(root, "CacheWorker.json"), String.raw`{"props":{"env":{"A":"\ud800"}}}`)

      await expect(redactAlchemyState({ directory: root, bearerToken: "token" })).rejects.toThrow(
        /ill-formed text/
      )
    })
  })

  it("bounds the rendered replacement before publication", async () => {
    await withFixture(async (root) => {
      const leafCount = 99_860
      const filler = `${"[".repeat(127)}"${"x".repeat(9 * 1024 * 1024)}",${"0,".repeat(leafCount - 2)}0${
        "]".repeat(127)
      }`
      const input = `{"props":{"env":{"CACHE_TOKEN":{"__redacted__":"raw"}}},"filler":${filler}}`
      expect(Buffer.byteLength(input, "utf8")).toBeLessThanOrEqual(maximumStateFileBytes)
      await Fs.writeFile(NodePath.join(root, "CacheWorker.json"), input)

      await expect(redactAlchemyState({ directory: root, bearerToken: "token" })).rejects.toThrow(
        /redacted Alchemy state exceeds 33554432 bytes/
      )
    })
  })

  it("refuses a replacement that exceeds the read limit even when compact", async () => {
    await withFixture(async (root) => {
      const file = NodePath.join(root, "CacheWorker.json")
      const prefix = '{"props":{"env":{"CACHE_TOKEN":"raw"}},"filler":"'
      const suffix = '"}'
      const input = prefix + "x".repeat(maximumStateFileBytes - prefix.length - suffix.length) + suffix
      await Fs.writeFile(file, input)

      await expect(redactAlchemyState({ directory: root, bearerToken: "token" })).rejects.toThrow(
        /redacted Alchemy state exceeds 16777216 bytes/
      )
      expect(await Fs.readFile(file, "utf8")).toBe(input)
    })
  })

  it("bounds the number of Worker state files", async () => {
    await withFixture(async (root) => {
      for (let offset = 0; offset < 1_025; offset += 128) {
        await Promise.all(
          Array.from({ length: Math.min(128, 1_025 - offset) }, async (_, index) => {
            const directory = NodePath.join(root, `state-${offset + index}`)
            await Fs.mkdir(directory)
            await Fs.writeFile(NodePath.join(directory, "CacheWorker.json"), "{}")
          })
        )
      }

      await expect(redactAlchemyState({ directory: root, bearerToken: "token" })).rejects.toThrow(
        /exceeds 1024 Worker state files/
      )
    })
  })

  it("does not echo malformed state contents through parse failures", async () => {
    await withFixture(async (root) => {
      const file = NodePath.join(root, "CacheWorker.json")
      const secret = "must-not-appear-in-an-error"
      await Fs.writeFile(file, `{"secret":"${secret}",`)
      let failure: unknown
      try {
        await redactAlchemyState({ directory: root, bearerToken: secret })
      } catch (error) {
        failure = error
      }
      expect(failure).toBeInstanceOf(TypeError)
      expect(String(failure)).toMatch(/not valid JSON/)
      expect(String(failure)).not.toContain(secret)
    })
  })

  it.skipIf(process.platform === "win32")("refuses symbolic links without touching their target", async () => {
    await withFixture(async (root) => {
      const outside = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smithers-build-redaction-outside-"))
      try {
        const target = NodePath.join(outside, "state.json")
        const original = JSON.stringify({ secret: "outside" })
        await Fs.writeFile(target, original)
        await Fs.symlink(target, NodePath.join(root, "CacheWorker.json"))
        await expect(redactAlchemyState({ directory: root, bearerToken: "outside" })).rejects.toThrow(
          /symbolic links are not allowed/
        )
        expect(await Fs.readFile(target, "utf8")).toBe(original)
      } finally {
        await Fs.rm(outside, { recursive: true, force: true })
      }
    })
  })

  it.skipIf(process.platform === "win32")("refuses a state root reached through a symbolic link", async () => {
    await withFixture(async (root) => {
      const actual = NodePath.join(root, "actual")
      const alias = NodePath.join(root, "alias")
      await Fs.mkdir(actual)
      await Fs.symlink(actual, alias)
      await expect(redactAlchemyState({ directory: alias, bearerToken: "token" })).rejects.toThrow(
        /symbolic links are not allowed in the Alchemy state root/
      )
    })
  })

  it("rejects option accessors without invoking them", async () => {
    let reads = 0
    const options = Object.defineProperty({}, "directory", {
      enumerable: true,
      get: () => {
        reads += 1
        return "/tmp"
      }
    })
    await expect(redactAlchemyState(options)).rejects.toThrow(/must be a data property/)
    expect(reads).toBe(0)
  })

  it("treats an absent state directory as an empty deployment", async () => {
    await withFixture(async (root) => {
      expect(await redactAlchemyState({ directory: NodePath.join(root, "missing"), bearerToken: "token" })).toBe(0)
    })
  })

  it("reports CLI success and failure through the process contract", async () => {
    await withFixture(async (root) => {
      const file = NodePath.join(root, "CacheWorker.json")
      await Fs.writeFile(file, workerState("CACHE_TOKEN", "raw-token"))

      const success = spawnSync(process.execPath, ["--experimental-strip-types", script, root], {
        encoding: "utf8"
      })
      expect(success.status).toBe(0)
      expect(success.stdout).toContain("Redacted 1 Alchemy Worker state file(s).")

      await Fs.writeFile(file, "{")
      const failure = spawnSync(process.execPath, ["--experimental-strip-types", script, root], {
        encoding: "utf8"
      })
      expect(failure.status).toBe(1)
      expect(failure.stderr).toContain("Alchemy state redaction failed:")
    })
  })

  it("runs the process entry against the state directory it is given", async () => {
    await withFixture(async (root) => {
      const file = NodePath.join(root, "CacheWorker.json")
      await Fs.writeFile(file, workerState("CACHE_TOKEN", "raw-token"))
      const argv = process.argv
      const exitCode = process.exitCode
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
      try {
        // Re-evaluating the module with itself as `argv[1]` is the process
        // entry, run where the suite can observe it.
        process.argv = [process.execPath, script, root]
        vi.resetModules()
        await import("./redact-state.ts")
        expect(stdout.mock.calls.map((call) => String(call[0]))).toContain(
          "Redacted 1 Alchemy Worker state file(s).\n"
        )
        expect(process.exitCode).toBe(exitCode)
        expect(await Fs.readFile(file, "utf8")).not.toContain("raw-token")

        process.argv = [process.execPath, script, "relative/state"]
        vi.resetModules()
        await import("./redact-state.ts")
        expect(stderr.mock.calls.map((call) => String(call[0])).join("")).toContain(
          "Alchemy state redaction failed: Alchemy state directory must be an absolute path"
        )
        expect(process.exitCode).toBe(1)
      } finally {
        process.argv = argv
        process.exitCode = exitCode
        stdout.mockRestore()
        stderr.mockRestore()
      }
    })
  })

  it("walks the stack's own state directory with every configured credential by default", () => {
    vi.stubEnv("SMITHERS_CACHE_TOKEN", "the-legacy-bearer")
    vi.stubEnv("SMITHERS_CACHE_READ_TOKEN", "the-read-bearer")
    vi.stubEnv("SMITHERS_CACHE_WRITE_TOKEN", "")
    try {
      const targets = resolveRedactionOptions({})

      // This is the directory `scripts/deploy.ts` redacts after every run.
      expect(targets.directory).toBe(defaultStateDirectory)
      expect(defaultStateDirectory).toBe(NodePath.join(infraRoot, ".alchemy", "state", stackName))
      expect(targets.permitted).toEqual(
        new Set([sentinel, verifierOf("the-legacy-bearer"), verifierOf("the-read-bearer")])
      )
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it.each([
    ["a value that is not a record", 5, /must be a plain record/],
    ["a record with a foreign prototype", Object.create({ directory: "/state" }), /must be a plain record/],
    ["an unknown option", { directory: "/state", extra: true }, /unknown property: extra/],
    ["an ownership that is not a record", { ownership: "held" }, /ownership must be a state ownership/],
    ["an ownership without a directory", { ownership: { release: async () => {} } }, /must be a state ownership/],
    ["an ownership without a release", { ownership: { directory: "/state" } }, /must be a state ownership/],
    [
      "an ownership whose directory is an accessor",
      { ownership: { get directory() { return "/state" }, release: async () => {} } },
      /must be a state ownership/
    ],
    ["a relative directory", { directory: "relative" }, /must be an absolute path/],
    ["a directory that is not a string", { directory: 5 }, /must be an absolute path/],
    ["a bearer token that is not a string", { bearerToken: 5 }, /must be a string when supplied/]
  ])("refuses %s as options", async (_case, options, expected) => {
    await expect(redactAlchemyState(options as never)).rejects.toThrow(expected)
  })

  it("refuses options it cannot inspect without running them", async () => {
    const trap = (): never => {
      throw new Error("trap")
    }
    await expect(redactAlchemyState(new Proxy({}, { getPrototypeOf: trap }))).rejects.toThrow(
      /must be inspectable plain data/
    )
    await expect(redactAlchemyState(new Proxy({}, { getOwnPropertyDescriptor: trap }))).rejects.toThrow(
      /redaction option directory could not be inspected safely/
    )
  })

  it.each([
    ["a number", 5],
    ["a record that is not the redacted envelope", { other: 1 }],
    ["an envelope around something that is not a string", { __redacted__: 5 }]
  ])("refuses %s under a credential name outside the handled shapes", async (_case, echo) => {
    await withFixture(async (root) => {
      await Fs.writeFile(
        NodePath.join(root, "CacheWorker.json"),
        JSON.stringify({ output: { env: { CACHE_READ_TOKEN: echo } } })
      )

      await expect(redactAlchemyState({ directory: root, bearerToken: "token" })).rejects.toThrow(
        /unrecognized shape for credential binding CACHE_READ_TOKEN/
      )
    })
  })

  it("refuses a credential-named binding identifier outside the binding list", async () => {
    await withFixture(async (root) => {
      await Fs.writeFile(
        NodePath.join(root, "CacheWorker.json"),
        JSON.stringify({ extra: { sid: "CACHE_WRITE_TOKEN" } })
      )

      await expect(redactAlchemyState({ directory: root, bearerToken: "token" })).rejects.toThrow(
        /unrecognized shape for credential binding CACHE_WRITE_TOKEN/
      )
    })
  })

  it("leaves state that is not an object alone", async () => {
    await withFixture(async (root) => {
      const file = NodePath.join(root, "CacheWorker.json")
      await Fs.writeFile(file, "[]")

      expect(await redactAlchemyState({ directory: root, bearerToken: "token" })).toBe(0)
      expect(await Fs.readFile(file, "utf8")).toBe("[]")
    })
  })

  it("walks past bindings and environment entries that carry no credential", async () => {
    await withFixture(async (root) => {
      const file = NodePath.join(root, "CacheWorker.json")
      await Fs.writeFile(
        file,
        JSON.stringify({
          props: { env: { OTHER: "kept", CACHE_TOKEN: sentinel } },
          bindings: [
            null,
            { sid: "OTHER" },
            { sid: "OTHER_LIST", data: { bindings: [null, { type: "plain_text", name: "OTHER", text: "kept" }] } },
            {
              sid: "CACHE_WRITE_TOKEN",
              data: { bindings: [{ type: "secret_text", name: "CACHE_WRITE_TOKEN", text: "raw-token" }] }
            }
          ]
        })
      )

      expect(await redactAlchemyState({ directory: root, bearerToken: "token" })).toBe(1)

      const state = JSON.parse(await Fs.readFile(file, "utf8"))
      expect(state.props.env).toEqual({ OTHER: "kept", CACHE_TOKEN: sentinel })
      expect(state.bindings[2].data.bindings[1].text).toBe("kept")
      expect(state.bindings[3].data.bindings[0].text).toBe(sentinel)
    })
  })

  it("bounds aggregate JSON members of an object as it does of an array", async () => {
    await withFixture(async (root) => {
      const members = Array.from({ length: 100_001 }, (_, index) => `"k${index}":0`).join(",")
      await Fs.writeFile(NodePath.join(root, "CacheWorker.json"), `{${members}}`)

      await expect(redactAlchemyState({ directory: root, bearerToken: "token" })).rejects.toThrow(
        /too many JSON members/
      )
    })
  })

  it("refuses a state root that is not a directory", async () => {
    await withFixture(async (root) => {
      const file = NodePath.join(root, "state.json")
      await Fs.writeFile(file, "{}")

      await expect(redactAlchemyState({ directory: file, bearerToken: "token" })).rejects.toThrow(
        /Alchemy state root is not a directory/
      )
      // Only an absent root means an empty deployment; any other failure to
      // resolve it is reported.
      await expect(redactAlchemyState({ directory: NodePath.join(file, "child"), bearerToken: "token" })).rejects
        .toThrow(/ENOTDIR/)
    })
  })

  it.skipIf(process.platform === "win32")("reports a state directory it cannot publish into", async (context) => {
    await withFixture(async (root) => {
      const file = NodePath.join(root, "CacheWorker.json")
      await Fs.writeFile(file, workerState("CACHE_TOKEN", "raw-token"))
      await Fs.chmod(root, 0o500)
      try {
        // A privileged process overrides the mode bits and creates the file
        // anyway; the refused temporary-file case in the identity suite
        // covers that boundary on every host, so this real-permission case
        // only runs where the host demonstrably denies the write.
        let denied = false
        try {
          await Fs.writeFile(NodePath.join(root, "probe"), "")
        } catch {
          denied = true
        }
        if (!denied) context.skip("this process creates files in a directory without write permission")
        await expect(redactAlchemyState({ directory: root, bearerToken: "token" })).rejects.toThrow(/EACCES|EPERM/)
      } finally {
        await Fs.chmod(root, 0o700)
      }
      expect(await Fs.readFile(file, "utf8")).toContain("raw-token")
    })
  })

  it("owns the state for the whole run and releases it afterwards", async () => {
    await withFixture(async (root) => {
      const file = NodePath.join(root, "CacheWorker.json")
      const lock = NodePath.join(root, ".smithers-state-owner.lock")
      await Fs.writeFile(file, workerState("CACHE_TOKEN", "raw-token"))

      expect(await redactAlchemyState({ directory: root, bearerToken: "token" })).toBe(1)
      expect(await Fs.readdir(root)).toEqual(["CacheWorker.json"])

      await Fs.writeFile(file, workerState("CACHE_TOKEN", "raw-token"))
      const held = await acquireStateOwnership(root)
      try {
        // Another writer holds the state: the run refuses rather than
        // publishing over whatever that writer is about to install.
        await expect(redactAlchemyState({ directory: root, bearerToken: "token" })).rejects.toThrow(
          /owned by another deployment/
        )
        expect(await Fs.readFile(file, "utf8")).toContain("raw-token")
        // The holder itself redacts under its own ownership and keeps it.
        expect(await redactAlchemyState({ directory: root, bearerToken: "token", ownership: held })).toBe(1)
        expect(await Fs.readFile(file, "utf8")).not.toContain("raw-token")
        expect(await Fs.readFile(lock, "utf8")).toBe(`${process.pid}\n`)
      } finally {
        await held.release()
      }
      expect(await Fs.readdir(root)).toEqual(["CacheWorker.json"])
    })
  })

  it("refuses ownership taken for another state directory", async () => {
    await withFixture(async (root) => {
      await withFixture(async (other) => {
        await Fs.writeFile(NodePath.join(root, "CacheWorker.json"), workerState("CACHE_TOKEN", "raw-token"))
        const held = await acquireStateOwnership(other)
        try {
          await expect(redactAlchemyState({ directory: root, bearerToken: "token", ownership: held })).rejects
            .toThrow(/ownership is for another directory/)
        } finally {
          await held.release()
        }
        expect(await Fs.readdir(root)).toEqual(["CacheWorker.json"])
      })
    })
  })

  it("releases only the ownership it took when redaction fails", async () => {
    await withFixture(async (root) => {
      await Fs.writeFile(NodePath.join(root, "CacheWorker.json"), "not json")

      await expect(redactAlchemyState({ directory: root, bearerToken: "token" })).rejects.toThrow()
      expect(await Fs.readdir(root)).toEqual(["CacheWorker.json"])

      const held = await acquireStateOwnership(root)
      try {
        await expect(redactAlchemyState({ directory: root, bearerToken: "token", ownership: held })).rejects
          .toThrow()
        // The deployment that owns the state keeps it until its own release.
        expect(await Fs.readdir(root)).toEqual([".smithers-state-owner.lock", "CacheWorker.json"])
      } finally {
        await held.release()
      }
    })
  })

  it("skips the directory sync where the platform has none", async () => {
    await withFixture(async (root) => {
      const file = NodePath.join(root, "CacheWorker.json")
      await Fs.writeFile(file, workerState("CACHE_TOKEN", "raw-token"))
      const platform = Object.getOwnPropertyDescriptor(process, "platform")
      if (platform === undefined) throw new Error("process.platform is not an own property")
      Object.defineProperty(process, "platform", { ...platform, value: "win32" })
      try {
        expect(await redactAlchemyState({ directory: root, bearerToken: "token" })).toBe(1)
      } finally {
        Object.defineProperty(process, "platform", platform)
      }
      expect(await Fs.readFile(file, "utf8")).not.toContain("raw-token")
    })
  })
})

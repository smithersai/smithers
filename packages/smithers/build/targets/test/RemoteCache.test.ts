import { describe, expect, it } from "vitest"
import * as RemoteCache from "../src/RemoteCache.ts"
import { Secret } from "../src/Secret.ts"
import * as WorkspaceDeclaration from "../src/WorkspaceDeclaration.ts"

describe("RemoteCache.make", () => {
  it("defaults the declared secret and stays inert", () => {
    const declaration = RemoteCache.make({ endpoint: "https://cache.example.test/" })
    expect(declaration.endpoint).toBe("https://cache.example.test")
    expect(declaration.token).toEqual({ _tag: "Secret", env: "SMITHERS_CACHE_TOKEN" })
    expect(RemoteCache.isRemoteCache(declaration)).toBe(true)
    expect(Object.isFrozen(declaration)).toBe(true)
  })

  it("accepts a declared secret naming another variable", () => {
    expect(RemoteCache.make({
      endpoint: "https://cache.example.test/base/",
      token: Secret("PROJECT_CACHE_TOKEN")
    })).toMatchObject({
      endpoint: "https://cache.example.test/base",
      token: { _tag: "Secret", env: "PROJECT_CACHE_TOKEN" }
    })
  })

  it("refuses a bare string where a declaration belongs", () => {
    expect(() =>
      RemoteCache.make({
        endpoint: "https://cache.example.test",
        token: "SMITHERS_CACHE_TOKEN" as never
      })
    ).toThrow(/must be a Secret declaration/)
  })

  it("requires an HTTPS endpoint without embedded credentials", () => {
    expect(() => RemoteCache.make({ endpoint: "http://cache.example.test" })).toThrow(/use HTTPS/)
    expect(() => RemoteCache.make({ endpoint: "cache.example.test" })).toThrow(/absolute HTTPS URL/)
    expect(() => RemoteCache.make({ endpoint: "https://token@cache.example.test" })).toThrow(/credentials/)
    expect(() => RemoteCache.make({ endpoint: "https://cache.example.test?token=secret" })).toThrow(/query/)
  })

  it("never echoes a rejected endpoint, so embedded credentials stay out of the message", () => {
    const cases = [
      "http://user:SYNTHETIC_PASSWORD@cache.example.test",
      "http://cache.example.test/?token=SYNTHETIC_TOKEN",
      "not a url SYNTHETIC_TOKEN",
      "ftp://user:SYNTHETIC_PASSWORD@cache.example.test/?k=SYNTHETIC_TOKEN"
    ]
    for (const endpoint of cases) {
      let message = ""
      try {
        RemoteCache.normalizeEndpoint(endpoint)
      } catch (error) {
        message = String((error as Error).message)
      }
      expect(message).not.toBe("")
      expect(message).not.toContain("SYNTHETIC_")
      expect(message).not.toContain("cache.example.test")
    }
  })

  it("bounds endpoint text before URL parsing", () => {
    expect(() => RemoteCache.make({ endpoint: "https://cache.example.test\n" })).toThrow(/control characters/)
    expect(() => RemoteCache.make({ endpoint: "https://cache.example.test/\ud800" })).toThrow(/well-formed/)
    expect(() =>
      RemoteCache.make({ endpoint: `https://cache.example.test/${"x".repeat(RemoteCache.maximumEndpointBytes)}` })
    )
      .toThrow(/bounded/)
  })

  it("refuses endpoints that become empty or exceed the byte ceiling after trimming", () => {
    expect(() => RemoteCache.normalizeEndpoint("   ")).toThrow(/bounded absolute HTTPS URL/)
    expect(() =>
      RemoteCache.normalizeEndpoint(`https://cache.example.test/${"é".repeat(RemoteCache.maximumEndpointBytes / 2)}`)
    ).toThrow(/bounded absolute HTTPS URL/)
  })

  it("requires a valid non-reserved token variable name", () => {
    expect(() => Secret("not valid")).toThrow(/environment variable name/)
    expect(() => RemoteCache.make({ endpoint: "https://cache.example.test", token: Secret("SMITHERS_CACHE_URL") }))
      .toThrow(/must not be SMITHERS_CACHE_URL/)
    expect(() =>
      RemoteCache.make({
        endpoint: "https://cache.example.test",
        token: Secret(`A${"B".repeat(RemoteCache.maximumTokenEnvironmentLength)}`)
      })
    ).toThrow(/bounded/)
  })

  it("validates the token environment normalizer at its public boundary", () => {
    expect(() => RemoteCache.normalizeTokenEnv(42 as never)).toThrow(TypeError)
    expect(() => RemoteCache.normalizeTokenEnv("bad-name")).toThrow(/environment variable name/)
    expect(() => RemoteCache.normalizeTokenEnv("TOKEN\n")).toThrow(/bounded well-formed text/)
    expect(RemoteCache.normalizeTokenEnv("  PROJECT_CACHE_TOKEN  ")).toBe("PROJECT_CACHE_TOKEN")
  })

  it("rejects malformed option bags and hostile declarations without invoking accessors", () => {
    let invoked = false
    const options = Object.defineProperty({}, "endpoint", {
      enumerable: true,
      get: () => {
        invoked = true
        return "https://cache.example.test"
      }
    })
    expect(() => RemoteCache.make(options as never)).toThrow(/data property/)
    expect(() => RemoteCache.make({ endpoint: "https://cache.example.test", typo: true } as never))
      .toThrow(/unknown option/)
    expect(() => RemoteCache.make(new Date() as never)).toThrow(/plain object/)
    expect(() => RemoteCache.make(new Proxy({ endpoint: "https://cache.example.test" }, {}) as never))
      .toThrow(/plain object/)

    const declaration = Object.defineProperty({}, RemoteCache.TypeId, {
      get: () => {
        invoked = true
        return RemoteCache.TypeId
      }
    })
    const proxy = new Proxy({}, {
      getOwnPropertyDescriptor: () => {
        invoked = true
        return undefined
      }
    })
    expect(RemoteCache.isRemoteCache(declaration)).toBe(false)
    expect(RemoteCache.isRemoteCache(proxy)).toBe(false)
    expect(invoked).toBe(false)
  })
})

describe("RemoteCache.make split read/write form", () => {
  it("accepts read as the token slot and carries a separate write secret", () => {
    const declaration = RemoteCache.make({
      endpoint: "https://build.smithers.sh",
      read: Secret("SMITHERS_CACHE_READ_TOKEN"),
      write: Secret("SMITHERS_CACHE_WRITE_TOKEN")
    })
    expect(declaration.token).toEqual({ _tag: "Secret", env: "SMITHERS_CACHE_READ_TOKEN" })
    expect(declaration.write).toEqual({ _tag: "Secret", env: "SMITHERS_CACHE_WRITE_TOKEN" })
    expect(RemoteCache.isRemoteCache(declaration)).toBe(true)
    expect(Object.isFrozen(declaration)).toBe(true)
  })

  it("leaves write undefined in the single-token form", () => {
    expect(RemoteCache.make({ endpoint: "https://cache.example.test" }).write).toBeUndefined()
  })

  it("refuses token together with read, a non-secret write, and the reserved write variable", () => {
    expect(() =>
      RemoteCache.make({
        endpoint: "https://cache.example.test",
        token: Secret("A_TOKEN"),
        read: Secret("B_TOKEN")
      })
    ).toThrow(/declare one, not both/)
    expect(() => RemoteCache.make({ endpoint: "https://cache.example.test", write: "WRITE_TOKEN" as never })).toThrow(
      /option write must be a Secret declaration/
    )
    expect(() => RemoteCache.make({ endpoint: "https://cache.example.test", write: Secret("SMITHERS_CACHE_URL") }))
      .toThrow(/must not be SMITHERS_CACHE_URL/)
  })

  it("rejects a forged declaration whose write slot is not a secret", () => {
    const forged = {
      ...RemoteCache.make({ endpoint: "https://cache.example.test" }),
      [RemoteCache.TypeId]: RemoteCache.TypeId,
      write: "leak"
    }
    expect(RemoteCache.isRemoteCache(forged)).toBe(false)
  })
})

describe("S.Cache with a remote declaration", () => {
  it("carries the remote declaration and stays a Cache declaration", () => {
    const remote = RemoteCache.make({ endpoint: "https://build.smithers.sh", read: Secret("R"), write: Secret("W") })
    const cache = WorkspaceDeclaration.Cache({ directory: ".flows", remote })
    expect(WorkspaceDeclaration.isCacheDeclaration(cache)).toBe(true)
    expect(cache.remote).toBe(remote)
    expect(WorkspaceDeclaration.Cache({ directory: ".flows" }).remote).toBeUndefined()
  })

  it("rejects a remote that is not an S.RemoteCache.make declaration and unknown options", () => {
    expect(() => WorkspaceDeclaration.Cache({ directory: ".flows", remote: { endpoint: "x" } as never })).toThrow(
      /S\.RemoteCache\.make/
    )
    expect(() => WorkspaceDeclaration.Cache({ directory: ".flows", remotes: 1 } as never)).toThrow(/unknown option/)
    expect(() => WorkspaceDeclaration.Cache(null as never)).toThrow(/must be an object/)
  })
})

describe("RemoteCache public read tokens and Smithers Cloud", () => {
  const token = "smithers_cachero_" + "0123456789abcdef".repeat(2) + "01234567"

  it("accepts a committed public read token and defaults the write secret", () => {
    const declaration = RemoteCache.make({
      endpoint: "https://api.jjhub.tech/api/repos/acme/app/build-cache",
      publicReadToken: token
    })
    expect(declaration.publicReadToken).toBe(token)
    expect(declaration.token).toEqual({ _tag: "Secret", env: "SMITHERS_CACHE_TOKEN" })
    expect(declaration.write).toBeUndefined()
    expect(RemoteCache.isRemoteCache(declaration)).toBe(true)
  })

  it("refuses any literal that is not a public read token", () => {
    for (
      const bad of [
        "smithers_" + "a".repeat(40),
        "ghp_" + "a".repeat(36),
        "smithers_cachero_" + "a".repeat(39),
        "smithers_cachero_" + "G".repeat(40),
        ""
      ]
    ) {
      expect(() => RemoteCache.make({ endpoint: "https://cache.example.test", publicReadToken: bad })).toThrow(
        /publicReadToken must be a Smithers Cloud public read token/
      )
    }
    expect(() => RemoteCache.make({ endpoint: "https://cache.example.test", publicReadToken: 42 as never })).toThrow(
      /must be a string/
    )
  })

  it("is exclusive with a declared read secret", () => {
    expect(() =>
      RemoteCache.make({ endpoint: "https://cache.example.test", publicReadToken: token, token: Secret("X") })
    ).toThrow(/replaces token and read/)
    expect(() =>
      RemoteCache.make({ endpoint: "https://cache.example.test", publicReadToken: token, read: Secret("X") })
    ).toThrow(/replaces token and read/)
  })

  it("derives the Smithers Cloud endpoint from the repository", () => {
    const declaration = RemoteCache.smithersCloud({ repo: "acme/app", publicReadToken: token })
    expect(declaration.endpoint).toBe("https://api.jjhub.tech/api/repos/acme/app/build-cache")
    expect(declaration.publicReadToken).toBe(token)
    expect(RemoteCache.smithersCloud({ repo: "acme/app", apiBase: "https://smithers-cloud.example.test/" }).endpoint)
      .toBe(
        "https://smithers-cloud.example.test/api/repos/acme/app/build-cache"
      )
    expect(RemoteCache.smithersCloud({ repo: "acme/app", write: Secret("CI_WRITE") }).write).toEqual({
      _tag: "Secret",
      env: "CI_WRITE"
    })
    expect(() => RemoteCache.smithersCloud({ repo: "not-a-repo" })).toThrow(/owner\/name/)
    expect(() => RemoteCache.smithersCloud({ repo: "acme/app", extra: 1 } as never)).toThrow(/unknown option/)
  })

  it("rejects a forged declaration carrying a bad literal", () => {
    const declaration = RemoteCache.make({ endpoint: "https://cache.example.test" })
    const forged = { ...declaration, [RemoteCache.TypeId]: RemoteCache.TypeId, publicReadToken: "not-a-token" }
    expect(RemoteCache.isRemoteCache(forged)).toBe(false)
  })
})

describe("RemoteCache input guards", () => {
  // These three normalizers are exported, so a workspace declaration reaches
  // them with whatever an author wrote. Each refuses the shape before it
  // becomes part of a cache key or a request, where the same value would fail
  // as something much harder to read.
  it("refuses a public read token that is not a string", () => {
    expect(() => RemoteCache.normalizePublicReadToken(42 as never)).toThrow(
      /publicReadToken must be a string/
    )
  })

  it("refuses an endpoint that is not a string", () => {
    expect(() => RemoteCache.normalizeEndpoint(null as never)).toThrow(/endpoint must be a string/)
  })

  it("refuses options carrying a symbol property, which a plain-object check alone would pass", () => {
    const options = { endpoint: "https://cache.example.test/" }
    Object.defineProperty(options, Symbol("hidden"), { value: "kept", enumerable: true })

    expect(() => RemoteCache.make(options)).toThrow(/must not contain symbol properties/)
  })
})

/**
 * `parseSmithersCloudRemote` over every remote spelling git writes into
 * `.git/config`: URL forms, and SCP-style forms with and without a username.
 */
import { describe, expect, it } from "vitest"
import { parseSmithersCloudRemote, withheldEnvironment } from "../src/Workspace.ts"

describe("parseSmithersCloudRemote", () => {
  it("reads the same repository from every spelling of one remote", () => {
    const expected = { repo: "alice/repo", host: "jjhub.tech" }
    expect(parseSmithersCloudRemote("https://jjhub.tech/alice/repo.git")).toEqual(expected)
    expect(parseSmithersCloudRemote("ssh://git@jjhub.tech/alice/repo.git")).toEqual(expected)
    expect(parseSmithersCloudRemote("git@jjhub.tech:alice/repo.git")).toEqual(expected)
    // An SCP-style remote without a user parses as an opaque URL whose scheme
    // is the host, so the host check only sees it if the SCP branch reruns.
    expect(parseSmithersCloudRemote("jjhub.tech:alice/repo.git")).toEqual(expected)
  })

  it("keeps the remote's subdomain and trims surrounding whitespace", () => {
    expect(parseSmithersCloudRemote("  ssh.jjhub.tech:alice/repo  ")).toEqual({
      repo: "alice/repo",
      host: "ssh.jjhub.tech"
    })
    expect(parseSmithersCloudRemote("git@SSH.JJHUB.TECH:alice/repo.git")).toEqual({
      repo: "alice/repo",
      host: "ssh.jjhub.tech"
    })
  })

  it("refuses a remote on another host in either spelling", () => {
    expect(parseSmithersCloudRemote("github.com:alice/repo.git")).toBeUndefined()
    expect(parseSmithersCloudRemote("git@github.com:alice/repo.git")).toBeUndefined()
    expect(parseSmithersCloudRemote("https://github.com/alice/repo.git")).toBeUndefined()
  })

  it("honours the supplied host set instead of the defaults", () => {
    const hosts = new Set(["git.example.test"])
    expect(parseSmithersCloudRemote("git.example.test:alice/repo.git", hosts)).toEqual({
      repo: "alice/repo",
      host: "git.example.test"
    })
    expect(parseSmithersCloudRemote("jjhub.tech:alice/repo.git", hosts)).toBeUndefined()
  })

  it("refuses a remote whose path is not exactly owner and name", () => {
    expect(parseSmithersCloudRemote("jjhub.tech:repo.git")).toBeUndefined()
    expect(parseSmithersCloudRemote("jjhub.tech:alice/team/repo.git")).toBeUndefined()
    expect(parseSmithersCloudRemote("https://jjhub.tech/alice")).toBeUndefined()
    expect(parseSmithersCloudRemote("not a remote")).toBeUndefined()
  })
})

describe("withheldEnvironment", () => {
  const ambient = {
    SMITHERS_CACHE_URL: "https://cache.example",
    SMITHERS_CACHE_TOKEN: "default",
    SHARED_TOKEN: "shared",
    READ_TOKEN: "read",
    WRITE_TOKEN: "write",
    PATH: "/bin",
    HOME: "/home/user"
  }

  it("withholds the default cache names without a declaration", () => {
    expect(withheldEnvironment(ambient, undefined)).toEqual({
      SHARED_TOKEN: "shared",
      READ_TOKEN: "read",
      WRITE_TOKEN: "write",
      PATH: "/bin",
      HOME: "/home/user"
    })
  })

  it("withholds every name each credential shape declares and keeps the rest", () => {
    expect(withheldEnvironment(ambient, { _tag: "shared", tokenEnv: "SHARED_TOKEN" })).toEqual({
      READ_TOKEN: "read",
      WRITE_TOKEN: "write",
      PATH: "/bin",
      HOME: "/home/user"
    })
    expect(withheldEnvironment(ambient, { _tag: "split", readTokenEnv: "READ_TOKEN", writeTokenEnv: "WRITE_TOKEN" }))
      .toEqual({ SHARED_TOKEN: "shared", PATH: "/bin", HOME: "/home/user" })
    expect(withheldEnvironment(ambient, { _tag: "public", publicReadToken: "committed", writeTokenEnv: "WRITE_TOKEN" }))
      .toEqual({ SHARED_TOKEN: "shared", READ_TOKEN: "read", PATH: "/bin", HOME: "/home/user" })
  })

  it("matches names case-insensitively only on Windows", () => {
    const lower = { smithers_cache_token: "default", Path: "/bin" }
    const expected = process.platform === "win32" ? { Path: "/bin" } : lower
    expect(withheldEnvironment(lower, undefined)).toEqual(expected)
  })
})

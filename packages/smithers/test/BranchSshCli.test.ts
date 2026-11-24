import { existsSync, readFileSync, statSync } from "node:fs"
import { describe, expect, it, vi } from "vitest"

const child = vi.hoisted(() => ({
  spawn: vi.fn((_command: string, _args: string[]) => ({ exited: Promise.resolve(7) }))
}))
vi.mock("../src/internal/backend/Process.ts", () => child)
import { invokeBranchSsh as invoke } from "./support/branch-ssh.ts"

describe("branch SSH catalog CLI", () => {
  it.each([
    { branch: "smithers/retry", host: "factory.example", port: 2222 },
    { branch: "scratch/alice/retry", host: "localhost", port: 2222 },
    { branch: "scratch/alice/retry", host: "::1", port: 2222 }
  ])("spawns argv for $host", async (endpoint) => {
    child.spawn.mockClear()
    let knownHosts = ""
    child.spawn.mockImplementationOnce((_command, args) => {
      knownHosts = args.find((arg) => arg.startsWith("UserKnownHostsFile="))!.split("\"")[1]!
      expect(statSync(knownHosts).mode & 0o777).toBe(0o600)
      expect(readFileSync(knownHosts, "utf8")).toBe("smithers-branch ssh-ed25519 AAAA\n")
      return { exited: Promise.resolve(7) }
    })
    const result = await invoke({ ...endpoint, host_keys: [{ algorithm: "ssh-ed25519", public_key: "AAAA" }] })
    expect(result.seen).toEqual(["/api/ssh?branch=retry"])
    expect(child.spawn).toHaveBeenCalledWith(
      "ssh",
      [
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        expect.stringMatching(/^UserKnownHostsFile=/),
        "-o",
        "GlobalKnownHostsFile=/dev/null",
        "-o",
        "HostKeyAlias=smithers-branch",
        "-o",
        "ControlPath=none",
        "-o",
        "KnownHostsCommand=none",
        "-o",
        "VerifyHostKeyDNS=no",
        "-p",
        "2222",
        "-l",
        endpoint.branch,
        endpoint.host
      ],
      expect.objectContaining({ stdio: "inherit" })
    )
    expect(result.code).toBe(7)
    expect(existsSync(knownHosts)).toBe(false)
  })
  it.each([{ host_keys: undefined }, { host_keys: [] }, { host_keys: [{ known_hosts_line: "invalid key!" }] }])(
    "refuses missing or malformed keys (%j)",
    async ({ host_keys }) => {
      child.spawn.mockClear()
      const result = await invoke({ branch: "retry", host: "localhost", port: 2222, host_keys })
      expect(result.code).toBe(1)
      expect(result.output).toContain("ssh_endpoint_refused")
      expect(child.spawn).not.toHaveBeenCalled()
    }
  )
  it.each([
    { branch: "main", host: "localhost", port: 2222 },
    { branch: "retry;touch /tmp/canary", host: "localhost", port: 2222 },
    { branch: "smithers/retry", host: "-oProxyCommand=bad", port: 2222 },
    { branch: "smithers/retry", host: "local host", port: 2222 },
    { branch: "smithers/retry", host: "localhost", port: 22 }
  ])("refuses invalid endpoint %j before spawn", async (endpoint) => {
    child.spawn.mockClear()
    const result = await invoke(endpoint)
    expect(child.spawn).not.toHaveBeenCalled()
    expect(result.code).toBe(1)
    expect(result.output).toContain("invalid_ssh_endpoint")
  })
})

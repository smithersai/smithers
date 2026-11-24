import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { invokeBranchSsh as invoke } from "./support/branch-ssh.ts"

const dirs: Array<string> = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Creates a real executable ssh binary on PATH that records argv and inspects UserKnownHostsFile while live. */
const makeSshBin = () => {
  const binDir = mkdtempSync(join(tmpdir(), "branch-ssh-bin-"))
  dirs.push(binDir)
  const recordFile = join(binDir, "record.json")
  const sshPath = join(binDir, "ssh")
  writeFileSync(
    sshPath,
    [
      `#!${process.execPath}`,
      `const fs = require("node:fs");`,
      `const args = process.argv.slice(2);`,
      `const opt = args.find((a) => a.startsWith("UserKnownHostsFile=")) || "";`,
      `const knownHosts = opt.split(String.fromCharCode(34))[1] || "";`,
      `const mode = knownHosts ? (fs.statSync(knownHosts).mode & 0o777) : null;`,
      `const content = knownHosts ? fs.readFileSync(knownHosts, "utf8") : null;`,
      `fs.writeFileSync(${JSON.stringify(recordFile)}, JSON.stringify({ args, knownHosts, mode, content }));`,
      `process.exit(7);`
    ].join("\n") + "\n"
  )
  chmodSync(sshPath, 0o755)
  return {
    recordFile,
    env: { PATH: `${binDir}:${process.env.PATH ?? ""}` }
  }
}

describe("branch SSH catalog CLI", () => {
  it.each([
    { branch: "smithers/retry", host: "factory.example", port: 2222 },
    { branch: "scratch/alice/retry", host: "localhost", port: 2222 },
    { branch: "scratch/alice/retry", host: "::1", port: 2222 }
  ])("spawns argv for $host", async (endpoint) => {
    const { recordFile, env } = makeSshBin()
    const result = await invoke({ ...endpoint, host_keys: [{ algorithm: "ssh-ed25519", public_key: "AAAA" }] }, env)
    expect(result.seen).toEqual(["/api/ssh?branch=retry"])
    const recorded = JSON.parse(readFileSync(recordFile, "utf8")) as {
      readonly args: ReadonlyArray<string>
      readonly knownHosts: string
      readonly mode: number
      readonly content: string
    }
    expect(recorded.mode).toBe(0o600)
    expect(recorded.content).toBe("smithers-branch ssh-ed25519 AAAA\n")
    expect(recorded.args).toEqual([
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
    ])
    expect(result.code).toBe(7)
    expect(existsSync(recorded.knownHosts)).toBe(false)
  })

  it.each([{ host_keys: undefined }, { host_keys: [] }, { host_keys: [{ known_hosts_line: "invalid key!" }] }])(
    "refuses missing or malformed keys (%j)",
    async ({ host_keys }) => {
      const { recordFile, env } = makeSshBin()
      const result = await invoke({ branch: "retry", host: "localhost", port: 2222, host_keys }, env)
      expect(result.code).toBe(1)
      expect(result.output).toContain("ssh_endpoint_refused")
      expect(existsSync(recordFile)).toBe(false)
    }
  )

  it.each([
    { branch: "main", host: "localhost", port: 2222 },
    { branch: "retry;touch /tmp/canary", host: "localhost", port: 2222 },
    { branch: "smithers/retry", host: "-oProxyCommand=bad", port: 2222 },
    { branch: "smithers/retry", host: "local host", port: 2222 },
    { branch: "smithers/retry", host: "localhost", port: 22 }
  ])("refuses invalid endpoint %j before spawn", async (endpoint) => {
    const { recordFile, env } = makeSshBin()
    const result = await invoke(endpoint, env)
    expect(existsSync(recordFile)).toBe(false)
    expect(result.code).toBe(1)
    expect(result.output).toContain("invalid_ssh_endpoint")
  })
})

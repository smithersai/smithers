import { type ChildProcess, execFileSync, spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { connect, createServer, type Server, type Socket } from "node:net"
import { tmpdir, userInfo } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from "vitest"
import * as Environments from "../src/ExecutionEnvironment.ts"
import { childEnvironment } from "./support/node-child.ts"

// A real SSH server and transport; only the synthetic native application is a fixture.
describe.skipIf(process.platform === "win32")("execution environments over real SSH", () => {
  let root: string, home: string, directory: string, server: ChildProcess, config: string
  let source: Environments.Source, profile: Environments.Profile
  const children: ChildProcess[] = []
  const pause = () => new Promise((resolve) => setTimeout(resolve, 20))
  const reserve = async () => {
    const socket = createServer()
    await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve))
    const port = (socket.address() as { port: number }).port
    await new Promise<void>((resolve) => socket.close(() => resolve()))
    return port
  }
  const waitFile = async (path: string) => {
    for (let i = 0; i < 200; i++) {
      try {
        return await readFile(path, "utf8")
      } catch {
        await pause()
      }
    }
    throw new Error(`Remote command did not produce ${path}`)
  }
  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "smthrs-real-ssh-")))
    home = join(root, "remote-home")
    directory = join(root, "repository")
    await Promise.all([
      mkdir(join(home, ".local/bin"), { recursive: true }),
      mkdir(directory),
      mkdir(join(root, "bin"))
    ])
    for (const name of ["host", "user", "wrong"]) {
      execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(root, name)])
    }
    const port = await reserve()
    await writeFile(join(root, "authorized_keys"), await readFile(join(root, "user.pub")), { mode: 0o600 })
    await writeFile(
      join(root, "sshd_config"),
      [
        `Port ${port}`,
        "ListenAddress 127.0.0.1",
        `HostKey ${join(root, "host")}`,
        `PidFile ${join(root, "sshd.pid")}`,
        `AuthorizedKeysFile ${join(root, "authorized_keys")}`,
        "StrictModes no",
        "PasswordAuthentication no",
        "KbdInteractiveAuthentication no",
        "UsePAM no",
        "AllowTcpForwarding yes",
        "LogLevel ERROR"
      ].join("\n")
    )
    const key = (await readFile(join(root, "host.pub"), "utf8")).trim().split(" ").slice(0, 2).join(" ")
    await writeFile(join(root, "known_hosts"), `[127.0.0.1]:${port} ${key}\n`)
    config = join(root, "ssh_config")
    await writeFile(
      config,
      [
        "Host fixture",
        "HostName 127.0.0.1",
        `Port ${port}`,
        `User ${userInfo().username}`,
        `IdentityFile ${join(root, "user")}`,
        "IdentitiesOnly yes",
        `UserKnownHostsFile ${join(root, "known_hosts")}`,
        "GlobalKnownHostsFile /dev/null",
        "ConnectTimeout 2"
      ].join("\n")
    )
    await writeFile(join(root, "bin/ssh"), `#!/bin/sh\nexec /usr/bin/ssh -F '${config}' "$@"\n`, { mode: 0o700 })
    await writeFile(
      join(home, ".local/bin/native-tool"),
      `#!/bin/sh\nset -eu\ncase "$1" in\nlogin) printf synthetic-fixture-only > "$HOME/native-auth";;\nexec) test "$(cat "$HOME/native-auth")" = synthetic-fixture-only; printf '%s\\n%s\\n' "$HOME" "$PWD" > "$HOME/executed";;\nesac\n`,
      { mode: 0o700 }
    )
    await writeFile(
      join(home, ".local/bin/smthrs"),
      `#!/bin/sh\nset -eu\ntest "$1" = tui\nprintf '%s\\n%s\\n' "$HOME" "$PWD" > "$HOME/tui-executed"\n`,
      { mode: 0o700 }
    )
    server = spawn("/usr/sbin/sshd", ["-D", "-e", "-f", join(root, "sshd_config")], {
      stdio: ["ignore", "ignore", "pipe"]
    })
    children.push(server)
    let errors = ""
    server.stderr?.on("data", (chunk) => {
      errors += chunk
    })
    for (let i = 0; i < 100; i++) {
      if (server.exitCode !== null) throw new Error(`Real sshd unavailable: ${errors}`)
      try {
        execFileSync("/usr/bin/ssh", [
          "-F",
          config,
          "-o",
          "BatchMode=yes",
          "-o",
          "StrictHostKeyChecking=yes",
          "fixture",
          "true"
        ], { stdio: "pipe" })
        break
      } catch {
        if (i === 99) throw new Error(`Real sshd did not become ready: ${errors}`)
        await pause()
      }
    }
    source = {
      HOME: join(root, "caller-home"),
      XDG_CONFIG_HOME: join(root, "config"),
      PATH: `${join(root, "bin")}:${process.env.PATH}`
    }
    profile = { name: "remote", transport: "ssh", destination: "fixture", directory, home }
    await Environments.add(profile, source)
  }, 30_000)
  afterAll(async () => {
    for (const child of children) child.kill("SIGKILL")
    if (root) await rm(root, { recursive: true, force: true })
  })
  it("keeps native login in remote home across independent SSH connections and shares the TUI location", async () => {
    const cli = fileURLToPath(new URL("../bin/smithers.mjs", import.meta.url))
    const env = childEnvironment({ ...process.env, ...source })
    execFileSync(process.execPath, [cli, "environment", "exec", "remote", "--", "native-tool", "login"], {
      env,
      stdio: "pipe"
    })
    expect(await readFile(join(home, "native-auth"), "utf8")).toBe("synthetic-fixture-only")
    await expect(readFile(join(source.HOME!, "native-auth"))).rejects.toThrow()
    execFileSync(process.execPath, [cli, "environment", "exec", "remote", "--", "native-tool", "exec"], {
      env,
      stdio: "pipe"
    })
    execFileSync(process.execPath, [cli, "tui", "--environment", "remote"], { env, stdio: "pipe" })
    const expected = `${home}\n${directory}\n`
    expect(await readFile(join(home, "executed"), "utf8")).toBe(expected)
    expect(await readFile(join(home, "tui-executed"), "utf8")).toBe(expected)
  })
  it("refuses a changed host key before executing a remote sentinel", async () => {
    const original = await readFile(join(root, "known_hosts"), "utf8")
    const wrong = (await readFile(join(root, "wrong.pub"), "utf8")).trim().split(" ").slice(0, 2).join(" ")
    await writeFile(join(root, "known_hosts"), original.replace(/ssh-ed25519 .*/, wrong))
    try {
      expect(await Environments.run(profile, ["touch", join(home, "sentinel")], source)).not.toBe(0)
      await expect(readFile(join(home, "sentinel"))).rejects.toThrow()
    } finally {
      await writeFile(join(root, "known_hosts"), original)
    }
  })
  it("reports cancellation and a refused connection as failures", async () => {
    const controller = new AbortController()
    const pending = Environments.run(
      profile,
      ["sh", "-c", `echo ready > '${join(home, "started")}'; exec sleep 20`],
      source,
      { signal: controller.signal }
    )
    await waitFile(join(home, "started"))
    controller.abort()
    expect(await pending).toBe(130)
    const closed = await reserve()
    await writeFile(
      config,
      `${await readFile(config, "utf8")}\nHost disconnected\nHostName 127.0.0.1\nPort ${closed}\nConnectTimeout 2\n`
    )
    expect(await Environments.run({ ...profile, destination: "disconnected" }, ["true"], source)).not.toBe(0)
    expect(await Environments.run(profile, ["sh", "-c", "kill -KILL $PPID; sleep 1"], source)).not.toBe(0)
  })
  const silentPeer = async () => {
    const sockets = new Set<Socket>()
    let accepted!: () => void
    const connected = new Promise<void>((resolve) => {
      accepted = resolve
    })
    const peer = createServer((socket) => {
      sockets.add(socket)
      socket.write("synthetic-private-provider-detail token=do-not-print\r\n")
      socket.on("data", () => {})
      socket.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code !== "ECONNRESET") throw error
      })
      socket.once("close", () => sockets.delete(socket))
      accepted()
    })
    await new Promise<void>((resolve) => peer.listen(0, "127.0.0.1", resolve))
    const port = (peer.address() as { port: number }).port
    const destination = `silent-${port}`
    await writeFile(
      config,
      `${await readFile(
        config,
        "utf8"
      )}\nHost ${destination}\nHostName 127.0.0.1\nPort ${port}\nConnectTimeout none\nConnectionAttempts 10\n`
    )
    return {
      destination,
      connected,
      sockets,
      close: async () => {
        for (const socket of sockets) socket.destroy()
        await new Promise<void>((resolve) => peer.close(() => resolve()))
      }
    }
  }
  it("bounds a silent SSH handshake and emits only a fixed actionable transport diagnostic", async () => {
    const started = Date.now()
    let connectedMs: number | undefined
    const peer = await silentPeer()
    const saved = { ...profile, name: peer.destination, destination: peer.destination }
    await Environments.add(saved, source)
    const cli = fileURLToPath(new URL("../bin/smithers.mjs", import.meta.url))
    const receipt = join(root, "handshake-bootstrap.json")
    const observe = "data:text/javascript," + encodeURIComponent(`
import { getCompileCacheDir } from "node:module";
import { writeFileSync } from "node:fs";
writeFileSync(${
      JSON.stringify(receipt)
    }, JSON.stringify({ pid: process.pid, cached: getCompileCacheDir() !== undefined }));
`)
    const child = spawn(process.execPath, ["--import", observe, cli, "environment", "exec", saved.name, "--", "true"], {
      env: childEnvironment({ ...process.env, ...source }),
      stdio: ["ignore", "pipe", "pipe"]
    })
    children.push(child)
    let stderr = "", stdout = ""
    child.stderr!.on("data", (data) => {
      stderr += data
    })
    child.stdout!.on("data", (data) => {
      stdout += data
    })
    const exited = new Promise<number | null>((resolve) => child.once("close", resolve))
    onTestFailed(({ task }) => {
      const diagnostic = "SSH handshake progress " + JSON.stringify({
        elapsedMs: Date.now() - started,
        connectedMs,
        exitCode: child.exitCode,
        signalCode: child.signalCode,
        stdoutBytes: Buffer.byteLength(stdout),
        stderrBytes: Buffer.byteLength(stderr)
      })
      for (const error of task.result?.errors ?? []) error.message += `\n${diagnostic}`
      console.error(diagnostic)
    })
    const watchdog = setTimeout(() => child.kill("SIGTERM"), 23_000)
    try {
      await peer.connected
      connectedMs = Date.now() - started
      const bootstrap = JSON.parse(await readFile(receipt, "utf8"))
      expect(bootstrap.pid).toBe(child.pid)
      if (process.env.SMITHERS_CLI_NODE_COMPILE_CACHE) {
        expect(bootstrap.cached).toBe(
          !process.env.SMITHERS_CLI_DISABLE_COMPILE_CACHE && process.env.NODE_V8_COVERAGE === undefined
        )
      }
      expect(await exited).toBe(255)
      expect(stderr.trim()).toBe("SSH session failed (exit 255). Check connectivity, known_hosts and SSH access.")
      expect(stdout).toBe("")
      for (let i = 0; i < 100 && peer.sockets.size; i++) await pause()
      expect(peer.sockets.size).toBe(0)
    } finally {
      clearTimeout(watchdog)
      child.kill("SIGKILL")
      await peer.close()
    }
  }, 30_000)
  it("cancels a silent handshake and closes its socket", async () => {
    const peer = await silentPeer()
    const controller = new AbortController()
    const pending = Environments.run({ ...profile, destination: peer.destination }, ["true"], source, {
      signal: controller.signal
    })
    try {
      await peer.connected
      controller.abort()
      expect(await pending).toBe(130)
      for (let i = 0; i < 100 && peer.sockets.size; i++) await pause()
      expect(peer.sockets.size).toBe(0)
    } finally {
      controller.abort()
      await pending
      await peer.close()
    }
  })
  it("lets a connected remote command outlive the connection deadline and preserves its exit status", async () => {
    expect(
      await Promise.all(
        [false, true].map((terminal) =>
          Environments.run(profile, ["sh", "-c", "sleep 16; exit 37"], source, { terminal })
        )
      )
    ).toEqual([37, 37])
  })
  it("forwards a real local socket through the SSH server", async () => {
    const echo: Server = createServer((socket) => socket.pipe(socket))
    await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve))
    const localPort = await reserve(), remotePort = (echo.address() as { port: number }).port
    const controller = new AbortController()
    const pending = Environments.run(profile, [], source, {
      signal: controller.signal,
      forward: { localPort, remotePort }
    })
    try {
      let reply = ""
      for (let i = 0; i < 100; i++) {
        try {
          reply = await new Promise<string>((resolve, reject) => {
            const socket = connect(localPort, "127.0.0.1", () => socket.write("real-ssh-forward"))
            socket.setTimeout(1000, () => socket.destroy(new Error("echo timeout")))
            socket.once("error", reject)
            socket.once("data", (data) => {
              socket.destroy()
              resolve(data.toString())
            })
          })
          break
        } catch {
          await pause()
        }
      }
      expect(reply).toBe("real-ssh-forward")
    } finally {
      controller.abort()
      expect(await pending).toBe(130)
      await new Promise<void>((resolve) => echo.close(() => resolve()))
    }
  })
})

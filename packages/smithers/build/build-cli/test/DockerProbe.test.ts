import * as NodeChildProcess from "node:child_process"
import { afterEach, expect, it, vi } from "vitest"
import { dockerAvailable } from "./helpers/DockerProbe.ts"

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }))

afterEach(() => vi.restoreAllMocks())

it("fails a stalled Docker availability probe instead of skipping its tests", () => {
  const error = Object.assign(new Error("spawnSync docker ETIMEDOUT"), { code: "ETIMEDOUT" })
  const spawn = vi.mocked(NodeChildProcess.spawnSync).mockReturnValue({
    pid: 123,
    output: [null, null, null],
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    status: null,
    signal: "SIGKILL",
    error
  })
  expect(dockerAvailable).toThrow("Docker availability probe timed out after 5000ms")
  // Kill the actual probe, not a shell that leaves docker info behind.
  expect(spawn).toHaveBeenCalledWith("docker", ["info"], {
    stdio: "ignore",
    timeout: 5000,
    killSignal: "SIGKILL"
  })
})

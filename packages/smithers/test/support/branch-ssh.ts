import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeCli } from "../../src/Cli.ts"

export async function invokeBranchSsh(endpoint: unknown, env: NodeJS.ProcessEnv = {}) {
  const home = await mkdtemp(join(tmpdir(), "branch-ssh-cli-"))
  const seen: string[] = []
  const server = createServer((request, response) => {
    seen.push(request.url!)
    response.writeHead(200, { "Content-Type": "application/json" })
    response.end(JSON.stringify(endpoint))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const environment = {
    HOME: home,
    ...env,
    XDG_CONFIG_HOME: home,
    XDG_DATA_HOME: home,
    SMITHERS_TOKEN: "fixture-token",
    SMITHERS_API_ORIGIN: `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  }
  let code = 0, output = ""
  try {
    await makeCli({
      environment,
      exit: (value) => {
        code = value
      }
    }).serve(["ssh", "retry", "--json"], {
      env: environment,
      stdout: (value) => {
        output += value
      },
      exit: (value) => {
        code = value
      }
    })
    return { code, output, seen }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    await rm(home, { recursive: true, force: true })
  }
}

import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const cwd = fileURLToPath(new URL("../", import.meta.url))
const listeners = [
  ["postgres", "MVP_TEST_POSTGRES_BIND", "54321", 5432],
  ["electric", "MVP_TEST_ELECTRIC_BIND", "30001", 3000],
  ["pgbouncer", "MVP_TEST_POOL_BIND", "54322", 5432],
]

for (const scenario of [
  { name: "unset bindings default to loopback" },
  { name: "empty bindings default to loopback", binding: () => "" },
  { name: "owned fixtures keep their loopback port overrides", binding: (_, index) => `127.0.0.1:${45001 + index}`, fixture: true },
  { name: "network exposure requires an explicit binding", binding: port => `0.0.0.0:${port}`, host: "0.0.0.0" },
]) {
  test(scenario.name, () => {
    const env = { ...process.env }
    for (const [index, [, variable, port]] of listeners.entries()) {
      delete env[variable]
      if (scenario.binding) env[variable] = scenario.binding(port, index)
    }
    const args = ["compose", "--env-file", "/dev/null", "-f", "docker-compose.yml"]
    if (scenario.fixture) args.push("-f", "docker-compose.test.yml")
    args.push("config", "--format", "json")
    const result = spawnSync("docker", args, { cwd, env, encoding: "utf8", timeout: 15_000 })
    assert.equal(result.status, 0, result.stderr)
    const { services } = JSON.parse(result.stdout)
    for (const [index, [service, , port, target]] of listeners.entries()) {
      const ports = services[service].ports
      assert.equal(ports.length, 1, service)
      assert.equal(ports[0].host_ip, scenario.host ?? "127.0.0.1", service)
      assert.equal(ports[0].published, scenario.fixture ? String(45001 + index) : port, service)
      assert.equal(ports[0].target, target, service)
      assert.equal(ports[0].protocol, "tcp", service)
    }
  })
}

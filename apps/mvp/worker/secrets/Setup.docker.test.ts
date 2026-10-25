// The box's egress setups (worker/secrets/SandboxEgress.ts `SETUP` and `TRUST`) in a real branch-sandbox container,
// run as root as a wake runs them. With secrets on, a login shell of another user gets the placeholders and Node's extra
// CA, and the container's CA is trusted system-wide. Without, the box gets no environment file, and every tool it ships
// (curl, Node, pip in a venv, Go) trusts an HTTPS server signed by the container's CA, as the registry egress's HTTPS is.
// Either script prints nothing even when a step fails, since workerd reports a command's exit only once its unread
// output closes. The image is built from infra/sandbox each run (Docker's cache makes an unchanged one quick), so a
// stale image never stands in for the Dockerfile. It skips only when Docker is absent, as the idle probe's test does.
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { CONTAINER_CA, SETUP, TRUST } from "./SandboxEgress.ts"

const image = "smithers-branch-sandbox:test"
const context = fileURLToPath(new URL("../../infra/sandbox", import.meta.url))
const PLACEHOLDER = `smthrs-secret-${"ab".repeat(32)}`
/** A person's numeric user in the `workspace` group, with no passwd entry, as a deployed box runs a shell. */
const PERSON = "585780777:2000"

const docker = (args: ReadonlyArray<string>, input?: string) =>
  spawnSync("docker", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...(input === undefined ? {} : { input }) })
const present = docker(["version", "--format", "{{.Server.Version}}"]).status === 0

/** Runs `argv` with Docker and answers its output; throws with what it printed when it fails. */
const must = (args: ReadonlyArray<string>, input?: string) => {
  const run = docker(args, input)
  if (run.status !== 0) throw new Error(`docker ${args[0]} failed (${run.status}): ${(run.stdout + run.stderr).slice(-4000)}`)
  return run.stdout
}

beforeAll(() => {
  if (present) must(["build", "-t", image, context])
}, 900_000)

/** A running box: its id, a root shell, a script run as root with `input` on stdin, and a person's login shell. */
const box = () => {
  const id = must(["run", "-d", "--rm", image]).trim()
  return {
    id,
    root: (script: string) => docker(["exec", "--user", "0:0", id, "sh", "-c", script]),
    setup: (script: string, input = "") => {
      const run = docker(["exec", "-i", "--user", "0:0", id, "sh", "-c", script], input)
      return { status: run.status, printed: run.stdout + run.stderr }
    },
    login: (script: string) => docker(["exec", "--user", PERSON, id, "bash", "-lc", script]),
    remove: () => docker(["rm", "-f", id]),
  }
}

describe.skipIf(!present)("the egress setup in a real container", () => {
  let machine: ReturnType<typeof box>
  let scratch = ""

  beforeAll(() => {
    machine = box()
    // A CA where Cloudflare puts the container's own.
    scratch = mkdtempSync(join(tmpdir(), "egress-setup-"))
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=egress-setup-test",
      "-keyout", join(scratch, "ca.key"), "-out", join(scratch, "ca.crt"),
    ], { stdio: "ignore" })
    machine.root("mkdir -p /etc/cloudflare/certs")
    must(["cp", join(scratch, "ca.crt"), `${machine.id}:${CONTAINER_CA}`])
  }, 120_000)
  afterAll(() => {
    machine?.remove()
    if (scratch !== "") rmSync(scratch, { recursive: true, force: true })
  })

  test("a login shell gets the placeholders and Node's CA, the CA is trusted, and nothing is printed", () => {
    expect(machine.setup(SETUP, `DEMO_TOKEN=${PLACEHOLDER}\n`)).toEqual({ status: 0, printed: "" })
    expect(machine.login(`printf '%s|%s' "$DEMO_TOKEN" "$NODE_EXTRA_CA_CERTS"`).stdout).toBe(`${PLACEHOLDER}|${CONTAINER_CA}`)
    expect(machine.root("test -e /etc/ssl/certs/cloudflare-containers-ca.pem").status).toBe(0)
  }, 60_000)

  test("a CA that can't be trusted is exit 2, still prints nothing, and the placeholders still reach a shell", () => {
    machine.root("rm -rf /usr/local/share/ca-certificates && touch /usr/local/share/ca-certificates")
    expect(machine.setup(SETUP, `OTHER_TOKEN=${PLACEHOLDER}\n`)).toEqual({ status: 2, printed: "" })
    expect(machine.login(`printf '%s' "$OTHER_TOKEN"`).stdout).toBe(PLACEHOLDER)
  }, 60_000)
})

// A small HTTPS server on the box's loopback, its certificate signed by a test CA: the registry egress's HTTPS, which the
// container's CA signs, as the box sees it.
const SERVE = `
import functools, http.server, ssl
handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory="/srv/www")
server = http.server.ThreadingHTTPServer(("127.0.0.1", 8443), handler)
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain("/root/tls/server.crt", "/root/tls/server.key")
server.socket = context.wrap_socket(server.socket, server_side=True)
server.serve_forever()
`
const URL_OK = "https://localhost:8443/ok.txt"
/** A Go program that prints what an HTTPS GET answers, with Go's own TLS stack and roots, as the go command fetches. */
const GET_GO = `package main

import (
\t"fmt"
\t"io"
\t"net/http"
\t"os"
)

func main() {
\tresponse, err := http.Get(os.Args[1])
\tif err != nil {
\t\tfmt.Println("refused:", err)
\t\tos.Exit(1)
\t}
\tbody, _ := io.ReadAll(response.Body)
\tfmt.Print(string(body))
}
`

describe.skipIf(!present)("the trust setup of a box without secrets in a real container", () => {
  let machine: ReturnType<typeof box>

  /** What each tool gets from the server: curl, Node in a person's login shell, Go, and pip in a venv. */
  const fetched = () => ({
    curl: machine.root(`curl -fsS ${URL_OK}`).stdout,
    node: machine.login(`node -e 'fetch("${URL_OK}").then((r) => r.text()).then((t) => process.stdout.write(t), () => process.stdout.write("refused"))'`).stdout,
    go: machine.root(`/root/get ${URL_OK}`).stdout,
    // An index with nothing in it: a trusted pip reads it and finds no version; an untrusted one never gets there.
    pip: machine.root("/root/venv/bin/pip download --no-deps --retries 0 --timeout 10 -d /tmp/pip --index-url https://localhost:8443/simple/ demo 2>&1").stdout,
  })

  beforeAll(() => {
    machine = box()
    const made = machine.root([
      "set -e",
      "mkdir -p /root/tls /srv/www/simple && echo trusted > /srv/www/ok.txt && cd /root/tls",
      "openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=trust-test-ca -addext basicConstraints=critical,CA:TRUE -addext keyUsage=critical,keyCertSign -keyout ca.key -out ca.crt",
      "openssl req -newkey rsa:2048 -nodes -subj /CN=localhost -addext subjectAltName=DNS:localhost -keyout server.key -out server.csr",
      "openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 1 -copy_extensions copy -out server.crt",
      `printf '%s' '${GET_GO}' > /root/get.go && cd /root && go build -o /root/get get.go`,
      "python3 -m venv /root/venv",
    ].join("\n"))
    if (made.status !== 0) throw new Error(made.stdout + made.stderr)
    must(["exec", "-d", "--user", "0:0", machine.id, "python3", "-c", SERVE])
    must(["exec", machine.id, "sh", "-c", `for i in $(seq 100); do curl -sk -o /dev/null ${URL_OK} && exit 0; sleep 0.1; done; exit 1`])
  }, 300_000)
  afterAll(() => machine?.remove())

  test("the image carries Go, Python and a C toolchain on the default PATH", () => {
    // beforeAll built a Go program and made a venv with them.
    const tools = machine.login("go version && command -v go gofmt gcc g++ make python3 && python3 -m pip --version")
    expect(tools.status).toBe(0)
    expect(tools.stdout).toContain("go version go1.27.3 linux/")
    expect(tools.stdout).toContain("/usr/local/bin/gofmt\n")
    expect(tools.stdout).toContain("/usr/bin/make\n")
    expect(tools.stdout).toMatch(/^pip \d+/m)
  }, 60_000)

  test("without the container's CA it changes nothing, and nothing in the box trusts the server", () => {
    expect(machine.setup(TRUST)).toEqual({ status: 0, printed: "" })
    expect(machine.root("test -e /etc/profile.d/smithers-trust.sh").status).toBe(1)
    const untrusted = fetched()
    expect(untrusted.curl).toBe("")
    expect(untrusted.node).toBe("refused")
    expect(untrusted.go).toContain("refused:")
    expect(untrusted.pip).toContain("CERTIFICATE_VERIFY_FAILED")
  }, 120_000)

  test("with it, curl, Node, Go and pip trust the server; the box gets no environment file, and nothing is printed", () => {
    machine.root(`mkdir -p /etc/cloudflare/certs && cp /root/tls/ca.crt ${CONTAINER_CA}`)
    expect(machine.setup(TRUST)).toEqual({ status: 0, printed: "" })
    const trusted = fetched()
    expect(trusted.curl).toBe("trusted\n")
    expect(trusted.node).toBe("trusted\n")
    expect(trusted.go).toBe("trusted\n")
    expect(trusted.pip).toContain("No matching distribution found for demo")
    expect(trusted.pip).not.toContain("CERTIFICATE_VERIFY_FAILED")
    expect(machine.login(`printf '%s|%s' "$NODE_EXTRA_CA_CERTS" "$DPRINT_CERT"`).stdout).toBe(`${CONTAINER_CA}|${CONTAINER_CA}`)
    // No placeholder, no environment file: what e2e/sandbox-lifecycle.spec.ts checks on a branch's machine.
    expect(machine.root("test -e /run/smithers/env").status).toBe(1)
    // A wake on a running box runs it again.
    expect(machine.setup(TRUST)).toEqual({ status: 0, printed: "" })
  }, 120_000)

  test("a CA the system store can't take is exit 2, and still prints nothing", () => {
    machine.root("rm -rf /usr/local/share/ca-certificates && touch /usr/local/share/ca-certificates")
    expect(machine.setup(TRUST)).toEqual({ status: 2, printed: "" })
  }, 60_000)
})

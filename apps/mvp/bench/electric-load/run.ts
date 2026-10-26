// `node bench/electric-load/run.ts --routes <file> --devices N [--seconds 120] [--host <label>] [--storage-state <file>]
//   [--write-at <s> --write-cmd <command> --write-route <path>] --out <file>`
// This host's share of a load run: N devices, each following every route in the routes file (routes.ts) from its own
// start, as a tab does, for the whole run, speaking Electric's protocol as the app's collections do (protocol.ts).
// Every response is counted, the ones a retry hides included. Writes a HostRecord (stats.ts); report.ts sums several
// hosts' records.
import { execFile } from "node:child_process"
import { readFile, writeFile } from "node:fs/promises"
import { hostname } from "node:os"
import { setTimeout as sleep } from "node:timers/promises"
import { parseArgs } from "node:util"
import { START, step, urlOf } from "./protocol.ts"
import { count, type HostRecord } from "./stats.ts"

const { values: args } = parseArgs({
  options: {
    routes: { type: "string" },
    devices: { type: "string", default: "8" },
    seconds: { type: "string", default: "120" },
    host: { type: "string", default: hostname() },
    "storage-state": { type: "string" },
    "write-at": { type: "string" },
    "write-cmd": { type: "string" },
    "write-route": { type: "string" },
    out: { type: "string" },
  },
})
if (args.routes === undefined || args.out === undefined) throw new Error("--routes <file> and --out <file> are required")

interface Route {
  readonly path: string
  readonly params: Record<string, string>
}
const { target, routes } = JSON.parse(await readFile(args.routes, "utf8")) as { target: string; routes: ReadonlyArray<Route> }
const devices = Number(args.devices)
const seconds = Number(args.seconds)

/** The cookie header a Playwright storage state carries for `target`. */
const cookieFor = async (file: string): Promise<string> => {
  const { cookies } = JSON.parse(await readFile(file, "utf8")) as { cookies: ReadonlyArray<{ name: string; value: string; domain: string }> }
  const host = new URL(target).hostname
  return cookies.filter((cookie) => host.endsWith(cookie.domain.replace(/^\./, ""))).map((cookie) => `${cookie.name}=${cookie.value}`).join("; ")
}
const cookie = args["storage-state"] === undefined ? undefined : await cookieFor(args["storage-state"])

const responses: Record<string, number> = {}
let unanswered = 0
const stop = new AbortController()
const startedAt = new Date()
const upToDateMs: Array<number | null> = []
let writtenAt: number | undefined
const writeToDeviceMs: Array<number | null> = []

/** One route followed by one device until the run stops, recording when it first got up to date. */
const follow = async (route: Route, start: number) => {
  const slot = upToDateMs.push(null) - 1
  const writeSlot = route.path === args["write-route"] ? writeToDeviceMs.push(null) - 1 : -1
  let position = START
  while (!stop.signal.aborted) {
    const url = urlOf(target, route.path, route.params, position)
    let status: number | undefined
    let headers: Headers = new Headers()
    let body = ""
    try {
      const response = await fetch(url, { signal: stop.signal, ...(cookie === undefined ? {} : { headers: { cookie } }) })
      body = await response.text()
      status = response.status
      headers = response.headers
      count(responses, { status, live: position.live })
    } catch {
      if (stop.signal.aborted) return
      unanswered++
    }
    const next = step(position, status, headers, body, 0.8 + Math.random() * 0.4)
    if (next.upToDate && upToDateMs[slot] === null) upToDateMs[slot] = Math.round(performance.now() - start)
    if (next.changed && writeSlot >= 0 && writtenAt !== undefined && writeToDeviceMs[writeSlot] === null) {
      writeToDeviceMs[writeSlot] = Math.round(performance.now() - writtenAt)
    }
    position = next.next
    if (next.waitMs > 0) await sleep(next.waitMs, undefined, { signal: stop.signal }).catch(() => undefined)
  }
}

/** One device: every route followed from its start. */
const device = () => {
  const start = performance.now()
  for (const route of routes) void follow(route, start)
}

for (let index = 0; index < devices; index++) device()
if (args["write-at"] !== undefined && args["write-cmd"] !== undefined) {
  setTimeout(() => {
    writtenAt = performance.now()
    execFile("sh", ["-c", args["write-cmd"]!], () => undefined)
  }, Number(args["write-at"]) * 1000)
}
await new Promise((resolve) => setTimeout(resolve, seconds * 1000))
stop.abort()
const record: HostRecord = {
  host: args.host,
  devices,
  signedIn: cookie !== undefined,
  startedAt: startedAt.toISOString(),
  endedAt: new Date().toISOString(),
  routes: routes.length,
  responses,
  unanswered,
  upToDateMs,
  writeToDeviceMs,
}
await writeFile(args.out, JSON.stringify(record))
console.log(`${args.host}: ${devices} devices, ${Object.values(responses).reduce((a, b) => a + b, 0)} responses ${JSON.stringify(responses)}, ${unanswered} unanswered`)
process.exit(0)

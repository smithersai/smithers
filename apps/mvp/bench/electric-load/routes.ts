// `node bench/electric-load/routes.ts --target <origin> --page <path> [--storage-state <file>] [--seconds 15] --out <file>`
// Opens the page once in real Chromium and writes the shape routes it follows, each with its own parameters and
// without Electric's protocol ones, for run.ts's devices to follow. Signed in with a Playwright storage state.
import { chromium } from "@playwright/test"
import { writeFile } from "node:fs/promises"
import { parseArgs } from "node:util"
import { PROTOCOL_PARAMS } from "./protocol.ts"

const { values: args } = parseArgs({
  options: {
    target: { type: "string", default: "https://smithers.sh" },
    page: { type: "string", default: "/smithersai/smithers" },
    "storage-state": { type: "string" },
    seconds: { type: "string", default: "15" },
    out: { type: "string" },
  },
})
if (args.out === undefined) throw new Error("--out <file> is required")

const browser = await chromium.launch()
const context = await browser.newContext(args["storage-state"] === undefined ? {} : { storageState: args["storage-state"] })
const page = await context.newPage()
const routes = new Map<string, { path: string; params: Record<string, string> }>()
page.on("request", (request) => {
  const url = new URL(request.url())
  if (!url.pathname.startsWith("/api/shapes/")) return
  const params = Object.fromEntries([...url.searchParams].filter(([key]) => !PROTOCOL_PARAMS.has(key)))
  routes.set(`${url.pathname}?${new URLSearchParams(params)}`, { path: url.pathname, params })
})
await page.goto(new URL(args.page, args.target).href)
await page.waitForTimeout(Number(args.seconds) * 1000)
await browser.close()
const list = [...routes.values()].sort((a, b) => a.path.localeCompare(b.path))
await writeFile(args.out, JSON.stringify({ target: args.target, page: args.page, signedIn: args["storage-state"] !== undefined, routes: list }, null, 2))
console.log(`${list.length} shape routes: ${list.map((route) => route.path.slice("/api/shapes/".length)).join(", ")}`)

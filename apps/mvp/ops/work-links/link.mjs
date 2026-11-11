#!/usr/bin/env node
// Posts work links to a Smithers issue (decision 0147, docs/features/work-links.md), for lanes, the merge queue and
// anything else that does the work outside Smithers. No dependencies: Node 20 or later.
//
//   node link.mjs --repo <owner>/<name> --issue <n> --kind <kind> --ref <ref> [--state <state>] [--label <text>]
//                 [--url https://...] [--at <ISO time, now unless set>] [--origin https://smithers.sh] [--token-file <path>]
//   node link.mjs --repo <owner>/<name> --issue <n> --json <file with {"links":[...]}>
//
// kind: assignee, session, queue, pr, merge, review. state: working, queued, open, passed, failed, merged, done,
// closed. The token is a runner's registered on the repository (`smthrs runner token`), read from `--token-file`,
// else $SMITHERS_WORK_TOKEN_FILE, else ~/.smithers/runner/runner-token; it never goes on argv or in output. Exit 0 with
// `{"links":n,"changed":m}` on stdout; 1 with the refusal's code on stderr. It waits out 429 and 503 (`retry-after`,
// else 5 s, doubling, at most 5 tries).
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { parseArgs } from "node:util"

/** Throws if TLS checks are off. Inlined from ops/tls.mjs: this file has no dependencies. */
const refuseUncheckedTls = (env) => {
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0") throw new Error("TLS checks are turned off in this environment: refusing to run")
}

/** The request body for the options, or an error naming what's missing. */
export const bodyOf = (values, read = (path) => readFileSync(path, "utf8"), now = () => new Date().toISOString()) => {
  if (values.json !== undefined) return JSON.parse(read(values.json))
  if (values.kind === undefined || values.ref === undefined) throw new Error("--kind and --ref are required, or --json")
  const link = { kind: values.kind, ref: values.ref }
  for (const key of ["state", "label", "url"]) if (values[key] !== undefined) link[key] = values[key]
  // When it happened, fixed once: a post sent again after a lost answer is the same post, and changes nothing.
  link.at = values.at ?? now()
  return { links: [link] }
}

/** Posts `body` to issue `issue` of `repo` at `origin` with `token`; resolves `{ status, answer }`. */
export const post = async ({ origin, repo, issue, token, body, fetch = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) => {
  refuseUncheckedTls(process.env)
  // Validate the whole opaque credential before any header validator can quote it in an error.
  if (typeof token !== "string" || token.length === 0 || /[^\x21-\x7e]/.test(token)) throw new Error("invalid runner token")
  const [owner, name] = repo.split("/")
  const url = `${origin}/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${Number(issue)}/links`
  let wait = 5000
  for (let attempt = 1; ; attempt++) {
    let response
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    } catch {
      // Transport errors may quote headers or URLs: never retain their message or cause.
      throw new Error("work link request failed")
    }
    const answer = await response.json().catch(() => ({}))
    if ((response.status !== 429 && response.status !== 503) || attempt >= 5) return { status: response.status, answer }
    const retryAfter = Number(response.headers.get("retry-after"))
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : wait)
    wait *= 2
  }
}

const main = async () => {
  refuseUncheckedTls(process.env)
  const { values } = parseArgs({
    options: {
      origin: { type: "string", default: "https://smithers.sh" },
      repo: { type: "string" },
      issue: { type: "string" },
      kind: { type: "string" },
      ref: { type: "string" },
      state: { type: "string" },
      label: { type: "string" },
      url: { type: "string" },
      at: { type: "string" },
      json: { type: "string" },
      "token-file": { type: "string" },
    },
  })
  if (values.repo === undefined || values.issue === undefined) throw new Error("--repo and --issue are required")
  const file = values["token-file"] ?? process.env.SMITHERS_WORK_TOKEN_FILE ?? `${homedir()}/.smithers/runner/runner-token`
  const token = readFileSync(file, "utf8").trim()
  const { status, answer } = await post({ origin: values.origin, repo: values.repo, issue: values.issue, token, body: bodyOf(values) })
  if (status === 200) {
    process.stdout.write(`${JSON.stringify(answer)}\n`)
    return
  }
  process.stderr.write(`work link refused: HTTP ${status} ${typeof answer.code === "string" ? answer.code : ""}\n`)
  process.exitCode = 1
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}

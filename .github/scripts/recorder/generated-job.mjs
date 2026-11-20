/**
 * A job of the workflow `smithers-ci apply` writes, on the runner this runs on:
 * it records what each step reads with `smthrs-observe`, with no strace on the
 * machine, and reuses what it recorded at the next commit.
 *
 * `node .github/scripts/recorder/generated-job.mjs <repository URL> <commit>
 * <commit>` clones the repository, and at each commit runs `smithers-ci
 * apply`, commits what it wrote, and runs the job's `run:` steps as written,
 * each `${{ }}` filled as a GitHub-hosted Linux runner fills it for a Linux leg
 * of this Node, and each `if:` decided the same way. The one change: the
 * steps' `npx --package=smithers-ci@<version>` and `npx --package=@smthrs/cli@<version>`
 * run this checkout's programs, so the proof holds for this commit. The
 * runner's temporary directory is kept from the first commit to the second,
 * as the workflow's `actions/cache` keeps it.
 *
 * It fails unless strace is absent, `smthrs-observe` ran and strace never did,
 * the steps passed at both commits, and the second commit reused results.
 */
import { spawn, spawnSync } from "node:child_process"
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../../../", import.meta.url))
const yaml = createRequire(join(root, "package.json"))("yaml")
const [url, ...commits] = process.argv.slice(2)
if (url === undefined || commits.length !== 2) {
  console.error("usage: node .github/scripts/recorder/generated-job.mjs <repository URL> <commit> <commit>")
  process.exit(2)
}
const fail = (line) => {
  console.error(`generated-job: ${line}`)
  process.exit(1)
}
if (spawnSync("sh", ["-c", "command -v strace"]).status === 0) fail("strace is installed here; remove it first")

const smithersCi = `${process.execPath} ${join(root, "packages/ci/bin/smithers-ci.mjs")}`
const smthrs = join(root, "node_modules/.bin/smthrs")
const work = mkdtempSync(join(tmpdir(), "generated-job-"))
const repository = join(work, "repo")
const runnerTemp = join(work, "runner-temp")
const git = (...args) => {
  const run = spawnSync("git", args, { cwd: repository, encoding: "utf8" })
  if (run.status !== 0) fail(`git ${args.join(" ")}: ${run.stderr.trim()}`)
  return run.stdout
}
if (spawnSync("git", ["clone", "-q", url, repository], { stdio: "inherit" }).status !== 0) fail(`cannot clone ${url}`)

/** The parent of a process, or 0 once it is gone. */
const parentOf = (pid) => {
  try {
    // The name in parentheses may hold spaces; the parent is the second field after it.
    return Number(readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /s, "").split(" ")[1])
  } catch {
    return 0
  }
}
/** Whether `pid` was started, at any depth, by this program. */
const ours = (pid) => {
  for (let at = pid; at > 1; at = parentOf(at)) if (at === process.pid) return true
  return false
}

// Every recorder the steps start, seen in the process table while they run.
const recorders = new Map()
const sampler = setInterval(() => {
  for (const pid of readdirSync("/proc").filter((name) => /^\d+$/.test(name)).map(Number)) {
    let argv
    try {
      argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0")
    } catch {
      continue
    }
    if (!/(^|\/)(smthrs-observe|strace)$/.test(argv[0]) || !ours(pid)) continue
    const program = argv[0].split("/").pop()
    if ((program === "smthrs-observe" || program === "strace") && !recorders.has(program)) {
      recorders.set(program, argv.join(" ").slice(0, 200))
    }
  }
}, 50)

/** Runs `script` under bash -e in the repository, its output shown and kept. */
const step = (script, env) =>
  new Promise((resolve) => {
    let output = ""
    const child = spawn("bash", ["-e", "-c", script], { cwd: repository, env: { ...process.env, ...env } })
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (chunk) => {
        output += chunk
        process.stdout.write(chunk)
      })
    }
    child.on("close", (code) => resolve({ code, output }))
  })

const major = process.versions.node.split(".")[0]
const counts = []
for (const [index, commit] of commits.entries()) {
  git("checkout", "-q", "--detach", commit)
  git("clean", "-fdxq")
  console.log(`== commit ${commit}: smithers-ci apply`)
  const applied = await step(`${smithersCi} apply`, {})
  if (applied.code !== 0) fail(`smithers-ci apply exited ${applied.code} at ${commit}`)
  git("add", "--all")
  git("-c", "user.name=Proof", "-c", "user.email=proof@example.test", "commit", "-q", "-m", "smithers-ci apply")
  const job = yaml.parse(readFileSync(join(repository, ".github/workflows/smithers-ci.yml"), "utf8")).jobs.ci
  const leg = job.strategy.matrix.include.find((entry) =>
    /ubuntu/.test(entry.os) && String(entry["version-node"] ?? "").split(".")[0] === major
  ) ?? job.strategy.matrix.include.find((entry) => /ubuntu/.test(entry.os))
  if (leg === undefined) fail("the generated workflow has no Linux leg")
  const values = {
    "matrix.leg": String(leg.leg),
    "matrix.os": leg.os,
    "runner.os": "Linux",
    "runner.environment": "github-hosted",
    "runner.temp": runnerTemp,
    "vars.SMITHERS_CACHE_URL": "",
    "github.event_name": "push",
    "secrets.SMITHERS_CACHE_READ_TOKEN": "",
    "secrets.SMITHERS_CACHE_TOKEN": ""
  }
  const value = (term) => {
    const quoted = /^'(.*)'$/.exec(term)
    if (quoted !== null) return quoted[1]
    if (!(term in values)) fail(`no value for \`${term}\` in the generated workflow`)
    return values[term]
  }
  // `a == 'b' && c != ''`, and `a && b || c` as GitHub reads it: the first true term of `||`'s alternatives.
  const evaluate = (expression) =>
    expression.split("||").map((alternative) => alternative.trim()).reduce((found, alternative) => {
      if (found !== undefined) return found
      const terms = alternative.split("&&").map((term) => term.trim())
      let last = ""
      for (const term of terms) {
        const compared = /^(.+?)\s*(==|!=)\s*(.+)$/.exec(term)
        last = compared === null ? value(term) : String((value(compared[1].trim()) === value(compared[3].trim())) === (compared[2] === "=="))
        if (last === "" || last === "false") return undefined
      }
      return last
    }, undefined) ?? ""
  const fill = (text) => String(text).replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_, expression) => evaluate(expression))
  const program = (text) => {
    const ci = /npx --yes --package=smithers-ci@\S+ smithers-ci/g
    const cli = /npx --yes --package=@smthrs\/cli@\S+ smthrs/g
    return text.replace(ci, smithersCi).replace(cli, smthrs)
  }
  for (const each of job.steps.filter((entry) => typeof entry.run === "string")) {
    const condition = each.if === undefined ? "true" : evaluate(String(each.if).replace(/^\$\{\{\s*|\s*\}\}$/g, ""))
    const name = each.name ?? each.run.split("\n")[0]
    if (condition === "" || condition === "false") {
      console.log(`== ${commit}: skipped "${name}" (if: ${each.if})`)
      continue
    }
    const script = program(fill(each.run))
    const env = Object.fromEntries(Object.entries(each.env ?? {}).map(([key, entry]) => [key, fill(entry)]))
    console.log(`== ${commit}: "${name}"\n${script}`)
    const ran = await step(script, env)
    if (ran.code !== 0) fail(`"${name}" exited ${ran.code} at ${commit}`)
    const hit = /^\s*hit: (\d+)$/m.exec(ran.output)
    if (hit !== null) {
      counts[index] = Object.fromEntries(
        ["hit", "ran", "failed", "skipped"].map((key) => [key, Number(new RegExp(`^\\s*${key}: (\\d+)$`, "m").exec(ran.output)?.[1])])
      )
    }
  }
  if (counts[index] === undefined) fail(`no step of the generated job ran smthrs ci at ${commit}`)
  console.log(`== ${commit}: leg ${leg.leg} (${leg.os}, node ${leg["version-node"]}): ${JSON.stringify(counts[index])}`)
}
clearInterval(sampler)
console.log("== recorders that ran")
for (const [program, line] of recorders) console.log(`${program}: ${line}`)
writeFileSync(join(work, "proof.json"), JSON.stringify({ counts, recorders: Object.fromEntries(recorders) }, null, 2))
if (!recorders.has("smthrs-observe")) fail("smthrs-observe never ran")
if (recorders.has("strace")) fail("strace ran")
if (!(counts[1].hit > 0)) fail(`the second commit reused nothing: ${JSON.stringify(counts[1])}`)
console.log(`generated-job: recorded with smthrs-observe, no strace on the machine; the second commit reused ${counts[1].hit} of ${counts[1].hit + counts[1].ran} results`)

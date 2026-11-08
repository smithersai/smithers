#!/usr/bin/env node
/** Commit the entire shared checkout to main, using jj when present. */
import { engineeringGateEnvironment, requireEngineeringGateHome } from "./engineering-gate-environment.mjs"
import { logLanding, requiredPathsFile, requireReviews, requireReviewsGit } from "./review.mjs"
import { typecheckApp } from "./typecheck.mjs"
import { acquireLock } from "./workspace.mjs"
import { runAffectedGate, requireAffectedReceipt } from "./affected-receipt.mjs"
import { boundedSpawnSync as spawnSync } from "./process.mjs"
import { createHash } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"

const args = process.argv.slice(2)
let message = "chore: checkpoint shared working tree"
let push = false
const tests = []
let noTest
let noReviewNeeded
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--help") {
    console.log("Usage: pnpm commit [--message <message>] [--push] [--test <command> ... | --no-test <reason>] [--no-review-needed <reason>]\nCommits ALL nonignored edits, including other contributors' work, on main.\nUses jj when available in this checkout, otherwise Git. --push publishes main to origin.\nPush always requires all five landing drift targets; --no-test does not skip them.\nPush also requires a review.mjs receipt for commits touching review-required.txt paths; --no-review-needed records an exception.\nAfter validation and pushing, use pnpm deploy to publish production.")
    process.exit(0)
  } else if (args[i] === "--push") push = true
  else if (args[i] === "--test" && args[i + 1]?.trim()) tests.push(args[++i])
  else if (args[i] === "--no-test" && args[i + 1]?.trim() && !/[\r\n]/.test(args[i + 1])) noTest = args[++i]
  else if (args[i] === "--no-review-needed" && args[i + 1]?.trim() && !/[\r\n]/.test(args[i + 1])) noReviewNeeded = args[++i]
  else if ((args[i] === "--message" || args[i] === "-m") && args[i + 1]?.trim()) message = args[++i]
  else throw new Error(`Unknown or incomplete argument: ${args[i]}`)
}

if (tests.length && noTest) throw new Error("--test and --no-test are mutually exclusive.")
if (push && !tests.length && !noTest) {
  console.error("NOT LANDED: --push requires --test <command> or --no-test <reason>.")
  process.exit(1)
}
if (tests.length || noTest) message += `\n\nLanding-Tests: ${noTest ? `none (${noTest})` : tests.join("; ")}`

let root = realpathSync(process.cwd())
while (!existsSync(join(root, ".jj")) && !existsSync(join(root, ".git"))) {
  const parent = dirname(root)
  if (parent === root) throw new Error("Run commit inside a jj or Git checkout.")
  root = parent
}
const run = (command, argv, capture = false, environment = process.env) => {
  const result = spawnSync(command, argv, { cwd: root, encoding: "utf8", env: environment, stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit" })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${argv[0]} failed (${result.status})${capture ? `: ${result.stdout}${result.stderr}` : ""}`)
  return result.stdout?.trim() ?? ""
}

// Serializes users of this entry point without adding a file to the commit.
// Editors can keep working; the VCS snapshots the edits present at commit time.
const lock = join(tmpdir(), `smithers-commit-${createHash("sha256").update(root).digest("hex")}.lock`)
try { mkdirSync(lock) } catch (error) {
  if (error.code === "EEXIST") throw new Error(`Another commit is running. If it crashed, remove ${lock} after checking its process.`)
  throw error
}
let releaseLanding
// A push publishes everything origin's main lacks, each commit on its own.
const jjReviews = (tip) => {
  const published = 'remote_bookmarks(exact:"main", exact:"origin")'
  const base = run("jj", ["log", "--ignore-working-copy", "-r", published, "--no-graph", "-T", "commit_id"], true)
  return requireReviews(root, base ? `(::${tip} ~ ::${published}) ~ empty()` : `::${tip} ~ empty()`, { base: base || null, override: noReviewNeeded })
}
const remoteMain = "refs/remotes/origin/main"
const gitPaths = (withWorkingTree) => {
  const has = (ref) => spawnSync("git", ["rev-parse", "--verify", "--quiet", ref], { cwd: root }).status === 0
  const names = (...argv) => run("git", ["-c", "core.quotepath=off", ...argv], true).split("\n").filter(Boolean)
  const onRemote = has(remoteMain), head = has("HEAD")
  return [
    ...(head ? names("log", "-m", "--format=", "--name-only", "--no-renames", onRemote ? `${remoteMain}..HEAD` : "HEAD") : []),
    ...(withWorkingTree && head ? names("diff", "--name-only", "--no-renames", "HEAD") : []),
    ...(withWorkingTree ? names("ls-files", "--others", "--exclude-standard") : [])
  ]
}
// Read the stored jj commit; the legacy adapter stages into a private index.
const snapshot = () => {
  if (existsSync(join(root, ".jj"))) return run("jj", ["log", "--ignore-working-copy", "-r", "@", "--no-graph", "-T", "commit_id"], true)
  const directory = mkdtempSync(join(tmpdir(), "smithers-commit-tree-"))
  try {
    const index = join(directory, "index")
    const real = join(run("git", ["rev-parse", "--absolute-git-dir"], true), "index")
    if (existsSync(real)) copyFileSync(real, index)
    const environment = { ...process.env, GIT_INDEX_FILE: index }
    run("git", ["add", "--all"], true, environment)
    return run("git", ["write-tree"], true, environment)
  } finally { rmSync(directory, { recursive: true, force: true }) }
}
// A push publishes only the tree its tests, gates and typecheck saw; an edit since then refuses it.
const sameAsValidated = (validated, now) => existsSync(join(root, ".jj"))
  ? !run("jj", ["diff", "--ignore-working-copy", "--from", validated, "--to", now, "--name-only"], true)
  : validated === now
const assertValidated = (validated, now) => {
  if (validated !== undefined && !sameAsValidated(validated, now)) throw new Error("The checkout changed after its checks ran; nothing pushed. Rerun the push.")
}
let validated

const gitReviews = (withWorkingTree) => {
  const onRemote = spawnSync("git", ["rev-parse", "--verify", "--quiet", remoteMain], { cwd: root }).status === 0
  const list = onRemote && spawnSync("git", ["cat-file", "-e", `${remoteMain}:${requiredPathsFile}`], { cwd: root }).status === 0 ? run("git", ["show", `${remoteMain}:${requiredPathsFile}`], true) : undefined
  return requireReviewsGit(gitPaths(withWorkingTree), list, noReviewNeeded)
}

try {
  // The full gate holds neither a queue ticket nor a lease. Only its receipt
  // and the existing bounded checks belong inside the FIFO lease.
  let affectedReceipt, affectedGate
  if (push) {
    requireEngineeringGateHome(process.env)
    affectedReceipt = await runAffectedGate(root)
  }
  releaseLanding = await acquireLock(process.env.SMITHERS_LAND_LOCK ?? join(homedir(), "smithers-builders/main-push.lock"))
  const gateEnvironment = engineeringGateEnvironment(process.env)
  // A home credential store cannot be hidden by changing HOME: absolute reads
  // remain possible. Refuse execution until the invoking checkout is isolated.
  if (push) requireEngineeringGateHome(process.env)
  if (push) {
    if (existsSync(join(root, ".jj"))) run("jj", ["status"], true)
    validated = snapshot()
    affectedGate = await requireAffectedReceipt(root, affectedReceipt, { head: validated })
    if (existsSync(join(root, ".jj")) && run("jj", ["log", "--ignore-working-copy", "-r", 'remote_bookmarks(exact:"main", exact:"origin") ~ ::@', "--no-graph", "-T", "commit_id"], true)) throw new Error("Remote main is not an ancestor of the publication candidate; sync explicitly before publishing")
  }
  for (const command of tests) {
    const result = spawnSync("bash", ["-o", "pipefail", "-c", command], { cwd: root, stdio: "inherit", env: gateEnvironment })
    if (result.error || result.status !== 0) throw new Error(`Test command failed: ${command} (${result.error?.message ?? result.status})`)
  }
  run(process.execPath, ["packages/repo-targets/contracts/check-tracked-hygiene.mjs", "--include-untracked"], true, gateEnvironment)
  if (push) {
    const result = spawnSync("smthrs", ["lint", "//:driftCi", "//:targetIndex", "//:ci", "//packages/repo-targets:trackedHygiene", "//packages/repo-targets:conflictMarkers"], {
      cwd: root, stdio: "inherit", env: gateEnvironment
    })
    if (result.error || result.status !== 0) throw new Error(`Mandatory drift gates failed (${result.error?.message ?? result.status})`)
    // Validation runs under the same lease as publication.
    const published = 'remote_bookmarks(exact:"main", exact:"origin")'
    await typecheckApp(root, existsSync(join(root, ".jj")) ? {
      touched: () => run("jj", ["log", "-r", `(::@ ~ ::${published}) & files("apps/mvp")`, "--no-graph", "-T", "commit_id"], true) !== "",
      source: snapshot
    } : {
      touched: () => gitPaths(true).some((path) => path.startsWith("apps/mvp/")),
      source: snapshot
    })
  }
  releaseLanding.check()
  if (existsSync(join(root, ".jj"))) {
    // Refuse before moving main; the check after the commit, on immutable main, is the one that counts.
    if (push) {
      assertValidated(validated, snapshot())
      jjReviews("@")
    }
    const eligible = run("jj", ["log", "-r", "main & (@ | @-)", "--no-graph", "-T", "commit_id"], true)
    if (!eligible) throw new Error("The shared checkout must be on main or its working-copy child.")
    if (run("jj", ["log", "-r", "@ & conflicts()", "--no-graph", "-T", "commit_id"], true)) throw new Error("Resolve conflicts before committing.")
    if (run("jj", ["diff", "--summary"], true)) {
      run("jj", ["commit", "-m", message])
      run("jj", ["bookmark", "set", "main", "-r", "@-"])
    } else console.log("No uncommitted changes.")
    if (push) {
      const sha = run("jj", ["log", "-r", "main", "--no-graph", "-T", "commit_id"], true)
      assertValidated(validated, sha)
      // From this check to the push nothing snapshots, so a later edit cannot join what was checked.
      logLanding(root, sha, { ...jjReviews(sha), gate: affectedGate })
      if (run("jj", ["log", "--ignore-working-copy", "-r", "main", "--no-graph", "-T", "commit_id"], true) !== sha) throw new Error("main moved after the review gate; nothing pushed")
      await releaseLanding.push("jj", ["git", "push", "--remote", "origin", "-b", "main", "--ignore-working-copy"], { cwd: root, stream: true })
      run("jj", ["git", "fetch", "--remote", "origin"])
      if (!run("jj", ["log", "-r", `${sha} & ::main@origin`, "--no-graph", "-T", "commit_id"], true)) throw new Error("remote main moved; pushed commit is absent")
      console.log(`LANDED ${sha}`)
    }
    console.log(`main: ${run("jj", ["log", "-r", "main", "--no-graph", "-T", "commit_id"], true)}`)
  } else {
    if (run("git", ["branch", "--show-current"], true) !== "main") throw new Error("The shared checkout must be on main.")
    if (push) {
      assertValidated(validated, snapshot())
      gitReviews(true)
    }
    if (run("git", ["ls-files", "--unmerged"], true)) throw new Error("Resolve conflicts before committing.")
    if (run("git", ["status", "--porcelain"], true)) {
      run("git", ["add", "--all"])
      run("git", ["commit", "-m", message])
    } else console.log("No uncommitted changes.")
    if (push) {
      const sha = run("git", ["rev-parse", "main"], true)
      assertValidated(validated, run("git", ["rev-parse", "main^{tree}"], true))
      logLanding(root, sha, { ...gitReviews(false), gate: affectedGate })
      await releaseLanding.push("git", ["push", "origin", "main"], { cwd: root, stream: true })
      run("git", ["fetch", "origin", "+refs/heads/main:refs/remotes/origin/main"])
      try {
        run("git", ["merge-base", "--is-ancestor", sha, "refs/remotes/origin/main"], true)
      } catch (error) {
        throw new Error(`remote main moved or ancestry verification failed: ${error.message}`)
      }
      console.log(`LANDED ${sha}`)
    }
    console.log(`main: ${run("git", ["rev-parse", "main"], true)}`)
  }
} catch (error) {
  console.error(`${push ? "NOT LANDED: " : ""}${error.message}`)
  process.exitCode = 1
} finally {
  await releaseLanding?.()
  rmSync(lock, { recursive: true, force: true })
}

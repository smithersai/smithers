import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"

import {
  ciGatesMissingFromInventory,
  commandCovers,
  gateRuns,
  parseGateCommand,
  releaseGateArgs,
  releaseGateCommand,
  releaseGateExceptions,
  releaseGateResultsFile,
  releaseGateSetForHost,
  releaseGateExclusions,
  releaseGates,
  staleExclusions,
  workflowGateSteps,
  workflowJobs
} from "./release-gates.mjs"
import { repoRoot } from "../../../packages/repo-targets/scripts/workspace-packages.mjs"
import { parse, stringify } from "yaml"

const workflow = (name) => readFileSync(join(repoRoot, ".github", "workflows", name), "utf8")
const release = workflow("release.yml")
const ci = workflow("ci.yml")

// Mutate parsed copies only. Every job exercises the real parity entry point;
// no workflow file or command outcome is replaced on disk.
const parityJobs = [["test", ci], ["repository", ci], ["apps-e2e", ci]]
const metadataSteps = parse(release).jobs.publish.steps
  .filter(step => ["Validate release tag", "Compute the publish plan"].includes(step.name))
const withRun = (source, job, name, run) => {
  const copy = parse(source)
  copy.jobs[job].steps.push({ name, run })
  return stringify(copy)
}
// Insert by the parsed step name, then exercise both accepted scalar styles.
// Quoting a generated job id or step name must not make a mutation vacuous.
const withStepBefore = (source, job, anchor, step, style) => {
  const copy = parse(source)
  const steps = copy.jobs[job].steps
  const matches = steps.flatMap((entry, index) => entry.name === anchor ? [index] : [])
  assert.equal(matches.length, 1, job + " mutation anchor exists exactly once")
  steps.splice(matches[0], 0, step)
  return stringify(copy, { defaultKeyType: style, defaultStringType: style })
}
const missingFor = (job, source) => ciGatesMissingFromInventory(releaseGates, source, releaseGateExclusions)
const reported = (job, name, command) => [{ job, name, command }]

// Direct invocations expose all nine discovery gaps in the old pnpm-prefix
// regex, including whitespace forms its previous pnpm-only tests already saw.
const bypassForms = [
  ["quoted executable", "'smthrs' test '//unlisted:required' --verbose"],
  ["quoted verb", "smthrs 'test' '//unlisted:required' --verbose"],
  ["escaped letters", "sm\\thrs test '//unlisted:required' --verbose"],
  ["tab", "smthrs\ttest '//unlisted:required' --verbose"],
  ["doubled spaces", "smthrs  test '//unlisted:required' --verbose"],
  ["backslash-newline", "sm\\\nthrs test '//unlisted:required' --verbose"],
  ["bash -c", "bash -c \"smthrs test '//unlisted:required' --verbose\""],
  ["env", "env MODE=ci smthrs test '//unlisted:required' --verbose"],
  ["$VAR", "TOOL=smthrs\n\"$TOOL\" test '//unlisted:required' --verbose"]
]

for (const [job, source] of parityJobs) {
  for (const [form, command] of bypassForms) {
    test(`fail-closed ${job}: ${form} is an unowned gate`, () => {
      const name = "Unlisted required gate"
      const segment = form === "$VAR" ? command.slice(command.indexOf("\n") + 1) : command
      assert.deepEqual(missingFor(job, withRun(source, job, name, command)), reported(job, name, segment))
    })
  }

  test(`fail-closed ${job}: the reviewer's pnpm word quoting and escapes are discovered`, () => {
    for (const prefix of ["pnpm exec 'smthrs'", 'pnpm "exec" smthrs', "pnpm ex\\ec smthrs"]) {
      const command = `${prefix} test '//unlisted:required' --verbose`
      assert.deepEqual(missingFor(job, withRun(source, job, "Unlisted", command)), reported(job, "Unlisted", command))
    }
  })

  test(`fail-closed ${job}: literal tokens, separators and comments preserve canonical coverage`, () => {
    const gate = releaseGates.find(gate => gate.name === "TUI end-to-end suite")
    for (const command of [
      "'pnpm' \"exec\" 'smthrs' \"test\" \"//apps/tui:e2eTests\" --verbose",
      "pnpm ex\\ec sm\\thrs te's't '//apps/tui:e2eTests' --verbose",
      "pnpm\texec  smthrs test //apps/tui:e2eTests --verbose",
      "pnpm exec \"sm\\\nthrs\" test '//apps/tui:e2eTests' --verbose",
      "pnpm exec smthrs test '//apps/tui:e2eTests' \\\n--verbose"
    ]) {
      for (const separator of [" && ", "; ", " | ", "\n"]) {
        const run = `printf '%s' 'a; b && c | # literal'${separator}${command} # ignored smthrs\n# comment`
        const added = withRun(source, job, gate.name, run)
        assert.deepEqual(missingFor(job, added), [], run)
        assert.deepEqual(workflowGateSteps(added, job).at(-1), { name: gate.name, command })
      }
    }
  })

  test(`fail-closed ${job}: wrappers and legacy names cannot inherit a canonical gate's ownership`, () => {
    const gate = releaseGates.find(gate => gate.name === "TUI end-to-end suite")
    const canonical = releaseGateCommand(gate)
    for (const command of [
      ...["env", "time", "nice", "xargs"].map(wrapper => `${wrapper} ${canonical}`),
      `bash -c "${canonical}"`, `sh -c "${canonical}"`,
      canonical.replace("smthrs", '"smithers-build"'),
      canonical.replace("smthrs", "smithers-\\build"),
      `${canonical} --unknown`, `${canonical} ''`, `${canonical} > gate.log`,
      canonical.replace("e2eTests", "e2eTests; other"),
      canonical.replace("e2eTests", "e2eTests#other"),
      canonical.replace("e2eTests", "e2eTests\\\n"),
      canonical.replace("'//apps/tui:e2eTests'", '"//apps/tui:e2eTests\\q"'),
      `${canonical}"`, `${canonical}\\`
    ]) assert.deepEqual(missingFor(job, withRun(source, job, gate.name, command)), reported(job, gate.name, command), command)
  })

  test(`fail-closed ${job}: unrelated expansions and eval do not taint literal gates`, () => {
    const gate = releaseGates.find(gate => gate.name === "TUI end-to-end suite")
    const canonical = releaseGateCommand(gate)
    for (const command of [
      `${canonical}\nprintf '%s' "$VAR"`, `${canonical}\nprintf '%s' "${"${VAR}"}"`,
      `${canonical}\nprintf '%s' "$(printf value)"`, `${canonical}\nprintf '%s' \`printf value\``,
      `${canonical}\neval ':'`, `${canonical}\n'eval' ':'`, `${canonical}\ne\\val ':'`,
      "# smthrs may be invoked dynamically\n$VAR"
    ]) assert.deepEqual(missingFor(job, withRun(source, job, gate.name, command)), [], command)
  })

  // CI and release steps record structured results for the check receipts (#3663).
  // Only that one generated path joins a canonical gate; any other path or
  // expansion in the option leaves the step unowned.
  test(`fail-closed ${job}: only the generated results file joins a canonical gate`, () => {
    const gate = releaseGates.find(gate => gate.name === "TUI end-to-end suite")
    const canonical = releaseGateCommand(gate)
    const recorded = canonical.replace(" --verbose", ' --results-file "$RUNNER_TEMP/smthrs-results/$GITHUB_ACTION.json" --verbose')
    assert.deepEqual(missingFor(job, withRun(source, job, gate.name, recorded)), [])
    for (const option of ['--results-file "$OTHER/results.json"', '--results-file "$(printf x)"', "--results-file results.json"]) {
      const command = canonical.replace(" --verbose", ` ${option} --verbose`)
      assert.deepEqual(missingFor(job, withRun(source, job, gate.name, command)), reported(job, gate.name, command), command)
    }
  })

  test(`fail-closed ${job}: dynamic gate segments and assignment indirection are unowned`, () => {
    for (const command of [
      "pnpm exec smthrs $VERB '//x'", "pnpm exec smthrs ${VERB} '//x'",
      "pnpm exec smthrs $(printf test) '//x'", "pnpm exec smthrs `printf test` '//x'",
      "eval 'smthrs test //unlisted:required'"
    ]) assert.deepEqual(missingFor(job, withRun(source, job, "Dynamic", command)), reported(job, "Dynamic", command))
    for (const [assignment, command] of [
      ["S=smthrs", "pnpm exec $S ci '//x'"],
      ["TOOL='smthrs'", "${TOOL} test '//unlisted:required' --verbose"],
      ["SMTHRS=smthrs", "$SMTHRS ci '//x'"],
      ["export S=smithers-build", "env MODE=ci pnpm exec \"$S\" ci '//x'"],
      ["S='pnpm exec smthrs'", "bash -c \"$S ci '//x'\""],
      ["S=smthrs", "eval '$S ci //x'"]
    ]) {
      const run = `${assignment}; ${command}`
      assert.deepEqual(missingFor(job, withRun(source, job, "Indirect", run)), reported(job, "Indirect", command), run)
    }
    // The specified path regex also matches the complete assignment token.
    // Both that literal candidate and its indirect invocation are unowned.
    const assignment = "SMTHRS=./node_modules/.bin/smthrs"
    const command = "$SMTHRS ci '//x'"
    assert.deepEqual(missingFor(job, withRun(source, job, "Indirect path", `${assignment}; ${command}`)), [
      ...reported(job, "Indirect path", assignment), ...reported(job, "Indirect path", command)
    ])
  })

  test(`fail-closed ${job}: gate paths and recursively quoted wrappers remain candidates`, () => {
    for (const prefix of [
      "./smthrs", "/usr/local/bin/smthrs", "node_modules/.bin/smithers-build",
      "sudo exec env time nice xargs smthrs"
    ]) {
      const command = `${prefix} ci '//x'`
      assert.deepEqual(missingFor(job, withRun(source, job, "Wrapped", command)), reported(job, "Wrapped", command))
    }
    for (const wrapper of ["env", "time", "nice", "xargs", "sudo", "bash", "sh", "zsh", "eval", "exec"]) {
      const command = `${wrapper} -c 'bash -c "pnpm exec smthrs ci //x"'`
      assert.deepEqual(missingFor(job, withRun(source, job, "Nested", command)), reported(job, "Nested", command))
    }
  })

  test(`fail-closed ${job}: longer words, node strings and comments are not candidates`, () => {
    for (const command of [
      "node -p 'pkg.smthrs?.group'", "node -p '\"npm install smthrs\"'",
      "pnpm exec node scripts/example.mjs @smthrs/cli smthrs-extra",
      "# npm install smthrs\nprintf '%s' \"$VERSION\"",
      "VERSION=1 # smthrs $VERB\nprintf '%s' \"$VERSION\"",
      "S=@smthrs/cli; pnpm exec $S ci '//x'",
      "S='pkg.smthrs?.group'; $S", "S=unrelated; $S", "S=smthrs; printf '%s' \"$S\""
    ]) assert.deepEqual(missingFor(job, withRun(source, job, "Metadata", command)), [], command)
  })

  test(`fail-closed ${job}: script runners stay out of scope until they mention a gate`, () => {
    for (const command of ["node scripts/build-release.mjs", "pnpm exec node scripts/build-release.mjs", "pnpm exec scripts/example.mjs"]) {
      assert.deepEqual(missingFor(job, withRun(source, job, "Script runner", command)), [])
      const gateCommand = `${command} smthrs`
      assert.deepEqual(missingFor(job, withRun(source, job, "Script runner", gateCommand)), reported(job, "Script runner", gateCommand))
    }
  })
}

test("CI requires an explicit canonical command even inside a recursive inventory selection", () => {
  for (const job of ["test", "repository", "apps-e2e", "browser", "rust"]) {
    const command = "pnpm exec smthrs test '//scripts:newRequiredGate' --verbose"
    assert.deepEqual(missingFor(job, withRun(ci, job, "Unlisted", command)), reported(job, "Unlisted", command))
  }
})

test("release metadata and planning blocks contain no gate candidates", () => {
  assert.equal(metadataSteps.length, 2)
  for (const step of metadataSteps) {
    const source = stringify({ jobs: { publish: { steps: [step] } } })
    assert.deepEqual(workflowGateSteps(source, "publish"), [], step.name)
  }
})

test("all nine reviewer cases execute the same Bash argv and fail parity", () => {
  for (const prefix of ["pnpm exec 'smthrs'", 'pnpm "exec" smthrs', "pnpm ex\\ec smthrs"]) {
    const command = `${prefix} test '//unlisted:required' --verbose`
    const execution = spawnSync("/bin/bash", ["--noprofile", "--norc", "-c",
      `pnpm() { node -e 'console.log(JSON.stringify(process.argv.slice(1)))' -- "$@"; };\n${command}`
    ], { encoding: "utf8" })
    assert.equal(execution.status, 0, execution.stderr)
    assert.deepEqual(JSON.parse(execution.stdout), ["exec", "smthrs", "test", "//unlisted:required", "--verbose"])
    for (const [job, source] of parityJobs) {
      const mutated = withRun(source, job, "Reviewer bypass", command)
      assert.equal(workflowGateSteps(mutated, job).length, workflowGateSteps(source, job).length + 1)
      assert.deepEqual(missingFor(job, mutated), reported(job, "Reviewer bypass", command))
    }
  }
})

test("CI exclusions cannot hide wrappers, expansions or new commands", () => {
  for (const job of ["packages"]) {
    for (const command of [
      "pnpm exec smthrs test '//unlisted:required' --verbose",
      "env pnpm exec smthrs test '//unlisted:required' --verbose",
      "TOOL=smthrs\n$TOOL test '//unlisted:required' --verbose"
    ]) assert.deepEqual(missingFor(job, withRun(ci, job, "Unlisted", command)), reported(job, "Unlisted", command.split("\n").at(-1)))
  }
})

test("exclusion drift checks use literal tokens and reject dynamic gates", () => {
  const gate = releaseGates.find(gate => gate.name === "TUI end-to-end suite")
  const canonical = releaseGateCommand(gate)
  const command = canonical.replace("smthrs", '"smthrs"')
  const source = stringify({ jobs: { test: { steps: [{ name: gate.name, run: command }] } } })
  assert.deepEqual(staleExclusions([], source, [{ job: "test", commands: [canonical], reason: "test-only exclusion" }]), [])
  assert.deepEqual(ciGatesMissingFromInventory([], source, [{ job: "test", commands: [canonical], reason: "test-only exclusion" }]), [])
  const dynamic = stringify({ jobs: { test: { steps: [{ name: gate.name, run: `${canonical} $VAR` }] } } })
  assert.equal(ciGatesMissingFromInventory([], dynamic, [{ job: "test", reason: "whole job" }]).length, 1)
})

/** Pin every job so a new one forces a release decision. `on.push` is a trigger, not a job. */
const ciJobs = ["test", ...Array.from({ length: 8 }, (_, index) => `test-${index + 2}`), "repository", "scripts", "docs", "apps-e2e", "rust", "rust-ffi", "wasm-repro", "browser", "packages", ...Array.from({ length: 8 }, (_, index) => `packages-${index + 2}`)]

/** A copy of the release workflow with one more step ahead of the build. */
const withUnlistedStep = (source, name, command) => {
  const anchor = "      - name: Build all workspaces from clean artifacts"
  assert.ok(source.includes(anchor))
  return source.replace(anchor, `      - name: ${name}\n        run: ${command}\n${anchor}`)
}

test("the inventory names the exclusive fault matrix, serial, and the WASM byte-compare", () => {
  // These are the two gates ordinary `ci '//packages/...'` never runs and the
  // root release flow used to omit. Pinning them here means a future edit to
  // the inventory cannot drop them without failing this case.
  assert.deepEqual(releaseGates.filter((gate) => gate.target === "//packages/...:faults").map(releaseGateArgs), [
    ["test", "//packages/...:faults", "--jobs", "1", "--verbose"]
  ])
  assert.deepEqual(releaseGates.filter((gate) => gate.target === "//packages/smithers/flows/jj-wasm:wasmReproducibility").map(releaseGateArgs), [
    ["test", "//packages/smithers/flows/jj-wasm:wasmReproducibility", "--verbose"]
  ])
  const names = releaseGates.map((gate) => gate.name)
  assert.deepEqual(names, [...new Set(names)], "gate names are unique")
  const commands = releaseGates.map(releaseGateCommand)
  assert.deepEqual(commands, [...new Set(commands)], "gate commands are unique, so each CI command maps to one gate")
  for (const gate of releaseGates) assert.ok(["ci", "test", "lint", "build"].includes(gate.verb), `${gate.name} uses a supported verb`)
})

/** The publish job's steps, parsed. */
const publishSteps = parse(release).jobs.publish.steps

test("release.yml runs the gates through one release/gates step and copies none", () => {
  // The workflow used to copy every inventory gate as its own step, and a
  // parity test kept the copy honest. Now one step starts the flow that runs
  // the inventory, so there is no copy to drift.
  const gates = publishSteps.filter((step) => typeof step.run === "string" && step.run.includes("smthrs flow start release/gates"))
  assert.equal(gates.length, 1, "exactly one publish step starts release/gates")
  const [step] = gates
  assert.equal(step.name, "Release gates")
  assert.equal(step.if, "${{ !cancelled() && steps.setup.conclusion == 'success' }}")
  assert.equal(step.run.trim(), `pnpm exec smthrs flow start release/gates --data "$(jq -cn --arg directory "$RUNNER_TEMP/smthrs-results" '{resultsDirectory: $directory}')" --wait`)
  assert.deepEqual(Object.keys(step.env).sort(), ["MSYS2_ARG_CONV_EXCL", "SMITHERS_CACHE_NAMESPACE", "SMITHERS_CACHE_READ_TOKEN", "SMITHERS_CACHE_URL"])
  // No `smthrs <verb> //...` gate remains anywhere in the publish job.
  assert.deepEqual(workflowGateSteps(release, "publish"), [])
  // The gates run on the pinned Node, with the fault matrix's microVM ready,
  // and before the candidate build.
  const at = (name) => publishSteps.findIndex((entry) => entry.name === name)
  const gate = at("Release gates")
  for (const before of ["Select the repository's pinned Node", "Prepare the fault matrix microVM", "Release changelog section"]) {
    assert.ok(at(before) >= 0 && at(before) < gate, `${before} precedes the gates`)
  }
  assert.ok(at("Build all workspaces from clean artifacts") > gate, "the gates precede the candidate build")
  assert.equal(publishSteps[at("Select the repository's pinned Node")].with["node-version-file"], ".node-version")
})

test("a gate copied back into the publish job is discovered, in every run form", () => {
  const command = "pnpm exec smthrs test '//scripts:unlisted' --verbose"
  for (const run of [command, `|\n          ${command}`, `>\n          pnpm exec smthrs test\n          '//scripts:unlisted' --verbose`]) {
    assert.deepEqual(workflowGateSteps(withUnlistedStep(release, "Unlisted gate", run), "publish"), [{ name: "Unlisted gate", command }])
  }
  const copied = releaseGates.find((gate) => gate.name === "Exclusive fault matrix")
  assert.deepEqual(workflowGateSteps(withUnlistedStep(release, copied.name, releaseGateCommand(copied)), "publish"), [
    { name: copied.name, command: releaseGateCommand(copied) }
  ])
  const unnamed = `jobs:\n  publish:\n    steps:\n      - run: ${command}\n`
  assert.deepEqual(workflowGateSteps(unnamed, "publish"), [{ name: "", command }])
  // A flow step that names a gate target is still a gate, not a flow start.
  const smuggled = `pnpm exec smthrs flow start release/gates --wait && ${command}`
  assert.deepEqual(workflowGateSteps(withUnlistedStep(release, "Smuggled", smuggled), "publish"), [{ name: "Smuggled", command }])
})

test("the inventory keeps the gates the review found missing", () => {
  // The inventory once held 12 entries, and a flow-driven release approved a
  // candidate with far less evidence than a tag-driven one. These are the
  // gates that review named, so the fix cannot regress quietly.
  for (const target of [
    "//apps/tui:e2eTests", "//.smithers/flows/review/...", "//apps/bug-worker/...", "//apps/maintainer-site/...",
    "//:projectCopy", "//packages/smithers/agent/regression:test", "//packages/smithers/agent/regression:check", "//evals/authoring:test",
    "//evals/authoring:check", "//packages/smithers/agent/harness/benchmarks/swebench:offline", "//packages/smithers/agent/harness/benchmarks/swebench:check", "//.smithers/flows/review/seeded-bugs/...",
    "//.smithers/flows/review/seeded-bugs:check", "//:ci", "//:factoryProjection",
    "//:targetIndex", "//packages/smithers/flows/engine-store:disasterRecovery", "//packages/smithers/flows/jj-wasm:buildScript",
    "//packages/smithers/flows/jj-wasm:wasmReproducibility", "//.smithers/flows:issueClaim", "//.smithers/flows:releaseRehearsal"
  ]) assert.ok(releaseGates.some((gate) => gate.target === target), `${target} is an inventory gate`)
  assert.ok(releaseGates.length >= 50, `${releaseGates.length} gates is too few to be the release`)
})

test("each gate writes its own results file, named for the gate", () => {
  const files = releaseGates.map((gate) => releaseGateResultsFile("/results", gate))
  assert.deepEqual(files, [...new Set(files)], "results files are unique")
  for (const file of files) assert.match(file, /^\/results\/[a-z0-9]+(?:-[a-z0-9]+)*\.json$/)
  assert.equal(
    releaseGateResultsFile("/results", { name: "Agent eval suite (offline, baseline-gated)" }),
    "/results/agent-eval-suite-offline-baseline-gated.json"
  )
  const serial = releaseGates.find((gate) => gate.target === "//packages/...:faults")
  assert.deepEqual(releaseGateArgs(serial, { resultsFile: "/results/x.json" }), ["test", "//packages/...:faults", "--jobs", "1", "--results-file", "/results/x.json", "--verbose"])
  assert.deepEqual(releaseGateArgs(serial), ["test", "//packages/...:faults", "--jobs", "1", "--verbose"])
})





// These shell spellings must remain visible even when they are not canonical
// inventory commands. Use a target outside recursive inventory selections so
// CI must report the unlisted gate even if command parsing later normalizes it.
for (const [spelling, prefix] of [
  ["double spaces", "pnpm  exec smthrs"],
  ["tabs", "pnpm\texec\tsmthrs"],
  ["continued before exec", "pnpm " + "\\" + "\n  exec smthrs"],
  ["continued before smthrs", "pnpm exec " + "\\" + "\n  smthrs"],
  ["continued command word", "pnpm exec sm" + "\\" + "\nthrs"],
  ["legacy executable whitespace", "pnpm  exec smithers-build"]
]) {
  for (const [job, source, anchor] of [
    ["repository", ci, "Target index drift"],
    ["apps-e2e", ci, "TUI end-to-end suite"]
  ]) {
    test(`${job} parity reports an unlisted gate with ${spelling}`, () => {
      const command = `${prefix} test '//unlisted:required' --verbose`
      const name = "Unlisted required gate"
      for (const style of ["PLAIN", "QUOTE_DOUBLE"]) {
        const added = withStepBefore(source, job, anchor, { name, run: command }, style)
        const steps = workflowGateSteps(added, job)
        assert.equal(steps.length, workflowGateSteps(source, job).length + 1, "every added command is discovered")
        const missing = ciGatesMissingFromInventory(releaseGates, added, releaseGateExclusions)
        assert.deepEqual(missing, [{ job, name, command }],
          style + ": the unlisted command fails parity closed with its full spelling")
      }
    })
  }
}

test("continued commands retain quoted whitespace and comments cannot hide the next gate", () => {
  const command = "pnpm exec smthrs test '//unlisted:" + "\\" + "\nrequired' --verbose"
  const source = `jobs:\n  publish:\n    steps:\n      - name: Quoted continuation\n        run: |\n${command.split("\n").map(line => `          ${line}`).join("\n")}\n`
  assert.deepEqual(workflowGateSteps(source, "publish"), [{ name: "Quoted continuation", command }])
  const gate = releaseGates[0]
  const commented = withUnlistedStep(release, "After comment", `|\n          # a comment ending in ${"\\"}\n          ${releaseGateCommand(gate)}`)
  assert.deepEqual(workflowGateSteps(commented, "publish"), [{ name: "After comment", command: releaseGateCommand(gate) }])
})

test("the root flows' own targets are release gates no CI job runs", () => {
  // The release gates the root flows' sources itself. If ci.yml ever gains a
  // flows job, the CI direction below covers these gates as it does the rest.
  const own = ["//.smithers/flows:check", "//.smithers/flows:suite"]
  for (const target of own) {
    assert.ok(releaseGates.some((gate) => gate.verb === "ci" && gate.target === target), `${target} is a release gate`)
    assert.equal(ci.includes(`'${target}'`), false, `${target} is now a CI gate; move its comment in release-gates.mjs`)
  }
})

test("the release proves every CI gate the exclusions do not name, and every exclusion still describes ci.yml", () => {
  // Release is a superset of CI: each ci.yml job is mirrored gate by gate,
  // covered by a recursive inventory selection, or named in the exclusions
  // with a reason.
  assert.deepEqual(workflowJobs(ci), ciJobs)
  assert.deepEqual(ciGatesMissingFromInventory(releaseGates, ci, releaseGateExclusions), [], "these CI gates run in neither the release nor the exclusions")
  assert.deepEqual(staleExclusions(releaseGates, ci, releaseGateExclusions), [])
  assert.deepEqual(releaseGateExclusions.map((exclusion) => exclusion.job), ["rust", "packages", ...Array.from({ length: 8 }, (_, index) => `packages-${index + 2}`), "browser"])
  for (const exclusion of releaseGateExclusions) assert.ok(exclusion.reason.length > 40, `${exclusion.job} carries a reason`)
  // Partial exclusions name only what the release omits: the rest of the job is mirrored.
  assert.deepEqual(releaseGateExclusions.find((exclusion) => exclusion.job === "rust").commands, [
    "pnpm exec smthrs lint '//packages/smithers/flows/jj-wasm/...' --verbose",
    "pnpm exec smthrs test '//packages/smithers/flows/jj-wasm:cargoTest' --verbose",
    "pnpm exec smthrs test '//packages/smithers/flows/jj:thirdPartyNotices' --verbose"
  ])
  for (const job of ["repository", "scripts", "docs", "wasm-repro"]) {
    for (const step of workflowGateSteps(ci, job)) {
      assert.ok(releaseGates.some((gate) => gate.name === step.name && releaseGateCommand(gate) === step.command), `${job}: ${step.name} is an inventory gate by name and command`)
    }
  }
})

test("a CI gate added outside the exclusions is reported, and an exclusion that names a mirrored gate or a missing job is stale", () => {
  const command = "pnpm exec smthrs test '//evals/new:suite' --verbose"
  for (const style of ["PLAIN", "QUOTE_DOUBLE"]) {
    const added = withStepBefore(ci, "repository", "Target index drift", { name: "New eval suite", run: command }, style)
    assert.equal(workflowGateSteps(added, "repository").length, workflowGateSteps(ci, "repository").length + 1)
    assert.deepEqual(ciGatesMissingFromInventory(releaseGates, added, releaseGateExclusions),
      [{ job: "repository", name: "New eval suite", command }], style + ": an unlisted gate must fail parity")
    assert.deepEqual(ciGatesMissingFromInventory(releaseGates, added,
      [...releaseGateExclusions, { job: "repository", commands: [command], reason: "declared" }]), [])
  }
  // Dropping an inventory gate a mirrored CI job carries is a CI gap too.
  const mutated = releaseGates.filter((gate) => gate.target !== "//packages/smithers/flows/jj-wasm:buildScript")
  assert.deepEqual(ciGatesMissingFromInventory(mutated, ci, releaseGateExclusions).map((step) => step.command), ["pnpm exec smthrs test '//packages/smithers/flows/jj-wasm:buildScript' --verbose"])
  const workspaceCommand = workflowGateSteps(ci, "test")[0].command
  assert.deepEqual(staleExclusions(releaseGates, ci, [{ job: "test", commands: [workspaceCommand], reason: "stale" }]), [
    `test excludes ${workspaceCommand}, which the inventory runs`
  ])
  assert.deepEqual(staleExclusions(releaseGates, ci, [{ job: "rust-ffi", reason: "whole job" }]), [
    "rust-ffi excludes pnpm exec smthrs build '//:nativeFfi' --verbose, which the inventory runs"
  ])
  assert.deepEqual(staleExclusions(releaseGates, ci, [{ job: "gone", reason: "stale" }]), ["gone is not a ci.yml job"])
  assert.deepEqual(staleExclusions(releaseGates, ci, [{ job: "rust", commands: [command], reason: "stale" }]), [`rust does not run ${command}`])
})

test("workflowGateSteps reads names and commands, quoted names included, and skips non-gate steps", () => {
  const source = [
    "name: x", "on: push", "jobs:", "  publish:", "    steps:",
    "      - uses: actions/checkout@sha",
    "      - name: Install", "        run: pnpm install",
    "      # a comment", "",
    "      - name: \"Agent eval suite (offline, baseline-gated)\"", "        run: pnpm exec smthrs test '//packages/smithers/agent/regression:test' --verbose",
    "        env:", "          SMITHERS_CACHE_URL: x",
    "      - name: Build", "        run: node scripts/build-release.mjs",
    "      - name: Serial", "        run: pnpm exec smthrs test '//packages/...:faults' --jobs 1 --verbose",
    "  other:", "    steps:", "      - name: Elsewhere", "        run: pnpm exec smthrs lint '//:ci' --verbose", ""
  ].join("\n")
  assert.deepEqual(workflowJobs(source), ["publish", "other"])
  assert.deepEqual(workflowGateSteps(source, "publish"), [
    { name: "Agent eval suite (offline, baseline-gated)", command: "pnpm exec smthrs test '//packages/smithers/agent/regression:test' --verbose" },
    { name: "Serial", command: "pnpm exec smthrs test '//packages/...:faults' --jobs 1 --verbose" }
  ])
  assert.deepEqual(workflowGateSteps(source, "other"), [{ name: "Elsewhere", command: "pnpm exec smthrs lint '//:ci' --verbose" }])
  assert.throws(() => workflowGateSteps(source, "missing"), /missing is not a job/)
  assert.deepEqual(parseGateCommand("pnpm exec smthrs build '//evals/authoring:check' --verbose"), { verb: "build", target: "//evals/authoring:check" })
  assert.deepEqual(parseGateCommand("pnpm exec smthrs ci '//packages/...' --jobs 2 --verbose"), { verb: "ci", target: "//packages/...", jobs: 2 })
  assert.deepEqual(parseGateCommand("pnpm exec smthrs ci '//packages/a' '//packages/b' --jobs 2 --verbose"), {
    verb: "ci", target: "//packages/a", additionalTargets: ["//packages/b"], jobs: 2
  })
  assert.equal(parseGateCommand("pnpm exec smthrs ci //packages/... --verbose"), undefined)
  // The known-red list changes which red targets fail a step, not which run.
  assert.deepEqual(
    parseGateCommand("pnpm exec smthrs ci '//packages/...' --jobs 2 --known-red '.github/ci-known-red.json' --verbose"),
    { verb: "ci", target: "//packages/...", jobs: 2 }
  )
})

test("commandCovers matches exact targets, recursive selections and job bounds only", () => {
  const gate = { name: "x", verb: "test", target: "//scripts:releaseCut" }
  assert.equal(commandCovers("pnpm exec smthrs test '//scripts:releaseCut' --verbose", gate), true)
  assert.equal(commandCovers("pnpm exec smthrs test '//scripts/...' --verbose", gate), true)
  assert.equal(commandCovers("pnpm exec smthrs test '//script/...' --verbose", gate), false)
  assert.equal(commandCovers("pnpm exec smthrs ci '//scripts/...' --verbose", gate), false)
  const serial = { name: "y", verb: "test", target: "//packages/...:faults", jobs: 1 }
  assert.equal(commandCovers("pnpm exec smthrs test '//packages/...:faults' --jobs 1 --verbose", serial), true)
  assert.equal(commandCovers("pnpm exec smthrs test '//packages/...:faults' --verbose", serial), false)
  assert.equal(commandCovers("pnpm exec smthrs test '//packages/...:faults' --jobs 2 --verbose", serial), false)
  assert.equal(commandCovers("pnpm exec smthrs test '//packages/...' --jobs 1 --verbose", serial), false)
  const lint = { name: "z", verb: "lint", target: "//:ci" }
  assert.equal(commandCovers("pnpm exec smthrs lint '//:ci' --verbose", lint), true)
  assert.equal(commandCovers("pnpm exec smthrs test '//:ci' --verbose", lint), false)
  const typecheck = { name: "w", verb: "build", target: "//packages/smithers/agent/regression:check" }
  assert.equal(commandCovers("pnpm exec smthrs build '//packages/smithers/agent/regression:check' --verbose", typecheck), true)
  assert.equal(commandCovers("pnpm exec smthrs build '//packages/smithers/agent/...' --verbose", typecheck), true)
  // A bounded command covers no unbounded gate: the bound is a different claim.
  assert.equal(commandCovers("pnpm exec smthrs test '//packages/...' --jobs 2 --verbose", { name: "v", verb: "test", target: "//packages/smithers:test" }), false)
  // gateRuns is the same relation read from the inventory side.
  const scripts = { name: "Script gates", verb: "test", target: "//scripts/..." }
  assert.equal(gateRuns(scripts, "pnpm exec smthrs test '//scripts:issueClaim' --verbose"), true)
  assert.equal(gateRuns(scripts, "pnpm exec smthrs test '//packages/repo-targets:webBundleContract' --verbose"), false)
  assert.equal(gateRuns(scripts, "pnpm exec smthrs lint '//scripts:lint' --verbose"), false)
  assert.equal(gateRuns(scripts, "not a gate"), false)
  assert.equal(commandCovers("pnpm exec smthrs test '//other' '//scripts:issueClaim' --verbose", { ...scripts, target: "//scripts:issueClaim" }), true)
  assert.equal(gateRuns(scripts, "pnpm exec smthrs test '//scripts:a' '//scripts:b' --verbose"), true)
  assert.equal(gateRuns(scripts, "pnpm exec smthrs test '//scripts:a' '//outside:b' --verbose"), false)
  assert.equal(gateRuns(scripts, "pnpm exec smthrs test '//scripts:a' '//scripts:b' --jobs 2 --verbose"), false)
})



test("each host partitions every gate into exactly one run or justified exception", () => {
  const canonical = releaseGateSetForHost({ platform: "linux", arch: "x64" })
  assert.deepEqual(canonical.inventory, releaseGates)
  assert.deepEqual(canonical.exceptions, [])
  for (const host of [{ platform: "darwin", arch: "arm64" }, { platform: "linux", arch: "arm64" }, { platform: "win32", arch: "x64" }]) {
    const local = releaseGateSetForHost(host)
    assert.equal(local.inventory.length, releaseGates.length - 1)
    assert.deepEqual(local.exceptions, releaseGateExceptions)
    assert.equal(local.exceptions[0].name, "Rebuild and byte-compare flows_jj.wasm")
    assert.match(local.exceptions[0].reason, /x86_64-unknown-linux-gnu/)
    // Every gate is run or excepted, never both: the exception is the gate's own command.
    assert.deepEqual(
      [...local.inventory.map((gate) => gate.name), ...local.exceptions.map((exception) => exception.name)].sort(),
      releaseGates.map((gate) => gate.name).sort()
    )
    for (const exception of local.exceptions) {
      assert.ok(releaseGates.some((gate) => gate.name === exception.name && releaseGateCommand(gate) === exception.command))
    }
  }
})

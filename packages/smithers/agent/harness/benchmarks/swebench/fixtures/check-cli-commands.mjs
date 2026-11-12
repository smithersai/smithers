/**
 * Asserts the rig drives the CLI through its canonical commands.
 *
 *   node fixtures/check-cli-commands.mjs           offline: how the CLI routes each call
 *   node fixtures/check-cli-commands.mjs --real    the calls themselves, through the built CLI
 *
 * `run-instance.sh` and `readonly-liveness.sh` plan, approve and execute a
 * flow through `flows.sh`, which hands its arguments to this checkout's CLI
 * unchanged. Until 2026-11 they used the root `plan`, `approve` and
 * `run <payload>` spellings. Those still worked only because
 * `packages/smithers/src/cli/Compatibility.ts` routes them to the legacy entry
 * point, an alias layer marked for removal; root `run` is otherwise the
 * build-target runner. The day the aliases go, every flows arm stops after
 * provisioning its testbed.
 *
 * The offline half reads every `flows.sh` call out of both scripts as text and
 * feeds its argument vector to the CLI's own alias router. A call the router
 * would rewrite is refused.
 *
 * `--real` runs the calls `run-instance.sh` makes, in order, through `flows.sh`
 * against the built CLI and the fix flow `lib/write-flow.mjs` writes. With no
 * model key exported, execution must stop at the model boundary. It needs the
 * build `./preflight.sh` makes, so it runs in the `:prerequisites` target.
 *
 * Spends nothing, needs no docker.
 *
 * @since 1.0.0
 */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { agentArguments, legacyArguments } from "../../../../../src/cli/Compatibility.ts"

const rig = resolve(import.meta.dirname, "..")
const placeholder = "<approval>"

/** Every `flows.sh` call in a script: its argument vector, with `"$A"` as a placeholder. */
const calls = (name) =>
  [...readFileSync(join(rig, name), "utf8").matchAll(/"\$S\/flows\.sh"((?:[ \t]+(?!\||>|2>|&&|\|\|)\S+)+)/g)].map((
    match
  ) => match[1].trim().split(/\s+/).map((word) => word === "\"$A\"" ? placeholder : word))

const scripts = { "run-instance.sh": calls("run-instance.sh"), "readonly-liveness.sh": calls("readonly-liveness.sh") }
for (const [name, found] of Object.entries(scripts)) {
  assert.equal(found.length, 3, `${name} plans, approves and executes: ${JSON.stringify(found)}`)
  for (const argv of found) {
    const routed = legacyArguments(argv) ?? agentArguments(argv)
    assert.equal(
      routed,
      undefined,
      `${name}: \`flows.sh ${argv.join(" ")}\` goes through the CLI's transition aliases; use the canonical command`
    )
  }
}
const [plan, approve, execute] = scripts["run-instance.sh"]
assert.deepEqual(plan.slice(0, 3), ["--json", "flow", "plan"])
assert.deepEqual(approve.slice(0, 4), ["--json", "approvals", "approve", placeholder])
assert.deepEqual(execute, ["--json", "flow", "execute", placeholder])

if (process.argv[2] === "--real") {
  const temporary = mkdtempSync(join(tmpdir(), "swebench-cli-commands-"))
  try {
    const dataset = join(temporary, "dataset.json")
    writeFileSync(
      dataset,
      JSON.stringify([{
        instance_id: "django__django-1",
        repo: "django/django",
        version: "4.1",
        base_commit: "abc123",
        problem_statement: "Fix the redirect."
      }])
    )
    const work = join(temporary, "work")
    mkdirSync(join(work, ".smithers/flows/fix"), { recursive: true })
    const seat = "openai:gpt-6-sol"
    const flow = spawnSync(
      process.execPath,
      [join(rig, "lib/write-flow.mjs"), dataset, "django__django-1", seat, "test-container", "pytest"],
      { encoding: "utf8" }
    )
    assert.equal(flow.status, 0, flow.stderr)
    writeFileSync(join(work, ".smithers/flows/fix/flow.mdx"), flow.stdout)

    const env = { ...process.env, SWB_SUBJECT_UNPINNED: "1" }
    delete env.OPENAI_API_KEY
    delete env.SMITHERS_OPENAI_AUTH
    const cli = (argv, approval) =>
      spawnSync("bash", [join(rig, "flows.sh"), ...argv.map((word) => word === placeholder ? approval : word)], {
        cwd: work,
        encoding: "utf8",
        env,
        timeout: 300_000
      })

    const planned = cli(plan)
    assert.equal(planned.status, 0, planned.stderr)
    const approval = JSON.stringify(JSON.parse(planned.stdout).approval)
    assert.match(approval, /"_tag":"Plan"/, "flow plan returns the approval payload")
    const approved = cli(approve, approval)
    assert.equal(approved.status, 0, approved.stderr)
    assert.equal(JSON.parse(approved.stdout)._tag, "Accepted")
    const executed = cli(execute, approval)
    const refusal = `${executed.stdout}${executed.stderr}`
    assert.notEqual(executed.status, 0, "no key is exported, so the run cannot reach a model")
    assert.ok(
      refusal.includes(`Set OPENAI_API_KEY to run the ${seat} seat`),
      `flow execute reaches the model boundary:\n${refusal}`
    )
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

console.log(
  `check-cli-commands.mjs: ${Object.values(scripts).flat().length} flows.sh calls use canonical commands${
    process.argv[2] === "--real" ? ", and reach the model boundary" : ""
  }.`
)

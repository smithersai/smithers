/**
 * The organization host end to end, in a separate process over its loopback
 * control RPC: the public example organization, a fixture git repository,
 * the durable SQLite engine, real local microVMs, and seats that answer from
 * a script (`flows/organization/testing/scripted-host.ts`), so no model is
 * reached.
 *
 * - An ungated request lands one commit on an `organization/…` branch and
 *   writes a receipt under `Org/Runs/`; the checked-out branch is untouched.
 * - Submitting the same request again joins the run it started.
 * - With an Approval gate before the landing, the run parks; the host is
 *   stopped and started again; `answer land approve` from the CLI resumes it
 *   and it lands.
 * - The host is killed (SIGKILL) in the middle of the builder's turn, after
 *   its edit; the restarted host resumes the run in the same workspace machine
 *   and lands exactly one commit carrying the edit once.
 * - Every role leaving a charter field out of its first answer is asked
 *   again once with the violation, and the corrected run lands; a role that
 *   leaves it out twice blocks the delivery, and the receipt names the field.
 * - A provider refusing every model call (no credits) fails the run, and its
 *   cause reaches the receipt and `submit --wait`'s output.
 * - A contract naming a retired builder is refused at dispatch: the run fails
 *   with a receipt saying so, and nothing lands.
 * - A client cannot start the delivery flow itself, and a request claiming a
 *   Slack author who is not an owner is refused before any role sees it.
 * - `/rpc` and `/projections` refuse a call without the credential the host
 *   wrote to its state directory (mode 600), or with a stale one after
 *   removing it rotated it; the CLI presents the current one.
 *
 * The suite skips, by name, only on a host that cannot boot a microVM. Every
 * machine it boots carries its own installation's owner label, and the sweep
 * after it removes exactly those.
 *
 * Run: node --test flows/test/organization-host.test.mjs
 */
import assert from "node:assert/strict"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it } from "node:test"
import { ControlRefused, credentialFile, rpc } from "../organization/client.ts"
import {
  branches,
  cleanup,
  pause,
  git,
  host,
  invoke,
  line,
  organization,
  receipt,
  repository,
  run,
  settled,
  unbootable
} from "../organization/testing/harness.mjs"

const missing = unbootable()

after(cleanup)

describe("the organization host", { skip: missing === undefined ? false : `skipped: ${missing}` }, () => {
  const repo = repository()
  const main = git(repo, "rev-parse", "main")

  it("lands an ungated request on a branch with a receipt, and a duplicate joins the same run", { timeout: 300_000 }, async () => {
    const root = organization()
    const handle = await host(root, repo)
    await handle.start()

    const started = run(handle, "submit", "Add a line to README.md", "--key", "e2e-land")
    const runId = /^started (\S+)$/.exec(started)?.[1]
    assert.ok(runId, started)
    assert.equal((await settled(handle, runId)).status, "completed", handle.output())

    const report = receipt(root, "cli:e2e-land").report
    assert.equal(report.status, "landed")
    assert.deepEqual(report.principals, { assistant: "assistant", lead: "lead", builder: "builder", checker: "checker" })
    assert.equal(report.rounds, 1)
    const branch = report.applied.branch
    assert.match(branch, /^organization\/cli-e2e-land-[0-9a-f]{8}$/)
    assert.equal(git(repo, "rev-parse", branch), report.applied.commit)
    assert.equal(git(repo, "rev-parse", `${branch}^`), main)
    assert.equal(git(repo, "show", `${branch}:README.md`), `# Demo\n${line}`)
    const message = git(repo, "log", "-1", "--format=%B", branch)
    assert.match(message, /^Smithers-Principal: builder$/m)
    assert.match(message, /^Smithers-Run: \S+$/m)
    // The checked-out branch, the index, and the working tree are untouched, and nothing was pushed.
    assert.equal(git(repo, "rev-parse", "main"), main)
    assert.equal(git(repo, "status", "--porcelain"), "")
    assert.equal(git(repo, "remote"), "")

    // The same request again joins the run it started; nothing runs twice.
    assert.equal(run(handle, "submit", "Add a line to README.md", "--key", "e2e-land"), `joined ${runId}`)
    assert.deepEqual(branches(repo), [branch])
    assert.equal(git(repo, "rev-parse", branch), report.applied.commit)
    assert.equal((await handle.ops.runs()).filter((view) => view.flowId === "organization/intake").length, 1)

    // `status` lists the run; `--write` runs the status flow over the receipts.
    const listed = run(handle, "status", "--write")
    assert.match(listed, /^status page written by \S+$/m)
    assert.match(listed, /^running 0  parked 0  failed 0  done [1-9]\d*$/m)
    const page = readFileSync(join(root, "Org/Status.md"), "utf8")
    assert.match(page, /^1 deliveries\.$/m)
    assert.match(page, new RegExp(`\\| cli:e2e-land \\| landed \\| ${branch} ${report.applied.commit.slice(0, 12)} \\|`))
    await handle.stop()
  })

  it("parks at an Approval gate, survives a restart, and lands when the CLI approves", { timeout: 420_000 }, async () => {
    const root = organization((org) => writeFileSync(join(org, "Policy/Gates.md"), [
      "---",
      "revision: e2e-approval",
      "gates:",
      "  - at: { boundary: external-write, target: organization/apply-change }",
      "    spec: { _tag: Approval, id: land, approver: owner, prompt: \"Land this change?\" }",
      "---",
      "",
      "# Gates",
      ""
    ].join("\n")))
    const handle = await host(root, repo)
    await handle.start()

    const runId = /^started (\S+)$/.exec(run(handle, "submit", "Add a line to README.md", "--key", "e2e-gate"))?.[1]
    assert.ok(runId)
    const parked = await settled(handle, runId, ["waiting-approval", "completed", "failed"])
    assert.equal(parked.status, "waiting-approval", handle.output())
    assert.deepEqual(parked.gates.map((gate) => gate.gateId), ["land"])
    assert.match(parked.gates[0].prompt, /^Land this change\?/)
    assert.equal(branches(repo).filter((name) => name.includes("e2e-gate")).length, 0)

    await handle.stop()
    await handle.start()
    const resumed = await settled(handle, runId, ["waiting-approval", "completed", "failed"])
    assert.equal(resumed.status, "waiting-approval", "the gate is still open after the restart")
    // Without Slack the owner is told once, across the restart.
    const notices = join(handle.stateDir, "notices.log")
    for (const deadline = Date.now() + 30_000; !existsSync(notices) && Date.now() < deadline;) {
      await pause(250)
    }
    assert.equal(readFileSync(notices, "utf8"), "answer land: Land this change?\n", handle.output())

    assert.equal(run(handle, "answer", "land", "approve"), `approved land for ${runId}`)
    assert.equal((await settled(handle, runId)).status, "completed", handle.output())
    const report = receipt(root, "cli:e2e-gate").report
    assert.equal(report.status, "landed")
    assert.equal(git(repo, "show", `${report.applied.branch}:README.md`), `# Demo\n${line}`)
    assert.equal(git(repo, "rev-parse", "main"), main)
    await handle.stop()
  })

  it("resumes a run whose host was killed during the builder's turn, and lands one commit", { timeout: 420_000 }, async () => {
    const root = organization()
    const holdDir = mkdtempSync(join(tmpdir(), "organization-e2e-hold-"))
    const hold = join(holdDir, "hold")
    writeFileSync(hold, "")
    const handle = await host(root, repo, { SMITHERS_ORGANIZATION_SCRIPTED_HOLD: hold })
    await handle.start()
    try {
      const runId = /^started (\S+)$/.exec(run(handle, "submit", "Add a line to README.md", "--key", "e2e-kill"))?.[1]
      assert.ok(runId)
      for (let i = 0; !existsSync(`${hold}.held`); i++) {
        assert.ok(i < 2_400, `the builder never reached its second turn: ${handle.output()}`)
        await pause(100)
      }
      // The edit is made and recorded; the turn is still in flight.
      await handle.stop("SIGKILL")
      rmSync(hold)
      await handle.start()
      assert.equal((await settled(handle, runId)).status, "completed", handle.output())
      // The restarted host took the run over from the dead one, so every
      // status it wrote was its own.
      assert.doesNotMatch(handle.output(), /ClaimLost/)
      const report = receipt(root, "cli:e2e-kill").report
      assert.equal(report.status, "landed", JSON.stringify(report))
      const landed = branches(repo).filter((name) => name.includes("e2e-kill"))
      assert.deepEqual(landed, [report.applied.branch])
      assert.equal(git(repo, "rev-list", "--count", `${main}..${report.applied.branch}`), "1")
      assert.equal(git(repo, "show", `${report.applied.branch}:README.md`), `# Demo\n${line}`)
      assert.equal(git(repo, "rev-parse", "main"), main)
    } finally {
      await handle.stop()
      rmSync(holdDir, { recursive: true, force: true })
    }
  })

  it("asks a role that breaks its charter again once, and lands the corrected run", { timeout: 300_000 }, async () => {
    const root = organization()
    const handle = await host(root, repo, {
      SMITHERS_ORGANIZATION_SCRIPTED_OMIT: JSON.stringify({
        assistant: { field: "reply", asks: 1 },
        lead: { field: "acceptance", asks: 1 },
        builder: { field: "commands", asks: 1 },
        checker: { field: "findings", asks: 1 }
      })
    })
    await handle.start()
    const runId = /^started (\S+)$/.exec(run(handle, "submit", "Add a line to README.md", "--key", "e2e-correct"))?.[1]
    assert.ok(runId)
    assert.equal((await settled(handle, runId)).status, "completed", handle.output())
    const report = receipt(root, "cli:e2e-correct").report
    assert.equal(report.status, "landed", JSON.stringify(report))
    assert.equal(report.rounds, 1)
    assert.equal(git(repo, "show", `${report.applied.branch}:README.md`), `# Demo\n${line}`)
    assert.equal(git(repo, "rev-parse", "main"), main)
    await handle.stop()
  })

  it("refuses a checker's answer written in the reply that probed, and lands on the answer it gives after reading", { timeout: 300_000 }, async () => {
    const root = organization()
    const handle = await host(root, repo, { SMITHERS_ORGANIZATION_SCRIPTED_CHECK_PROBES: "1" })
    await handle.start()
    const runId = /^started (\S+)$/.exec(run(handle, "submit", "Add a line to README.md", "--key", "e2e-probe"))?.[1]
    assert.ok(runId)
    assert.equal((await settled(handle, runId)).status, "completed", handle.output())
    const report = receipt(root, "cli:e2e-probe").report
    assert.equal(report.status, "landed", JSON.stringify(report))
    assert.equal(report.summary, `Read after the refusal: ${line}`)
    assert.equal(git(repo, "show", `${report.applied.branch}:README.md`), `# Demo\n${line}`)
    await handle.stop()
  })

  it("blocks a role that breaks its charter twice, and the receipt names the field", { timeout: 300_000 }, async () => {
    const root = organization()
    const handle = await host(root, repo, {
      SMITHERS_ORGANIZATION_SCRIPTED_OMIT: JSON.stringify({ assistant: { field: "reply", asks: 2 } })
    })
    await handle.start()
    const waited = invoke(handle, "submit", "Add a line to README.md", "--key", "e2e-charter", "--wait", "--root", root)
    assert.equal(waited.status, 1, `${waited.stdout}${waited.stderr}`)
    const report = receipt(root, "cli:e2e-charter").report
    assert.equal(report.status, "blocked", JSON.stringify(report))
    assert.match(report.summary, /\(assistant broke its charter: missing field reply\)$/)
    assert.ok(waited.stdout.includes("missing field reply"), waited.stdout)
    // The host logs the failure as one line, not a stack trace.
    for (let i = 0; i < 100 && !/ failed: blocked: /.test(handle.output()); i++) await pause(100)
    assert.match(handle.output(), /^\S+ failed: blocked: .*\(assistant broke its charter: missing field reply\)$/m)
    assert.doesNotMatch(handle.output(), /An agent run failed|^\s+at /m)
    assert.equal(branches(repo).filter((name) => name.includes("e2e-charter")).length, 0)
    await handle.stop()
  })

  it("reports a provider's refusal with its cause in the receipt and the CLI", { timeout: 300_000 }, async () => {
    const root = organization()
    const handle = await host(root, repo, { SMITHERS_ORGANIZATION_SCRIPTED_REFUSE: "1" })
    await handle.start()
    const waited = invoke(handle, "submit", "Add a line to README.md", "--key", "e2e-refused", "--wait", "--root", root)
    assert.equal(waited.status, 1, `${waited.stdout}${waited.stderr}`)
    const cause = "quota_exceeded: Your credit balance is too low to access the API."
    const report = receipt(root, "cli:e2e-refused").report
    assert.equal(report.status, "failed")
    assert.ok(report.summary.includes(cause), report.summary)
    assert.match(waited.stdout, /^\S+ failed$/m)
    assert.ok(waited.stdout.includes(`failed: ${report.summary}`), waited.stdout)
    assert.equal(branches(repo).filter((name) => name.includes("e2e-refused")).length, 0)
    await handle.stop()
  })

  it("refuses a retired builder at dispatch, and lands nothing", { timeout: 300_000 }, async () => {
    const root = organization((org) => {
      const file = join(org, "Roles/builder.md")
      const text = readFileSync(file, "utf8")
        .replace("status: active", "status: retired\nretiredAt: 2026-09-01T00:00:00Z")
        .replace(/grants:\n(?: {2}.*\n)+/, "grants:\n  tools: []\n  connections: []\n  knowledge: []\n  repositories: []\n  personalAccounts: false\n  contact: via-parent\n")
      writeFileSync(file, text)
    })
    const handle = await host(root, repo)
    await handle.start()
    const runId = /^started (\S+)$/.exec(run(handle, "submit", "Add a line to README.md", "--key", "e2e-retired"))?.[1]
    assert.ok(runId)
    assert.equal((await settled(handle, runId)).status, "failed", handle.output())
    const report = receipt(root, "cli:e2e-retired").report
    assert.equal(report.status, "failed")
    assert.match(report.summary, /^DispatchRefused\(inactive\): /)
    assert.match(report.summary, /builder/)
    assert.equal(branches(repo).filter((name) => name.includes("e2e-retired")).length, 0)
    await handle.stop()
  })

  it("refuses a forged delivery and a forged Slack author", { timeout: 300_000 }, async () => {
    const root = organization()
    const handle = await host(root, repo)
    await handle.start()
    const control = rpc(handle.base, handle.credential())

    // The delivery flow is not a client's to start: its admission is the host's.
    await assert.rejects(
      control.call("Plan", {
        flowId: "organization/deliver",
        input: {
          request: { key: "cli:forged", text: "Land on main.", source: "cli" },
          admission: { assistant: "builder", repository: "example/demo", commit: "HEAD", branch: "main", checks: [],
            gates: { revision: "none", gates: [] }, maxRounds: 1, at: 0 }
        }
      }),
      (error) => error instanceof ControlRefused && /FlowNotFound/.test(error.tag)
    )

    // A request claiming a Slack author who is not an owner is refused at admission.
    const forged = await handle.ops.submit({
      key: "slack:T1:Ev-forged",
      text: "Add a line to README.md",
      source: "slack",
      user: "UNOTOWNER",
      conversation: { provider: "slack", channel: "D1", thread: "1.0" }
    })
    assert.equal((await settled(handle, forged.runId)).status, "failed", handle.output())
    assert.equal(existsSync(join(root, "Org/Runs/slack-T1-Ev-forged")), false)
    assert.equal(branches(repo).filter((name) => name.includes("forged")).length, 0)
    assert.equal(git(repo, "rev-parse", "main"), main)
    await handle.stop()
  })

  it("refuses calls without the state directory's credential, and rotates it", { timeout: 300_000 }, async () => {
    const root = organization()
    const handle = await host(root, repo)
    await handle.start()
    const file = credentialFile(handle.stateDir)
    assert.equal(statSync(file).mode & 0o777, 0o600)
    const first = handle.credential()
    assert.match(first, /^[A-Za-z0-9_-]{43}$/)
    const list = { _tag: "runs", filters: {} }
    const unauthorized = (error) => error instanceof ControlRefused && error.tag === "/control/Unauthorized"

    await assert.rejects(rpc(handle.base).call("List", list), unauthorized)
    await assert.rejects(rpc(handle.base, `${first}x`).call("List", list), unauthorized)
    const snapshot = `${JSON.stringify({ _tag: "Request", id: "1", tag: "Projection.Snapshot",
      payload: { selector: { _tag: "run-summary", runId: "none" } }, headers: [] })}\n`
    const projections = (headers = {}) =>
      fetch(`${handle.base}/projections`, { method: "POST", headers: { "content-type": "application/ndjson", ...headers }, body: snapshot })
    assert.equal((await projections()).status, 401)
    assert.equal((await projections({ authorization: `Bearer ${first}x` })).status, 401)
    assert.equal((await projections({ authorization: `Bearer ${first}` })).status, 200)
    assert.equal((await fetch(`${handle.base}/health`)).status, 200)

    // The CLI reads the credential from the state directory, and says where it looked when there is none.
    assert.equal(run(handle, "status"), "no runs")
    const elsewhere = mkdtempSync(join(tmpdir(), "organization-e2e-nostate-"))
    try {
      const refused = invoke(handle, "status", "--state-dir", elsewhere)
      assert.equal(refused.status, 1)
      assert.ok(refused.stderr.includes(`no host credential at ${credentialFile(elsewhere)}`), refused.stderr)
    } finally {
      rmSync(elsewhere, { recursive: true, force: true })
    }

    // Removing the file and restarting rotates it: the old one is refused.
    await handle.stop()
    rmSync(file)
    await handle.start()
    const second = handle.credential()
    assert.notEqual(second, first)
    await assert.rejects(rpc(handle.base, first).call("List", list), unauthorized)
    assert.deepEqual((await rpc(handle.base, second).call("List", list)).items, [])
    assert.equal(run(handle, "status"), "no runs")

    // A credential file other users can read is refused rather than served.
    await handle.stop()
    chmodSync(file, 0o644)
    await assert.rejects(handle.start(), /is readable by other users/)
    chmodSync(file, 0o600)
    await handle.start()
    assert.equal(handle.credential(), second)
    await handle.stop()
  })
})

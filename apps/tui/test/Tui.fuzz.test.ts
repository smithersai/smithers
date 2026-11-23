import type { ControlSchema } from "@smthrs/control"
import { Fuzz } from "@smthrs/fuzz"
import { describe, expect, test } from "bun:test"
import { Arbitrary, Effect, Schema } from "effect"
import * as Activity from "../src/activity.ts"
import * as Approvals from "../src/approvals.ts"
import * as Budget from "../src/budget.ts"
import * as CellDisplay from "../src/cell-display.ts"
import * as Changes from "../src/changes.ts"
import * as Cli from "../src/cli.ts"
import * as Complete from "../src/complete.ts"
import * as Composer from "../src/composer.ts"
import * as Contributions from "../src/contributions.ts"
import * as Credit from "../src/credit.ts"
import * as Deadline from "../src/deadline.ts"
import * as Editor from "../src/editor.ts"
import * as Extension from "../src/extension.ts"
import * as Fuzzy from "../src/fuzzy.ts"
import * as Graph from "../src/graph.ts"
import * as Keys from "../src/keys.ts"
import * as Lifecycle from "../src/lifecycle.ts"
import type { Model } from "../src/models.ts"
import * as Palette from "../src/palette.ts"
import * as Panels from "../src/panels.ts"
import * as Reads from "../src/reads.ts"
import * as RunCard from "../src/run-card.ts"
import * as RuntimeVersion from "../src/runtime-version.ts"
import * as Scrubber from "../src/scrubber.ts"
import * as Search from "../src/search.ts"
import * as ShellOutput from "../src/shell-output.ts"
import * as Shell from "../src/shell.ts"
import * as Subagents from "../src/subagents.ts"
import * as Summary from "../src/summary.ts"
import * as Tabs from "../src/tabs.ts"
import * as Theme from "../src/theme.ts"
import * as Timeline from "../src/timeline.ts"
import * as Toasts from "../src/toasts.ts"
import * as Transcript from "../src/transcript.ts"
import * as Tree from "../src/tree.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "1000" : "300"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")

const runFuzz = async <A>(arb: Arbitrary.Arbitrary<A>, prop: (value: A) => boolean, offset: number) => {
  const report = await Effect.runPromise(
    Fuzz.run(arb, (v) => Effect.sync(() => prop(v)), { seed: seed + offset, executions })
  )
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

describe("apps/tui pure module fuzz invariants", () => {
  test("Fuzzy.score & Fuzzy.filter preserve subsequence soundness, exact-match -100, non-mutation, and multi-token conjunction", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        query: Schema.String.pipe(Schema.check(Schema.isMaxLength(16))),
        items: Schema.Array(Schema.String.pipe(Schema.check(Schema.isMaxLength(24)))).pipe(
          Schema.check(Schema.isMaxLength(16))
        )
      })
    )
    await runFuzz(arb, ({ query, items }) => {
      const snapshot = [...items]
      const filtered = Fuzzy.filter(items, query, (s) => s)
      if (items.length !== snapshot.length || items.some((v, i) => v !== snapshot[i])) return false
      if (query.length > 0 && Fuzzy.score(query, query) !== -100) return false
      const tokens = query.trim().split(/\s+/).filter((t) => t.length > 0)
      if (tokens.length === 0) {
        return filtered.length === items.length && filtered.every((v, i) => v === items[i])
      }
      for (const item of filtered) {
        for (const tok of tokens) {
          if (Fuzzy.score(tok, item) === undefined) return false
        }
      }
      const expectedCount = items.filter((it) => tokens.every((tok) => Fuzzy.score(tok, it) !== undefined)).length
      return filtered.length === expectedCount
    }, 0)
  })

  test("Composer.route & Shell.parse/tail/persisted uphold routing precedence, UTF-8 byte/line bounds, and excluded output stripping", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        prefix: Schema.Literals(["", "!", "!!", "/", "hello "]),
        body: Schema.String.pipe(Schema.check(Schema.isMaxLength(80))),
        steering: Schema.Boolean,
        lines: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 2100 })))
      })
    )
    await runFuzz(arb, ({ prefix, body, steering, lines }) => {
      const text = `${prefix}${body}`
      const r = Composer.route(text, steering)
      if (text.startsWith("!!")) {
        if (r._tag !== "shell" || !r.excluded) return false
      } else if (text.startsWith("!")) {
        if (r._tag !== "shell" || r.excluded) return false
      } else if (text.startsWith("/")) {
        if (r._tag !== "command") return false
      } else if (steering) {
        if (r._tag !== "steer") return false
      } else {
        if (r._tag !== "prompt") return false
      }

      const parsedShell = Shell.parse(text)
      if (text.startsWith("!!") && parsedShell !== undefined && !parsedShell.excluded) return false
      if (text.startsWith("!") && !text.startsWith("!!") && parsedShell !== undefined && parsedShell.excluded) {
        return false
      }

      const res: Shell.Result = {
        command: body,
        output: "secret-output",
        exitCode: 0,
        cancelled: false,
        fullOutputPath: "/tmp/secret.log"
      }
      const keptExcluded = Shell.persisted(res, true)
      if (keptExcluded.output !== "" || keptExcluded.fullOutputPath !== undefined) return false

      const big = lines > 0 ? "x\n".repeat(Math.min(lines, 2050)) : body
      const cut = Shell.tail(big)
      if (cut.text.split("\n").length > Shell.maxLines) return false
      if (Buffer.byteLength(cut.text, "utf8") > Shell.maxBytes) return false
      return true
    }, 1)
  })

  test("ShellOutput.redactor & clean: chunk-boundary-invariant secret redaction and idempotent ANSI/CRLF cleanup", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        secret: Schema.String.pipe(Schema.check(Schema.isMinLength(8), Schema.isMaxLength(24))),
        prefix: Schema.String.pipe(Schema.check(Schema.isMaxLength(24))),
        suffix: Schema.String.pipe(Schema.check(Schema.isMaxLength(24))),
        chunkSize: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 9 }))),
        ansiBody: Schema.String.pipe(Schema.check(Schema.isMaxLength(40))),
        esc: Schema.Literals(["\x1b[31m", "\x1b[1;32m", "\x1b]0;title\x07", "\x1b]8;;https://a.b\x1b\\", "\r\n", "\r"])
      })
    )
    await runFuzz(arb, ({ secret, prefix, suffix, chunkSize, ansiBody, esc }) => {
      const safeSecret = `sk_${secret.replace(/[^A-Za-z0-9]/g, "A").padEnd(10, "Z")}`
      const env = { OPENAI_API_KEY: safeSecret, NORMAL_VAR: "not-a-secret-123456" }
      const full = `${prefix}${safeSecret}${suffix}${safeSecret}`
      const whole = ShellOutput.redact(full, env)
      if (whole.includes(safeSecret)) return false
      if (!whole.includes("[redacted $OPENAI_API_KEY]")) return false

      // Streaming redaction across ANY chunk boundary MUST equal whole-string redaction and never leak the secret!
      const stream = ShellOutput.redactor(env)
      let streamed = ""
      for (let i = 0; i < full.length; i += chunkSize) {
        streamed += stream.write(full.slice(i, i + chunkSize))
      }
      streamed += stream.end()
      if (streamed !== whole || streamed.includes(safeSecret)) return false

      // clean strips ANSI/OSC/CSI sequences, normalizes \r\n and \r to \n, and is idempotent
      const dirty = `${esc}${ansiBody}\x1b[0m\r\nline2`
      const cleaned = ShellOutput.clean(dirty)
      if (cleaned.includes("\x1b") || cleaned.includes("\r")) return false
      if (ShellOutput.clean(cleaned) !== cleaned) return false

      const dec = ShellOutput.decoder()
      const utf8Buf = Buffer.from(dirty, "utf8")
      const splitAt = Math.min(chunkSize, utf8Buf.length)
      const decoded = dec.write(utf8Buf.subarray(0, splitAt)) + dec.write(utf8Buf.subarray(splitAt)) + dec.end()
      if (decoded.includes("\x1b") || decoded.includes("\r")) return false
      return true
    }, 2)
  })

  test("Budget.policy never throws on arbitrary env/flag inputs and rejects negative/non-numeric caps", async () => {
    const valArb = Schema.OptionFromUndefinedOr(
      Schema.Union([
        Schema.String.pipe(Schema.check(Schema.isMaxLength(24))),
        Schema.Literals(["0", "-5", "off", "unlimited", "1000000", "200M", "NaN", "1.5"])
      ])
    )
    const arb = Arbitrary.schema(
      Schema.Struct({
        envRun: valArb,
        envDaily: valArb,
        flagRun: valArb,
        flagDaily: valArb
      })
    )
    await runFuzz(arb, ({ envRun, envDaily, flagRun, flagDaily }) => {
      const p = Budget.policy(
        {
          [Budget.environmentKey]: envRun._tag === "Some" ? envRun.value : undefined,
          [Budget.dailyEnvironmentKey]: envDaily._tag === "Some" ? envDaily.value : undefined
        },
        {
          tokens: flagRun._tag === "Some" ? flagRun.value : undefined,
          daily: flagDaily._tag === "Some" ? flagDaily.value : undefined
        }
      )
      if (p === undefined) return true
      if ("error" in p) return typeof p.error === "string" && p.error.length > 0
      if (p.tokens !== undefined && (!Number.isInteger(p.tokens.max) || p.tokens.max <= 0)) return false
      if (p.daily !== undefined && (!Number.isInteger(p.daily.max) || p.daily.max <= 0)) return false
      return true
    }, 3)
  })

  test("Deadline.deadlineAt/label/row & RuntimeVersion.problem uphold newest-wins and semver ordering", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        deadlines: Schema.Array(
          Schema.NullOr(
            Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1_700_000_000_000, maximum: 1_900_000_000_000 })))
          )
        ).pipe(Schema.check(Schema.isMaxLength(6))),
        live: Schema.Boolean,
        major: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 3 }))),
        minor: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 10 }))),
        patch: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 10 })))
      })
    )
    await runFuzz(arb, ({ deadlines, live, major, minor, patch }) => {
      const events = deadlines.map((d, idx) => ({
        kind: d === null ? "control.step.started" : "control.run.started",
        payload: d === null ? {} : { run: { deadlineAt: d } },
        sequence: idx + 1
      })) as unknown as ReadonlyArray<ControlSchema.ControlEvent>
      const found = Deadline.deadlineAt(events)
      const expected = [...deadlines].reverse().find((d) => d !== null) ?? undefined
      if (found !== expected) return false
      const rows = Deadline.row(events, live, 1_750_000_000_000)
      if (rows.length !== (live && expected !== undefined ? 1 : 0)) return false

      const ver = `${major}.${minor}.${patch}`
      const prob = RuntimeVersion.problem({ bun: ver })
      const isOlder = major < 1 || (major === 1 && minor < 4)
      if ((prob !== undefined) !== isOlder) return false
      if (RuntimeVersion.problem({}) !== undefined) return false
      return true
    }, 4)
  })

  test("Editor.History, nearest, known, tokens & Complete.display/mention/rankFiles/complete/apply uphold invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        entries: Schema.Array(Schema.String.pipe(Schema.check(Schema.isMaxLength(24)))).pipe(
          Schema.check(Schema.isMaxLength(12))
        ),
        draft: Schema.String.pipe(Schema.check(Schema.isMaxLength(24))),
        cmdName: Schema.Union([
          Schema.String.pipe(Schema.check(Schema.isMaxLength(16))),
          Schema.Literals(["model", "modle", "sumary", "claude", "exit", "zzzzzz"])
        ]),
        tokenCount: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 50_000_000 }))),
        filePath: Schema.String.pipe(Schema.check(Schema.isMaxLength(40))),
        cursorOffset: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 40 })))
      })
    )
    await runFuzz(arb, ({ entries, draft, cmdName, tokenCount, filePath, cursorOffset }) => {
      const h = new Editor.History(entries)
      if (h.browsing) return false
      let steps = 0
      while (h.up(draft) !== undefined) {
        steps++
        if (steps > Editor.historyLimit) return false
      }
      if (steps > 0) {
        let last: string | undefined
        for (let i = 0; i < steps; i++) last = h.down()
        if (last !== draft || h.browsing) return false
        if (h.down() !== undefined) return false
      }

      const near = Editor.nearest(cmdName)
      if (near !== undefined && !Editor.commands.some((c) => c.name === near.name)) return false
      if (Editor.commands.some((c) => c.name === cmdName) && !Editor.known(cmdName)) return false
      const unk = Editor.unknown(cmdName)
      if (!unk.includes(`/${cmdName}`)) return false

      const tok = Editor.tokens(tokenCount)
      if (tokenCount < 1000 && tok !== String(tokenCount)) return false
      if (tokenCount >= 1_000_000 && !tok.endsWith("M")) return false

      const safePath = filePath.toWellFormed()
      const disp = Complete.display(safePath)
      if (/[\r\n\x00-\x1f\x7f]/.test(disp)) return false
      const ment = Complete.mention(safePath)
      if (!ment.startsWith("@") || !ment.endsWith(" ")) return false
      if (/[\r\n\x00-\x1f\x7f]/.test(ment)) return false

      const text = `/mod ${safePath}`
      const cur = Math.min(cursorOffset, text.length)
      const comp = Complete.complete(text, cur, {
        models: [{ seat: "openai:gpt-5", label: "GPT-5", provider: "openai" }],
        files: () => ["src/index.ts", "README.md", "apps/tui/src/fuzzy.ts"]
      })
      if (comp !== undefined) {
        if (comp.start < 0 || comp.end < comp.start || comp.end > text.length) return false
        if (comp.items.length > 0) {
          const applied = Complete.apply(text, comp, comp.items[0]!)
          if (applied.cursor < 0 || applied.cursor > applied.text.length) return false
        }
      }
      return true
    }, 5)
  })

  test("Cli.validBox/parse, Credit.make ledger, and Palette.parse/Search.parse uphold validation and safety invariants", async () => {
    const models: ReadonlyArray<Model> = [
      { id: "gpt-6.1-sol", label: "GPT-6.1 Sol", provider: "openai", seat: "openai:gpt-6.1-sol" } as unknown as Model,
      {
        id: "claude-opus-5-5",
        label: "Claude Opus",
        provider: "anthropic",
        seat: "anthropic:claude-opus-5-5"
      } as unknown as Model,
      { id: "qwen-3.8", label: "Qwen 3.8", provider: "openrouter", seat: "openrouter:qwen-3.8" } as unknown as Model
    ]
    const arb = Arbitrary.schema(
      Schema.Struct({
        boxRef: Schema.Union([
          Schema.String.pipe(Schema.check(Schema.isMaxLength(40))),
          Schema.Literals(["acme/app/ws-1", "bad/only-two", "a/b/c/d", "a b/c/d"])
        ]),
        cliArgs: Schema.Array(
          Schema.Literals([
            "--help",
            "--continue",
            "--resume",
            "--print",
            "hi",
            "",
            "--model",
            "--box",
            "bad",
            "--unknown-flag",
            "dir1",
            "dir2"
          ])
        ).pipe(Schema.check(Schema.isMaxLength(5))),
        spendSeat: Schema.Literals(["openai:gpt-6.1-sol", "anthropic:claude-opus-5-5", "auto"]),
        scope: Schema.Literals(["model", "account"]),
        paletteInput: Schema.Union([
          Schema.String.pipe(Schema.check(Schema.isMaxLength(40))),
          Schema.Literals(["?", "  ?  ", "/model", "text:hello", "text:/foo.*bar/", "conversation:abc", "tab:w1"])
        ]),
        searchLine: Schema.Union([
          Schema.String.pipe(Schema.check(Schema.isMaxLength(60))),
          Schema.Literals([
            JSON.stringify({
              type: "match",
              data: { path: { text: "./src/a.ts" }, line_number: 12, lines: { text: `${"x".repeat(300)}\n` } }
            }),
            JSON.stringify({ type: "match", data: { path: { bytes: "////" }, line_number: 1, lines: { text: "hi" } } }),
            JSON.stringify({ type: "begin", data: {} })
          ])
        ])
      })
    )
    await runFuzz(arb, ({ boxRef, cliArgs, spendSeat, scope, paletteInput, searchLine }) => {
      if (Cli.validBox(boxRef) && boxRef.split("/").length !== 3) return false
      const parsedCli = Cli.parse(cliArgs, "/tmp")
      if (!("help" in parsedCli || "error" in parsedCli || "cwd" in parsedCli)) return false

      const ledger = Credit.make(models, ["openai:gpt-6.1-sol", "anthropic:claude-opus-5-5"])
      ledger.answered("openrouter:qwen-3.8")
      ledger.spend(spendSeat, scope)
      if (spendSeat === "auto" && ledger.spent("auto")) return false
      if (spendSeat !== "auto" && !ledger.spent(spendSeat)) return false
      const sub = ledger.instead(spendSeat, "openrouter:qwen-3.8")
      if (sub !== undefined) {
        if (sub.to === "auto" || ledger.spent(sub.to)) return false
      }

      const pal = Palette.parse(paletteInput)
      if (paletteInput.trim() === "?" && pal.mode !== "help") return false
      if (paletteInput.trimStart().startsWith("/") && pal.mode !== "commands") return false

      const hit = Search.parse(searchLine)
      if (hit !== undefined) {
        if (hit.path.startsWith("./")) return false
        if (!Number.isInteger(hit.line)) return false
        if (hit.text.length > 200 || hit.text.endsWith("\n")) return false
      }
      return true
    }, 6)
  })

  test("Extension, Panels, Contributions.Store, Lifecycle & Keys enforce limits, collision checks, state transitions, and column fit", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        keyStr: Schema.Union([
          Schema.String.pipe(Schema.check(Schema.isMaxLength(20))),
          Schema.Literals(["a", "ctrl+a", "alt+z", "ctrl+shift+e", "shift+a", "bad+a", "ctrl+"])
        ]),
        ctx: Schema.Literals(["global", "panel"]),
        navKeys: Schema.Array(Schema.Literals(["j", "k", "up", "down", "d", "v", "enter", "space", "x"])).pipe(
          Schema.check(Schema.isMaxLength(12))
        ),
        rowCount: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 6 }))),
        status: Schema.Literals(Lifecycle.statuses),
        event: Schema.Literals(Lifecycle.events),
        full: Schema.Boolean,
        columns: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 140 }))),
        keyCtx: Schema.Literals(["global", "composer", "working", "panel", "picker", "form", "approval"])
      })
    )
    await runFuzz(arb, ({ keyStr, ctx, navKeys, rowCount, status, event, full, columns, keyCtx }) => {
      const prob = Extension.keyProblem(keyStr, ctx)
      if (ctx === "global" && prob === undefined && !keyStr.includes("ctrl+") && !keyStr.includes("alt+")) return false

      const rows: ReadonlyArray<Panels.Row> = Array.from({ length: rowCount }, (_, i) => ({
        id: `r${i}`,
        label: `Row ${i}`,
        details: []
      }))
      let nav = Panels.initial()
      for (const k of navKeys) {
        nav = Panels.navigate(nav, k, rows)
        if (rowCount === 0 && nav.selected !== 0) return false
        if (rowCount > 0 && (nav.selected < 0 || nav.selected >= rowCount)) return false
      }

      const map = new Map<string, Panels.Panel>()
      for (let i = 0; i < Panels.limit + 4; i++) {
        Panels.keep(map, { id: `p${i}`, title: `T${i}`, summary: `S${i}`, rows: [] })
      }
      if (map.size !== Panels.limit) return false

      const store = new Contributions.Store({ taken: (k) => (k === "ctrl+k" ? { label: "Palette" } : undefined) })
      let collided = false
      try {
        store.runtime("runtime:c1", {
          kind: "key",
          key: { id: "k1", key: "ctrl+k", label: "Steal", action: { kind: "open", surface: "chat" }, context: "global" }
        })
      } catch (err) {
        collided = err instanceof Contributions.Refusal && err.code === "collision"
      }
      if (!collided) return false

      const next = Lifecycle.step(status, event, full)
      if (event === "done" && next !== "done") return false
      if (event === "fail" && next !== "failed") return false
      if (event === "cancel" && next !== "cancelled") return false
      if (
        Lifecycle.settled(status) && (event === "launch" || event === "admit" || event === "block" || event === "park")
      ) {
        if (next !== undefined) return false
      }

      const hints = Keys.hintsFor(keyCtx)
      const fitted = Keys.fit(hints, columns)
      const totalWidth = fitted.reduce((sum, b, idx) => sum + (idx === 0 ? 0 : 2) + Keys.hintWidth(b), 0)
      if (fitted.length > 0 && totalWidth > columns) return false
      return true
    }, 7)
  })

  test("Approvals.readOnly/within/mode/hunk/arming & Reads.refusal enforce path confinement and shell read-only security boundaries", async () => {
    const cwd = "/tmp"
    const arb = Arbitrary.schema(
      Schema.Struct({
        dangerousShell: Schema.Literals([
          "rm -rf /",
          "ls | sh",
          "cat file > out",
          "cat $(whoami)",
          "cat `id`",
          "pwd && rm -f x",
          "git push origin main",
          "git commit -m hi",
          "cat ../../etc/passwd",
          "FOO=bar ls",
          "ls ; curl evil.test",
          "ls\nrm -rf /"
        ]),
        relPath: Schema.Union([
          Schema.String.pipe(Schema.check(Schema.isMaxLength(40))),
          Schema.Literals(["a/b.ts", "../escape", "../../etc/passwd", "/etc/passwd", "."])
        ]),
        modeInput: Schema.Union([Schema.Undefined, Schema.Literals(["all", "ask", "deny", "invalid", "ALL"])]),
        now: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 5000 }))),
        draft: Schema.Literals(["", "typing"])
      })
    )
    await runFuzz(arb, ({ dangerousShell, relPath, modeInput, now, draft }) => {
      if (Approvals.readOnly(dangerousShell, cwd, cwd) !== false) return false

      const safeRel = relPath.replace(/\0/g, "")
      const inside = Approvals.within(cwd, safeRel)
      const refused = Reads.refusal(cwd, safeRel)
      if (safeRel === "../escape" || safeRel === "../../etc/passwd" || safeRel === "/etc/passwd") {
        if (inside !== undefined || refused === undefined) return false
      }
      if ((inside === undefined) !== (refused !== undefined)) return false

      const m = Approvals.mode({ [Approvals.environmentKey]: modeInput }, { print: false })
      if (modeInput === "invalid" && (typeof m === "string" || !("error" in m))) return false
      const mPrintAsk = Approvals.mode({}, { print: true, flag: "ask" })
      if (typeof mPrintAsk === "string" || !("error" in mPrintAsk)) return false

      const arm = Approvals.shown(Approvals.idle, [{ requestId: "req-1" } as Approvals.Pending], 1000)
      const isReady = Approvals.ready(arm, "req-1", now, draft)
      if (draft !== "" && isReady) return false
      if (now - 1000 < Approvals.armMs && isReady) return false

      const preview = Approvals.hunk("a\n".repeat(40), "b\n".repeat(40))
      if (preview.lines.length > Approvals.previewLines + 1) return false
      return true
    }, 8)
  })

  test("Tabs, Tree.clock, Timeline, Summary, Theme, Changes & CellDisplay uphold UI projection invariants", async () => {
    const tabStatuses = ["queued", "requested", "running", "waiting", "parked", "done", "failed", "cancelled"] as const
    const arb = Arbitrary.schema(
      Schema.Struct({
        status: Schema.Literals(tabStatuses),
        startedAt: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000 }))),
        now: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 2_000_000 }))),
        ms: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 10_000_000 }))),
        percent: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 100 }))),
        laneIdx: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 50 }))),
        noColor: Schema.Literals(["", "1"]),
        term: Schema.Literals(["", "xterm-256color", "xterm", "xterm-kitty"]),
        colorterm: Schema.Literals(["", "truecolor", "24bit"]),
        toggleKind: Schema.Literals(["user", "cell", "shell", "answer", "error", "note", "card", "run"]),
        query: Schema.String.pipe(Schema.check(Schema.isMaxLength(20)))
      })
    )
    await runFuzz(
      arb,
      ({ status, startedAt, now, ms, percent, laneIdx, noColor, term, colorterm, toggleKind, query }) => {
        const st = Tabs.style(status, now)
        if (st.glyph.length === 0 || !st.tone.startsWith("#")) return false
        if (Tabs.elapsed({ startedAt, endedAt: undefined }, now) < 0) return false
        const clk = Tree.clock(ms)
        if (clk.length === 0) return false
        const acts = Tabs.actions({ status, failure: undefined, driver: undefined, harness: undefined })
        for (const a of acts) {
          if (
            Tabs.actionFor(a.binding, { status, failure: undefined, driver: undefined, harness: undefined }) ===
              undefined
          ) {
            return false
          }
        }

        const mixed = Theme.mix("#112233", percent, "#aabbcc")
        if (!/^#[0-9a-f]{6}$/.test(mixed)) return false
        if (Theme.mix("#112233", 100, "#aabbcc") !== "#112233") return false
        if (Theme.mix("#112233", 0, "#aabbcc") !== "#aabbcc") return false
        const cm = Theme.colorModeOf({ NO_COLOR: noColor, TERM: term, COLORTERM: colorterm })
        if (noColor !== "" && cm !== "none") return false
        if (Theme.lane(laneIdx) === Theme.color.brand) return false

        const t1 = Timeline.toggleKind(Timeline.initial, toggleKind)
        const t2 = Timeline.toggleKind(t1, toggleKind)
        if (t2.kinds.length !== Timeline.initial.kinds.length) return false
        let transcript = Transcript.empty
        transcript = Transcript.user(transcript, "hello world", false, 500)
        transcript = Transcript.note(transcript, "note text", 200)
        const rows = Timeline.rows(transcript, { kinds: [], query })
        for (let i = 1; i < rows.length; i++) {
          if (rows[i]!.at < rows[i - 1]!.at) return false
        }
        const sumPanel = Summary.panel(transcript)
        if (sumPanel.rows.length !== 1) return false

        if (Changes.paths("write", { path: "a.ts" })[0] !== "a.ts") return false
        const diff = "diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-a\n+b\n"
        const patches = Changes.splitPatch(diff)
        if (patches.length !== 1 || patches[0]!.path !== "foo.ts") return false

        if (
          CellDisplay.detail({ tag: "denied", fault: "user", sentence: "Denied", detail: "secret", actions: [] }) !== ""
        ) {
          return false
        }
        if (
          CellDisplay.detail({ tag: "internal", fault: "infra", sentence: "Failed", detail: "stack", actions: [] }) !==
            "stack"
        ) {
          return false
        }
        return true
      },
      9
    )
  })

  test("RunCard.summary/programHint, Subagents.oneLine, Graph.draw/text, Toasts.visibleRows & Activity/Scrubber uphold bounds", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        body: Schema.String.pipe(Schema.check(Schema.isMaxLength(160))),
        width: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 80 }))),
        toastCount: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 10 }))),
        height: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 12 }))),
        compact: Schema.Boolean,
        childCount: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 4 }))),
        navKey: Schema.Literals(["home", "end", "left", "right", "up", "down", "[", "]", "x"]),
        spanMs: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 10_000 })))
      })
    )
    await runFuzz(arb, ({ body, width, toastCount, height, compact, childCount, navKey, spanMs }) => {
      const sumLines = RunCard.summary(`\`\`\`ts\n${body}\n\`\`\``, width)
      if (sumLines.length > 2) return false
      const hint = RunCard.programHint({ startedAt: 1000, endedAt: 1000 + spanMs })
      if (spanMs < 1000 && hint !== "ctrl+o program") return false
      if (spanMs >= 1000 && !hint.startsWith("ctrl+o program · ")) return false

      const one = Subagents.oneLine(body)
      if (/[\r\n\t]/.test(one)) return false

      const root: Graph.Node = {
        key: "root",
        glyph: "●",
        tone: "#7fbfb3",
        name: "root",
        sub: "fast · 1s",
        children: Array.from({ length: childCount }, (_, i) => ({
          key: `c${i}`,
          glyph: "✓",
          tone: "#7fbfb3",
          name: `child-${i}`,
          sub: "1s",
          children: []
        }))
      }
      const drawn = Graph.draw(root, "root", {
        line: "#969083",
        accent: "#45c4b2",
        text: "#ece7db",
        faint: "#a8a193"
      })
      if (drawn.boxes.size !== 1 + childCount) return false
      if (drawn.rows.length < Graph.size.height) return false
      if (Graph.text(drawn.rows).length === 0) return false

      const list = Array.from({ length: toastCount }, (_, i) => ({
        id: `t${i}`,
        text: `Toast ${i}`,
        tone: "info" as const
      }))
      const vis = Toasts.visibleRows(list, height, compact)
      const maxSlots = Math.max(1, Math.floor(height / (compact || height < 2 ? 1 : 2)))
      if (vis.length > Math.min(toastCount, maxSlots)) return false

      let act = Activity.empty
      act = Activity.finish(act, "completed", 200, "")
      const ev = Scrubber.event(act)
      if (ev.label !== "Done" || ev.tone !== "text") return false
      const moved = Scrubber.key(act, undefined, navKey)
      if (navKey === "x" && moved !== undefined) return false
      if (navKey !== "x" && moved === undefined) return false
      return true
    }, 10)
  })
})

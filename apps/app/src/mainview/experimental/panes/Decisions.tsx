/*
 * Mock: Decisions. Behind VITE_SMITHERS_EXPERIMENTAL, reached by
 * `/experimental.decisions`. Self-contained on purpose — see ../Pane.ts.
 *
 * Jev, drawn. Every enumerable decision is a `Classifier.make` declaration:
 * one state schema, several typed questions, one `Evaluator` call. The right
 * column is the debug half — every answer carries the fields its own shape
 * has: a boolean its `probability`, a choice and a score their
 * `probabilities`, a score its interpolated `value` and the `label` of the
 * nearest rung. `Classifier.confidence` is a boolean's distance from even
 * odds doubled, and a choice's or a score's own `confidence`, which is the
 * largest probability it carries. `Classifier.confident(answer, floor)`
 * returns `Answer.value` at or above the floor and none below it, so a score
 * answers with its number, not its label, and the caller decides rather than
 * a model. Below it, the failure the transport itself can return — and a
 * refused call has no answer at all, so it has no probability, no confidence
 * and no `confident()` — and the scripted layer that pins the answer in a
 * test.
 */
import { pane, type ExperimentalPaneContext } from "../Pane"
import { Badge, Bars, Code, Facts, Rail, Section, Split, Table, type Tone } from "../Primitives"

/**
 * One question and the answer this fixture holds, named as
 * `Classifier.Answer` names its own fields. Absent means the answer's shape
 * does not carry it — a boolean has no distribution, a choice no label — or,
 * for the refused call, that there is no answer to carry anything.
 */
type Answered = {
  readonly id: string
  readonly kind: "boolean" | "choice" | "score"
  /** The confidence `Classifier.confident` is asked for. */
  readonly floor: string
  readonly tone: Tone
  /** `Answer.value`: the boolean, the option, or the score. */
  readonly value?: string
  /** `ScoreAnswer.label`: the nearest rung to `value`. */
  readonly label?: string
  /** `BooleanAnswer.probability`: the transport's probability of `true`. */
  readonly probability?: number
  /** `Classifier.confidence(answer)`. */
  readonly confidence?: number
  /** `Answer.probabilities`, largest first; a boolean answer carries none. */
  readonly probabilities?: ReadonlyArray<{
    readonly id: string
    readonly label: string
    readonly value: number
    readonly display: string
  }>
  /** What `Classifier.confident(answer, floor)` returned for this answer. */
  readonly confident: string
}

/** One declaration: the state it was asked about, and the answers it got. */
type Decision = {
  readonly id: string
  readonly label: string
  readonly site: string
  readonly ms: string
  readonly note: string
  readonly tone: Tone
  /** The state as its schema holds it, one row per field. */
  readonly state: ReadonlyArray<{ readonly id: string; readonly label: string; readonly value: string }>
  readonly questions: ReadonlyArray<Answered>
}

const DECISIONS: ReadonlyArray<Decision> = [
  {
    id: "triage/relevance",
    label: "triage/relevance",
    site: "std/Classifiers.ts",
    ms: "284 ms",
    note: "3 answers",
    tone: "ok",
    state: [
      { id: "task", label: "task", value: "widen() drops the unit: test_keeps_unit expects 'km' and gets 'm'" },
      { id: "file", label: "file", value: "src/units/widen.py" },
      { id: "excerpt", label: "excerpt", value: "def widen(value, unit): return value" }
    ],
    questions: [
      {
        id: "relevant",
        kind: "boolean",
        floor: "0.70",
        value: "true",
        probability: 0.94,
        confidence: 0.88,
        confident: "Option.some(true)",
        tone: "ok"
      },
      {
        id: "role",
        kind: "choice",
        floor: "0.70",
        value: "implementation",
        confidence: 0.96,
        confident: "Option.some(implementation)",
        tone: "ok",
        probabilities: [
          { id: "implementation", label: "implementation — code the task is about, or code that calls it", value: 0.96, display: "0.96" },
          { id: "fixture", label: "fixture — test data, test setup, configuration, or generated output", value: 0.03, display: "0.03" },
          { id: "unrelated", label: "unrelated — nothing in the excerpt bears on the task", value: 0.01, display: "0.01" }
        ]
      },
      {
        id: "risk",
        kind: "score",
        floor: "0.70",
        value: "1",
        label: "low",
        confidence: 0.55,
        confident: "Option.none()",
        tone: "warn",
        probabilities: [
          { id: "low", label: "low", value: 0.55, display: "0.55" },
          { id: "none", label: "none", value: 0.41, display: "0.41" },
          { id: "medium", label: "medium", value: 0, display: "0.00" },
          { id: "high", label: "high", value: 0, display: "0.00" }
        ]
      }
    ]
  },
  {
    id: "check/verdict",
    label: "check/verdict",
    site: "std/Classifiers.ts",
    ms: "512 ms",
    note: "2 answers",
    tone: "ok",
    state: [
      { id: "task", label: "task", value: "widen() drops the unit" },
      { id: "command", label: "command", value: "pytest tests/test_widen.py -q" },
      { id: "exitCode", label: "exitCode", value: "1" },
      { id: "output", label: "output", value: "1 failed, 12 passed" }
    ],
    questions: [
      {
        id: "rightReason",
        kind: "boolean",
        floor: "0.70",
        value: "true",
        probability: 0.88,
        confidence: 0.76,
        confident: "Option.some(true)",
        tone: "ok"
      },
      {
        id: "invalidProbe",
        kind: "boolean",
        floor: "0.70",
        value: "false",
        probability: 0.04,
        confidence: 0.92,
        confident: "Option.some(false)",
        tone: "ok"
      }
    ]
  },
  {
    id: "edit/risk",
    label: "edit/risk",
    site: "std/Classifiers.ts",
    ms: "301 ms",
    note: "2 answers",
    tone: "ok",
    state: [
      { id: "task", label: "task", value: "widen() drops the unit" },
      { id: "path", label: "path", value: "src/units/widen.py" },
      { id: "hunk", label: "hunk", value: "@@ -38,6 +38,7 @@ return value * factor(unit)" }
    ],
    questions: [
      {
        id: "risk",
        kind: "score",
        floor: "0.70",
        value: "1",
        label: "low",
        confidence: 0.81,
        confident: "Option.some(1)",
        tone: "ok",
        probabilities: [
          { id: "low", label: "low", value: 0.81, display: "0.81" },
          { id: "none", label: "none", value: 0.12, display: "0.12" },
          { id: "medium", label: "medium", value: 0.06, display: "0.06" },
          { id: "high", label: "high", value: 0.01, display: "0.01" }
        ]
      },
      {
        id: "reversible",
        kind: "boolean",
        floor: "0.70",
        value: "true",
        probability: 0.97,
        confidence: 0.94,
        confident: "Option.some(true)",
        tone: "ok"
      }
    ]
  },
  {
    id: "probe/attribution",
    label: "probe/attribution",
    site: "std/Classifiers.ts",
    ms: "268 ms",
    note: "no door",
    tone: "muted",
    state: [
      { id: "command", label: "command", value: "pytest tests/test_widen.py -q" },
      { id: "exitCode", label: "exitCode", value: "4" },
      { id: "output", label: "output", value: "ERROR: file or directory not found" }
    ],
    questions: [
      {
        id: "attribution",
        kind: "choice",
        floor: "0.70",
        value: "unknown-path",
        confidence: 0.89,
        confident: "Option.some(unknown-path)",
        tone: "ok",
        probabilities: [
          { id: "unknown-path", label: "unknown-path — the file or directory that was named does not exist", value: 0.89, display: "0.89" },
          { id: "unknown-test", label: "unknown-test — the test runner could not find the test that was named", value: 0.06, display: "0.06" },
          { id: "tree", label: "tree — it ran the intended tests and the failure is the code's", value: 0.03, display: "0.03" },
          { id: "unknown-module", label: "unknown-module — the module that was imported does not exist here", value: 0.02, display: "0.02" },
          { id: "unknown-command", label: "unknown-command — the shell could not find the program it was asked to run", value: 0, display: "0.00" },
          { id: "unknown-environment", label: "unknown-environment — the runner has no environment by that name", value: 0, display: "0.00" }
        ]
      },
      {
        id: "executed",
        kind: "boolean",
        floor: "0.70",
        value: "false",
        probability: 0.02,
        confidence: 0.96,
        confident: "Option.some(false)",
        tone: "ok"
      }
    ]
  },
  {
    id: "harness/health",
    label: "harness/health",
    site: "opencode/Health.ts",
    ms: "308 ms",
    note: "per frame",
    tone: "warn",
    state: [
      { id: "task", label: "task", value: "widen() drops the unit: test_keeps_unit expects 'km' and gets 'm'" },
      { id: "frame", label: "frame", value: "7" },
      { id: "maxFrames", label: "maxFrames", value: "40" },
      { id: "framesSinceEdit", label: "framesSinceEdit", value: "3" },
      { id: "demands", label: "demands", value: `["repeat"]` },
      {
        id: "lastCalls",
        label: "lastCalls",
        value: `[{ flow: "bash", ok: true, summary: "pytest tests/test_widen.py -q" }]`
      },
      { id: "lastPrints", label: "lastPrints", value: "? continue? [y/N]" },
      { id: "parked", label: "parked", value: "permission" },
      { id: "lastTransition", label: "lastTransition", value: "park" }
    ],
    questions: [
      {
        id: "needsHuman",
        kind: "boolean",
        floor: "0.50",
        value: "true",
        probability: 0.97,
        confidence: 0.94,
        confident: "Option.some(true)",
        tone: "ok"
      },
      {
        id: "progress",
        kind: "score",
        floor: "0.50",
        value: "2",
        label: "progressing",
        confidence: 0.34,
        confident: "Option.none()",
        tone: "warn",
        probabilities: [
          { id: "progressing", label: "progressing", value: 0.34, display: "0.34" },
          { id: "exploring", label: "exploring", value: 0.31, display: "0.31" },
          { id: "verifying", label: "verifying", value: 0.19, display: "0.19" },
          { id: "stuck", label: "stuck", value: 0.08, display: "0.08" },
          { id: "done", label: "done", value: 0.08, display: "0.08" }
        ]
      },
      {
        id: "stuck",
        kind: "boolean",
        floor: "0.50",
        value: "true",
        probability: 0.56,
        confidence: 0.12,
        confident: "Option.none()",
        tone: "warn"
      }
    ]
  },
  {
    id: "duplicates/pair",
    label: "duplicates/pair",
    site: "app",
    ms: "refused 429",
    note: "refused",
    tone: "bad",
    state: [
      { id: "a", label: "a", value: "#412 widen drops unit" },
      { id: "b", label: "b", value: "#388 unit lost on widen" }
    ],
    questions: [
      {
        id: "same",
        kind: "boolean",
        floor: "0.80",
        confident: "not reached: ClassifierError(refused, 429)",
        tone: "bad"
      }
    ]
  }
]

const SCRIPTED = `Evaluator.layerScripted(({ questions }) => ({
  relevant: { type: "boolean", probability: 0.94 },
  role: { type: "choice", choice: "implementation",
          probabilities: { implementation: 0.96, fixture: 0.03, unrelated: 0.01 } },
  risk: { type: "score", score: 1, probabilities: { none: 0.41, low: 0.55 } }
}))`

const ERRORS = [
  { id: "unreachable", code: "unreachable", meaning: "no evaluator bound", tone: "bad" as const },
  { id: "refused", code: "refused", meaning: "429 from the gateway", tone: "bad" as const },
  { id: "empty", code: "empty", meaning: "no answer for a question", tone: "bad" as const },
  { id: "timeout", code: "timeout", meaning: "past 1500 ms", tone: "warn" as const },
  { id: "invalid_answer", code: "invalid_answer", meaning: "answer off the criteria", tone: "bad" as const },
  { id: "invalid_question", code: "invalid_question", meaning: "question the schema rejects", tone: "bad" as const }
]

/** Whether `Classifier.confident` takes this answer: its confidence at or above the floor. */
const taken = (question: Answered): boolean =>
  question.confidence !== undefined && question.confidence >= Number(question.floor)

/** The answer, as the row reads it: a score carries its label beside its number. */
const reads = (question: Answered): string =>
  question.value === undefined
    ? "no answer"
    : !taken(question)
    ? "none"
    : question.label === undefined
    ? question.value
    : `${question.value} · ${question.label}`

/** One row per field this answer's own shape carries. */
const fields = (question: Answered) => [
  ...(question.value === undefined ? [] : [{ label: "value", value: question.value, mono: true }]),
  ...(question.label === undefined ? [] : [{ label: "label", value: question.label, mono: true }]),
  ...(question.probability === undefined
    ? []
    : [{ label: "probability", value: question.probability.toFixed(2), mono: true }]),
  ...(question.confidence === undefined
    ? []
    : [{ label: "confidence", value: question.confidence.toFixed(2), mono: true }])
]

export const Pane = pane({
  id: "decisions",
  title: "Decisions",
  summary: "Jev's questions, criteria and floors",
  packages: ["@smthrs/model", "@smthrs/std"],
  render: (context) => <DecisionsBody {...context} />
})

function DecisionsBody({ props, set: runCommandSet }: ExperimentalPaneContext) {
  const id = typeof props.id === "string" ? props.id : "triage/relevance"
  const ask = typeof props.ask === "string" ? props.ask : "risk"
  const decision = DECISIONS.find((row) => row.id === id) ?? DECISIONS[0]
  const question = decision.questions.find((row) => row.id === ask) ?? decision.questions[0]
  const probabilities = question.probabilities
  const met = taken(question)
  const likeliest = probabilities === undefined ? undefined : probabilities[0]
  return (
    <Split
      left={
        <>
          <Section title="Decisions" right={<Badge tone="info">{`${DECISIONS.length}`}</Badge>}>
            <Rail
              items={DECISIONS.map((row) => ({ id: row.id, label: row.label, note: row.note, tone: row.tone }))}
              selected={id}
              onSelect={(id) => runCommandSet("id", id)}
            />
          </Section>
          <Section title="Evaluator">
            <Facts rows={[
              { label: "Model", value: "typesafe-ai/jev", mono: true },
              { label: "Protocol", value: "0.0.1 · spec 4", mono: true },
              { label: "Deadline", value: "1500 ms", mono: true },
              { label: "Key", value: "AI_GATEWAY_API_KEY", mono: true },
              { label: "Concurrency", value: "8", mono: true }
            ]} />
          </Section>
        </>
      }
      right={
        <>
          <Section title={decision.label} right={<Badge tone={decision.tone}>{decision.ms}</Badge>}>
            <Facts rows={[
              { label: "Declared", value: decision.site, mono: true },
              { label: "Questions", value: `${decision.questions.length} in one call` },
              ...decision.state.map((row) => ({ label: row.label, value: row.value, mono: true }))
            ]} />
          </Section>
          <Section title="Questions" right="boolean · choice · score">
            <Table
              columns={[
                { key: "id", label: "Question", mono: true },
                { key: "kind", label: "Kind" },
                { key: "value", label: "Answer", mono: true },
                { key: "confidence", label: "Confidence", mono: true, right: true },
                { key: "floor", label: "Floor", mono: true, right: true }
              ]}
              rows={decision.questions.map((row) => ({
                id: row.id,
                kind: row.kind,
                value: <Badge tone={row.tone}>{reads(row)}</Badge>,
                confidence: row.confidence === undefined ? "—" : row.confidence.toFixed(2),
                floor: row.floor
              }))}
              selected={question.id}
              onSelect={(id) => runCommandSet("ask", id)}
            />
          </Section>
          <Section
            title={question.id}
            right={
              <Badge tone={met ? "ok" : "bad"}>
                {question.confidence === undefined ? "no answer" : met ? "confident" : "below the floor"}
              </Badge>
            }
          >
            {probabilities === undefined
              ? null
              : (
                <Bars
                  rows={probabilities.map((row) => ({
                    label: row.label,
                    value: row.value,
                    display: row.display,
                    tone: row.value >= Number(question.floor) ? "ok" : "muted"
                  }))}
                  max={1}
                />
              )}
            <Facts rows={[
              ...fields(question),
              { label: "floor", value: question.floor, mono: true },
              { label: "confident()", value: question.confident, mono: true },
              {
                label: met || likeliest === undefined ? "Then" : "Likeliest",
                value: met
                  ? "the answer is taken"
                  : likeliest === undefined
                  ? "the caller decides, not a model"
                  : `${likeliest.id} · ${likeliest.display}`
              }
            ]} />
          </Section>
          <Section title="Failures" right={<Badge tone="bad">EvaluatorError</Badge>}>
            <Table
              columns={[
                { key: "code", label: "code", mono: true },
                { key: "meaning", label: "Cause" }
              ]}
              rows={ERRORS.map((row) => ({
                id: row.id,
                code: <Badge tone={row.tone}>{row.code}</Badge>,
                meaning: row.meaning
              }))}
            />
          </Section>
          <Section title="As a test">
            <Code label="layerScripted">{SCRIPTED}</Code>
          </Section>
        </>
      }
    />
  )
}

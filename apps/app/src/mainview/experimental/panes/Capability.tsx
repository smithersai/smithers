/*
 * Mock: Capability and grants. Behind VITE_SMITHERS_EXPERIMENTAL, reached by
 * `/experimental.capability`. Self-contained on purpose — see ../Pane.ts.
 *
 * The rule ladder is the drawing. `Permission.evaluate` reduces ordered
 * rulesets last-match-wins with `ask` as the default; ruleset 0 is configured
 * policy and its effective `deny` is a hard veto; `GrantStore.check` tests the
 * `CapabilitySet` ceiling BEFORE it reads a rule. A refusal today arrives as a
 * `PlatformError` with the structured original buried on its cause, so a
 * person sees a failed write and never the rule that decided it.
 */
import { pane, type ExperimentalPaneContext } from "../Pane"
import { Badge, Bars, Facts, Rail, Section, Split, Table, type Tone } from "../Primitives"

type Answer = "allow" | "deny" | "ask"

interface Call {
  readonly id: string
  readonly action: string
  readonly resource: string
  readonly tier: "sealed" | "compensable" | "irreversible"
  readonly slot: string
  /** False when the CapabilitySet ceiling refused before any rule was read. */
  readonly ceiling: boolean
  /** Rule ids `matches` selected, in ladder order; the last one wins. */
  readonly matched: ReadonlyArray<string>
  /** The last match inside ruleset 0, which is the only veto. */
  readonly configured: Answer
  readonly answer: Answer
  readonly result?: string
  readonly failure?: string
  readonly code?: string
  readonly reason?: string
  readonly requestId?: string
}

const ANSWER_TONE: Readonly<Record<Answer, Tone>> = {
  allow: "ok",
  deny: "bad",
  ask: "warn"
}

const CALLS: ReadonlyArray<Call> = [
  {
    id: "k1",
    action: "fs:read",
    resource: "/workspace/README.md",
    tier: "sealed",
    slot: "effect/FileSystem",
    ceiling: true,
    matched: ["r1"],
    configured: "allow",
    answer: "allow",
    result: "4.1 KiB"
  },
  {
    id: "k2",
    action: "fs:write",
    resource: "/workspace/out.txt",
    tier: "compensable",
    slot: "effect/FileSystem",
    ceiling: true,
    matched: [],
    configured: "ask",
    answer: "ask",
    failure: "@smthrs/capability/PermissionRequired",
    code: "permission_required",
    requestId: "req-4"
  },
  {
    id: "k3",
    action: "fs:write",
    resource: "/workspace/.git/config",
    tier: "compensable",
    slot: "effect/FileSystem",
    ceiling: true,
    matched: ["r2"],
    configured: "deny",
    answer: "deny",
    failure: "@smthrs/capability/PermissionDenied",
    code: "permission_denied",
    reason: "denied by permission policy"
  },
  {
    id: "k4",
    action: "proc:spawn",
    resource: "npm test",
    tier: "irreversible",
    slot: "effect/process/ChildProcessSpawner",
    ceiling: true,
    matched: ["r3"],
    configured: "allow",
    answer: "allow",
    result: "exit 0"
  },
  {
    id: "k5",
    action: "net:post",
    resource: "https://api.example.test/deploy",
    tier: "irreversible",
    slot: "effect/HttpClient",
    ceiling: true,
    matched: [],
    configured: "ask",
    answer: "ask",
    failure: "@smthrs/capability/PermissionRequired",
    code: "permission_required",
    requestId: "req-9"
  },
  {
    id: "k6",
    action: "jj:snapshot",
    resource: "before the risky step",
    tier: "compensable",
    slot: "@smthrs/jj/Jj",
    ceiling: true,
    matched: ["r5"],
    configured: "ask",
    answer: "allow",
    result: "kqmzxrol"
  },
  {
    id: "k7",
    action: "fs:write",
    resource: "/tmp/scratch.log",
    tier: "irreversible",
    slot: "effect/FileSystem",
    ceiling: false,
    matched: [],
    configured: "ask",
    answer: "deny",
    failure: "@smthrs/capability/PermissionDenied",
    code: "permission_denied",
    reason: "outside capability ceiling"
  }
]

/** Ladder order is `GrantStore`'s: configured policy, envelope, run, remembered. */
const RULES = [
  { id: "r1", set: "policy", effect: "allow" as Answer, pattern: "fs:read:/workspace/**" },
  { id: "r2", set: "policy", effect: "deny" as Answer, pattern: "fs:write:/workspace/.git/**" },
  { id: "r3", set: "policy", effect: "allow" as Answer, pattern: "proc:spawn:npm *" },
  { id: "r4", set: "envelope", effect: "allow" as Answer, pattern: "fs:write:/workspace/dist/**" },
  { id: "r5", set: "run", effect: "allow" as Answer, pattern: "jj:snapshot:**" },
  { id: "r6", set: "remembered", effect: "allow" as Answer, pattern: "net:get:https://registry.npmjs.org/**" }
]

const GRANTS = [
  {
    id: "g1",
    eventType: "flows.kernel.grant.remembered.v1",
    pattern: "net:get:https://registry.npmjs.org/**",
    scope: "remembered",
    tier: "sealed",
    active: true
  },
  {
    id: "g2",
    eventType: "flows.kernel.grant.envelope.v1",
    pattern: "fs:write:/workspace/dist/**",
    scope: "run",
    tier: "compensable",
    active: true
  },
  {
    id: "g3",
    eventType: "flows.kernel.grant.run.v2",
    pattern: "jj:snapshot:**",
    scope: "run",
    tier: "compensable",
    active: true
  },
  {
    id: "g4",
    eventType: "flows.kernel.grant.once.v1",
    pattern: "net:post:https://api.example.test/deploy",
    scope: "once",
    tier: "irreversible",
    active: false
  },
  {
    id: "g5",
    eventType: "flows.kernel.grant.denied.v1",
    pattern: "fs:write:/workspace/.git/config",
    scope: "—",
    tier: "compensable",
    active: false
  }
]

const TIERS = [
  { label: "sealed", value: 1, display: "1", tone: "ok" as Tone },
  { label: "compensable", value: 3, display: "3", tone: "info" as Tone },
  { label: "irreversible", value: 3, display: "3", tone: "warn" as Tone }
]

export const Pane = pane({
  id: "capability",
  title: "Capability and grants",
  summary: "Which rule allowed a call, and the grant set as it grew",
  packages: ["@smthrs/capability", "@smthrs/kernel"],
  render: (context) => <CapabilityBody {...context} />
})

function CapabilityBody({ props, set: runCommandSet }: ExperimentalPaneContext) {
  const call = typeof props.call === "string" ? props.call : "k2"
  const selected = CALLS.find((row) => row.id === call)
  if (selected === undefined) return null
  const winner = selected.matched.at(-1)
  return (
    <Split
      left={
        <>
          <Section title="Calls">
            <Rail
              items={CALLS.map((row) => ({
                id: row.id,
                label: `${row.action}:${row.resource}`,
                note: row.answer,
                tone: ANSWER_TONE[row.answer]
              }))}
              selected={call}
              onSelect={(id) => runCommandSet("call", id)}
            />
          </Section>
          <Section title="Tiers"><Bars rows={TIERS} /></Section>
          <Section title="Ceiling">
            <Facts rows={[
              { label: "Groups", value: "2, both required" },
              { label: "1", value: "fs:*:**, net:*:**, proc:spawn:**, jj:snapshot:**", mono: true },
              { label: "2", value: "*:/workspace/**, *:npm *, *:https://**, jj:*:**", mono: true }
            ]} />
          </Section>
        </>
      }
      right={
        <>
          <Section title="Capability" right={<Badge tone={ANSWER_TONE[selected.answer]}>{selected.answer}</Badge>}>
            <Facts rows={[
              { label: "Action", value: selected.action, mono: true },
              { label: "Resource", value: selected.resource, mono: true },
              { label: "Tier", value: selected.tier },
              { label: "Slot", value: selected.slot, mono: true }
            ]} />
          </Section>
          <Section title="Rules" right="last match wins">
            <Table
              columns={[
                { key: "order", label: "#", right: true },
                { key: "set", label: "Ruleset" },
                { key: "effect", label: "Effect" },
                { key: "pattern", label: "Pattern", mono: true },
                { key: "match", label: "Match", right: true }
              ]}
              rows={RULES.map((rule, index) => ({
                id: rule.id,
                order: index,
                set: rule.set,
                effect: <Badge tone={ANSWER_TONE[rule.effect]}>{rule.effect}</Badge>,
                pattern: rule.pattern,
                match: rule.id === winner
                  ? <Badge tone={ANSWER_TONE[rule.effect]}>wins</Badge>
                  : selected.matched.includes(rule.id)
                  ? <Badge tone="info">matches</Badge>
                  : ""
              }))}
            />
          </Section>
          <Section title="Decision">
            <Facts rows={[
              {
                label: "Ceiling",
                value: selected.ceiling
                  ? <Badge tone="ok">allows</Badge>
                  : <Badge tone="bad">outside capability ceiling</Badge>
              },
              { label: "Configured", value: selected.ceiling ? selected.configured : "not read" },
              { label: "Effective", value: <Badge tone={ANSWER_TONE[selected.answer]}>{selected.answer}</Badge> },
              ...(selected.failure === undefined
                ? [{ label: "Result", value: selected.result ?? "", mono: true }]
                : [{ label: "Failure", value: selected.failure, mono: true }, { label: "Code", value: selected.code ?? "", mono: true }]),
              ...(selected.reason === undefined ? [] : [{ label: "Reason", value: selected.reason }]),
              ...(selected.requestId === undefined ? [] : [{ label: "Request", value: selected.requestId, mono: true }])
            ]} />
          </Section>
          <Section title="Grants" right="monotone">
            <Table
              columns={[
                { key: "eventType", label: "Event", mono: true },
                { key: "pattern", label: "Pattern", mono: true },
                { key: "scope", label: "Scope" },
                { key: "tier", label: "Tier" },
                { key: "authority", label: "Authority", right: true }
              ]}
              rows={GRANTS.map((grant) => ({
                id: grant.id,
                eventType: grant.eventType,
                pattern: grant.pattern,
                scope: grant.scope,
                tier: grant.tier,
                authority: grant.active ? <Badge tone="ok">active</Badge> : <Badge tone="muted">audit</Badge>
              }))}
            />
          </Section>
        </>
      }
    />
  )
}

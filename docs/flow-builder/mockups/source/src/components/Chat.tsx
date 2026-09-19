import { Fragment, type ReactNode, useEffect, useRef } from "react"

import { formatDuration } from "../flow.ts"
import type { ChatItem } from "../script.ts"
import { IconBolt, IconCheck, IconKey, IconPerson, IconScale, IconSpark } from "./Icons.tsx"

/** `**bold**` and `` `code` `` only — the transcript renders nothing else. */
const rich = (text: string): ReactNode =>
  text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={index}>{part.slice(2, -2)}</strong>
    if (part.startsWith("`") && part.endsWith("`")) return <code key={index}>{part.slice(1, -1)}</code>
    return <Fragment key={index}>{part}</Fragment>
  })

const Bar = ({ value }: { value: number }) => (
  <span className="cf-bar" aria-hidden="true">
    <span style={{ width: `${Math.round(value * 100)}%` }} />
  </span>
)

const PlanCard = (item: Extract<ChatItem, { kind: "plan" }>) => (
  <section className="card" data-kind="plan">
    <header className="card-head">
      <span className="card-glyph"><IconBolt /></span>
      <h3>Plan compiled</h3>
      <code className="card-digest">{item.digest}</code>
    </header>
    <div className="card-stats">
      <div><strong>{item.nodes}</strong><span>nodes</span></div>
      <div data-tone="warning"><strong>{item.irreversible}</strong><span>irreversible</span></div>
      <div><strong>{item.gates}</strong><span>human gate</span></div>
    </div>
    <div className="card-actions">
      <button type="button" className="btn btn-primary">Run</button>
      <button type="button" className="btn">Open in editor</button>
    </div>
  </section>
)

const RunCard = (item: Extract<ChatItem, { kind: "run" }>) => {
  const done = item.built + item.clean
  const ratio = item.total === 0 ? 0 : Math.min(1, done / item.total)
  return (
    <section className="card" data-kind="run" data-phase={item.phase}>
      <header className="card-head">
        <span className="card-glyph"><IconBolt /></span>
        <h3>{item.title}</h3>
        <span className="pill" data-phase={item.phase}>
          {item.phase === "waiting-approval" ? "waiting on you" : item.phase}
        </span>
      </header>
      <div className="card-progress">
        <span style={{ width: `${Math.round(ratio * 100)}%` }} data-phase={item.phase} />
      </div>
      <div className="card-meta">
        <span><strong>{item.built}</strong> built</span>
        {item.clean > 0 ? <span data-tone="success"><strong>{item.clean}</strong> clean</span> : null}
        {item.skipped > 0 ? <span><strong>{item.skipped}</strong> skipped</span> : null}
        <span className="card-meta-spacer" />
        <span className="card-ms">{item.elapsedMs === 0 ? "—" : formatDuration(item.elapsedMs)}</span>
      </div>
    </section>
  )
}

const ApprovalCard = (item: Extract<ChatItem, { kind: "approval" }>) => (
  <section className="card" data-kind="approval" data-decided={item.decided}>
    <header className="card-head">
      <span className="card-glyph"><IconPerson /></span>
      <h3>{item.prompt}</h3>
      <span className="card-attempt">{item.attempt}/{item.maxAttempts}</span>
    </header>
    <ul className="card-list">
      {item.detail.map((line) => (
        <li key={line}><code>{line.split(" · ")[0]}</code><span>{line.split(" · ")[1]}</span></li>
      ))}
    </ul>
    {item.decided === "pending" ? (
      <div className="card-actions">
        <button type="button" className="btn btn-primary">Approve</button>
        <button type="button" className="btn">Deny</button>
      </div>
    ) : (
      <div className="card-settled"><IconCheck /> Approved</div>
    )}
  </section>
)

const RekeyCard = (item: Extract<ChatItem, { kind: "rekey" }>) => (
  <section className="card card-hero" data-kind="rekey" data-decided={item.decided}>
    <header className="card-head">
      <span className="card-glyph"><IconKey /></span>
      <h3>Re-key preview</h3>
    </header>
    <div className="card-split">
      <div className="card-split-side" data-tone="warning">
        <strong>{item.rerun}</strong>
        <span>re-run</span>
      </div>
      <div className="card-split-side" data-tone="success">
        <strong>{item.cached}</strong>
        <span>cache hits</span>
      </div>
      <div className="card-split-time">
        <s>{formatDuration(item.oldMs)}</s>
        <strong>{formatDuration(item.newMs)}</strong>
      </div>
    </div>
    <p className="card-note">
      The plan digest changes, so {item.voids} approval is voided and asked again.
    </p>
    {item.decided === "pending" ? (
      <div className="card-actions">
        <button type="button" className="btn btn-primary">Apply and run</button>
        <button type="button" className="btn">Discard</button>
      </div>
    ) : (
      <div className="card-settled"><IconCheck /> Applied</div>
    )}
  </section>
)

const JevCard = (item: Extract<ChatItem, { kind: "jev" }>) => (
  <section className="card" data-kind="jev">
    <header className="card-head">
      <span className="card-glyph"><IconScale /></span>
      <h3>{item.title}</h3>
    </header>
    <ul className="cf-answers">
      {item.answers.map((answer) => (
        <li key={answer.question}>
          <span className="cf-q">{answer.question}</span>
          <span className="cf-a">{answer.answer}</span>
          <Bar value={answer.confidence} />
          <span className="cf-c">{answer.confidence.toFixed(2)}</span>
        </li>
      ))}
    </ul>
  </section>
)

const renderItem = (item: ChatItem) => {
  switch (item.kind) {
    case "user":
      return <div className="bubble bubble-out">{item.text}</div>
    case "agent":
      return (
        <div className="bubble bubble-in">
          <span className="bubble-avatar" aria-hidden="true"><IconSpark /></span>
          <div className="bubble-text">
            {rich(item.text)}
            {item.typing ? <span className="typing" aria-hidden="true"><i /><i /><i /></span> : null}
          </div>
        </div>
      )
    case "act":
      return <div className="actline">{item.text}</div>
    case "plan":
      return <PlanCard {...item} />
    case "run":
      return <RunCard {...item} />
    case "approval":
      return <ApprovalCard {...item} />
    case "rekey":
      return <RekeyCard {...item} />
    case "jev":
      return <JevCard {...item} />
  }
}

export const Chat = ({ items }: { readonly items: readonly ChatItem[] }) => {
  const endRef = useRef<HTMLDivElement>(null)
  const count = items.length

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" })
  }, [count, items[count - 1]])

  return (
    <div className="chat">
      <div className="chat-scroll">
        <div className="chat-inner">
          {items.map((item) => (
            <div className="chat-row" data-kind={item.kind} key={item.id}>
              {renderItem(item)}
            </div>
          ))}
          <div ref={endRef} />
        </div>
      </div>
      <div className="composer">
        <div className="composer-box">
          <span className="composer-slash">/</span>
          <span className="composer-placeholder">Ask, or run a flow</span>
          <kbd>⌘K</kbd>
        </div>
      </div>
    </div>
  )
}

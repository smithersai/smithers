import { formatDuration, NODE_BY_ID, type NodeState } from "../flow.ts"
import { IconCode, IconKey, IconX, KIND_ICON } from "./Icons.tsx"

interface InspectorProps {
  readonly id: string | null
  readonly state: NodeState | undefined
  readonly rekeyed: boolean
  readonly settledMs: number | undefined
  readonly onClose: () => void
}

const TIER_NOTE: Record<string, string> = {
  sealed: "cacheable across runs",
  compensable: "rolled back on failure",
  irreversible: "approval gated"
}

export const Inspector = ({ id, state, rekeyed, settledMs, onClose }: InspectorProps) => {
  if (!id) return null
  const spec = NODE_BY_ID[id]
  const Glyph = KIND_ICON[spec.kind]

  return (
    <aside className="inspector" data-open="true" aria-label={`${spec.title} details`}>
      <header className="inspector-head">
        <span className="inspector-glyph" data-kind={spec.kind} aria-hidden="true"><Glyph /></span>
        <div>
          <h2>{spec.title}</h2>
          <code>{spec.tag}</code>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
          <IconX />
        </button>
      </header>

      <div className="inspector-scroll">
        <div className="inspector-badges">
          <span className="fl-chip" data-tier={spec.tier}>{spec.tier}</span>
          <span className="fl-chip fl-chip-quiet">{TIER_NOTE[spec.tier]}</span>
          {spec.seat ? <span className="fl-chip fl-chip-quiet">{spec.seat}</span> : null}
          {spec.model ? <span className="fl-chip fl-chip-quiet">{spec.model}</span> : null}
        </div>

        <section className="inspector-block">
          <h3><IconCode /> payload</h3>
          <ul className="ports">
            {spec.payload.map((field) => (
              <li key={field.name}>
                <span className="port-name">{field.name}</span>
                <span className="port-type">{field.type}</span>
                {field.from ? (
                  <span className="port-ref" title="Planned reference to an upstream result">
                    ← {field.from}
                  </span>
                ) : (
                  <span className="port-literal">{field.literal}</span>
                )}
              </li>
            ))}
          </ul>
        </section>

        <section className="inspector-block">
          <h3><IconCode /> settles</h3>
          <ul className="ports">
            <li><span className="port-name">success</span><span className="port-type">{spec.success}</span></li>
            {spec.error ? (
              <li><span className="port-name">error</span><span className="port-type" data-tone="danger">{spec.error}</span></li>
            ) : null}
          </ul>
        </section>

        {spec.effects ? (
          <section className="inspector-block">
            <h3><IconCode /> effects</h3>
            <p className="inspector-effects">{spec.effects}</p>
          </section>
        ) : null}

        <section className="inspector-block">
          <h3><IconKey /> step key</h3>
          <div className="keyline" data-rekeyed={rekeyed ? "true" : undefined}>
            <code data-stale={rekeyed ? "true" : undefined}>{spec.key}</code>
            {rekeyed && spec.rekey ? (
              <>
                <span aria-hidden="true">→</span>
                <code data-fresh="true">{spec.rekey}</code>
              </>
            ) : null}
          </div>
          <p className="inspector-note">
            {rekeyed
              ? "What this node consumes changed, so it re-keys and re-runs."
              : "Unchanged inputs, unchanged key. This node is a cache hit."}
          </p>
        </section>

        {state === "built" && settledMs !== undefined ? (
          <section className="inspector-block">
            <h3><IconKey /> last settlement</h3>
            <div className="settlement">
              <span>outcome</span><strong>built</strong>
              <span>wall clock</span><strong>{formatDuration(settledMs)}</strong>
              {spec.tokens ? (<><span>tokens</span><strong>{spec.tokens.toLocaleString()}</strong></>) : null}
              {spec.cost ? (<><span>cost</span><strong>${spec.cost.toFixed(2)}</strong></>) : null}
            </div>
          </section>
        ) : null}

        {spec.notes?.length ? (
          <section className="inspector-block">
            <h3><IconCode /> why</h3>
            <ul className="inspector-notes">
              {spec.notes.map((note) => <li key={note}>{note}</li>)}
            </ul>
          </section>
        ) : null}
      </div>

      <footer className="inspector-foot">
        <button type="button" className="btn btn-primary">Edit</button>
        <button type="button" className="btn">Pin output</button>
        <button type="button" className="btn">Re-run from here</button>
      </footer>
    </aside>
  )
}

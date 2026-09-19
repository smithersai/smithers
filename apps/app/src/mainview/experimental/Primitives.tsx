/*
 * The vocabulary every experimental mock draws with.
 *
 * Thirty mocks written at once diverge into thirty designs unless they share
 * a small set of shapes, so panes compose these and write no CSS of their own
 * (styles/experimental.css holds every rule, and styles/DeadCss.test.ts keeps
 * it honest). The set is deliberately small: a durable abstraction is almost
 * always a list of rows, a pair of columns, a graph, or a value beside its
 * label, and a mock that needs more than this is describing a product surface
 * rather than a drawing of one.
 */
import type { ReactNode } from "react"

/** How a value reads at a glance. */
export type Tone = "ok" | "warn" | "bad" | "info" | "muted"

/** A titled block. The title is the abstraction's own word, not a sentence. */
export function Section({ title, right, children }: {
  readonly title: string
  readonly right?: ReactNode
  readonly children: ReactNode
}) {
  return (
    <section className="xp-section">
      <header className="xp-section-head">
        <h3 className="xp-section-title">{title}</h3>
        {right === undefined ? null : <div className="xp-section-right">{right}</div>}
      </header>
      {children}
    </section>
  )
}

/** Two columns that become one on a narrow card. */
export function Split({ left, right }: { readonly left: ReactNode; readonly right: ReactNode }) {
  return (
    <div className="xp-split">
      <div className="xp-split-left">{left}</div>
      <div className="xp-split-right">{right}</div>
    </div>
  )
}

/** A short state word. */
export function Badge({ tone = "muted", children }: { readonly tone?: Tone; readonly children: ReactNode }) {
  return <span className="xp-badge" data-tone={tone}>{children}</span>
}

/** A label beside its value; the value is monospaced when it is an identifier. */
export function Facts({ rows }: {
  readonly rows: ReadonlyArray<{ readonly label: string; readonly value: ReactNode; readonly mono?: boolean }>
}) {
  return (
    <dl className="xp-facts">
      {rows.map((row) => (
        <div className="xp-fact" key={row.label}>
          <dt className="xp-fact-label">{row.label}</dt>
          <dd className="xp-fact-value" data-mono={row.mono === true}>{row.value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** One column of a {@link Table}. */
export interface Column {
  readonly key: string
  readonly label: string
  readonly mono?: boolean
  /** Pushes the column to the row's right edge. */
  readonly right?: boolean
}

/** Rows of an abstraction's durable state. `id` addresses the row. */
export function Table({ columns, rows, onSelect: runCommandSelect, selected, empty = "Nothing yet." }: {
  readonly columns: ReadonlyArray<Column>
  readonly rows: ReadonlyArray<{ readonly id: string } & Record<string, ReactNode>>
  readonly onSelect?: (id: string) => void
  readonly selected?: string
  readonly empty?: string
}) {
  if (rows.length === 0) return <Empty>{empty}</Empty>
  return (
    <table className="xp-table">
      <thead>
        <tr>{columns.map((column) => <th key={column.key} data-right={column.right === true}>{column.label}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr
            key={row.id}
            data-selected={row.id === selected}
            data-selectable={runCommandSelect !== undefined}
            tabIndex={runCommandSelect === undefined ? undefined : 0}
            role={runCommandSelect === undefined ? undefined : "button"}
            aria-pressed={runCommandSelect === undefined ? undefined : row.id === selected}
            onClick={runCommandSelect === undefined ? undefined : () => runCommandSelect(row.id)}
            onKeyDown={runCommandSelect === undefined ? undefined : (event) => {
              if (event.key !== "Enter" && event.key !== " ") return
              event.preventDefault()
              runCommandSelect(row.id)
            }}
          >
            {columns.map((column) => (
              <td key={column.key} data-mono={column.mono === true} data-right={column.right === true}>
                {row[column.key]}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** A selectable list: the left rail of a two-pane mock. */
export function Rail({ items, selected, onSelect: runCommandSelect }: {
  readonly items: ReadonlyArray<{ readonly id: string; readonly label: string; readonly note?: string; readonly tone?: Tone }>
  readonly selected?: string
  readonly onSelect?: (id: string) => void
}) {
  return (
    <ul className="xp-rail">
      {items.map((item) => (
        <li key={item.id}>
          <button
            type="button"
            className="xp-rail-item"
            data-selected={item.id === selected}
            aria-pressed={runCommandSelect === undefined ? undefined : item.id === selected}
            onClick={runCommandSelect === undefined ? undefined : () => runCommandSelect(item.id)}
          >
            <span className="xp-rail-label">{item.label}</span>
            {item.note === undefined ? null : <span className="xp-rail-note" data-tone={item.tone ?? "muted"}>{item.note}</span>}
          </button>
        </li>
      ))}
    </ul>
  )
}

/** A proportion, drawn. `max` defaults to the largest value present. */
export function Bars({ rows, max }: {
  readonly rows: ReadonlyArray<{ readonly label: string; readonly value: number; readonly display?: string; readonly tone?: Tone }>
  readonly max?: number
}) {
  const ceiling = max ?? Math.max(1, ...rows.map((row) => row.value))
  return (
    <ul className="xp-bars">
      {rows.map((row) => (
        <li className="xp-bar" key={row.label}>
          <span className="xp-bar-label">{row.label}</span>
          <span className="xp-bar-track">
            <span className="xp-bar-fill" data-tone={row.tone ?? "info"} style={{ width: `${Math.round((row.value / ceiling) * 100)}%` }} />
          </span>
          <span className="xp-bar-value">{row.display ?? row.value}</span>
        </li>
      ))}
    </ul>
  )
}

/** Source, a payload, a prompt: anything read verbatim. */
export function Code({ children, label }: { readonly children: string; readonly label?: string }) {
  return (
    <figure className="xp-code">
      {label === undefined ? null : <figcaption className="xp-code-label">{label}</figcaption>}
      <pre className="xp-code-body"><code>{children}</code></pre>
    </figure>
  )
}

/** An ordered run of events. `tone` marks the one that failed. */
export function Steps({ steps }: {
  readonly steps: ReadonlyArray<{ readonly id: string; readonly label: string; readonly note?: string; readonly tone?: Tone }>
}) {
  return (
    <ol className="xp-steps">
      {steps.map((step) => (
        <li className="xp-step" key={step.id} data-tone={step.tone ?? "muted"}>
          <span className="xp-step-label">{step.label}</span>
          {step.note === undefined ? null : <span className="xp-step-note">{step.note}</span>}
        </li>
      ))}
    </ol>
  )
}

/** One node of a {@link Graph}: `depth` is its column, `lane` its row. */
export interface GraphNode {
  readonly id: string
  readonly label: string
  readonly depth: number
  readonly lane: number
  readonly tone?: Tone
}

/**
 * A small left-to-right DAG. Plans, patterns, target graphs and flow
 * declarations are all this shape, so they share one drawing rather than
 * three: nodes place themselves on a depth/lane grid and the edges are drawn
 * as curves between the columns.
 */
export function Graph({ nodes, edges, onSelect: runCommandSelect, selected }: {
  readonly nodes: ReadonlyArray<GraphNode>
  readonly edges: ReadonlyArray<readonly [string, string]>
  readonly onSelect?: (id: string) => void
  readonly selected?: string
}) {
  const colWidth = 148
  const rowHeight = 46
  const boxWidth = 116
  const boxHeight = 28
  const depths = Math.max(1, ...nodes.map((node) => node.depth + 1))
  const lanes = Math.max(1, ...nodes.map((node) => node.lane + 1))
  const at = (id: string) => nodes.find((node) => node.id === id)
  const x = (node: GraphNode) => node.depth * colWidth
  const y = (node: GraphNode) => node.lane * rowHeight
  return (
    <svg
      className="xp-graph"
      viewBox={`0 0 ${depths * colWidth - (colWidth - boxWidth)} ${lanes * rowHeight - (rowHeight - boxHeight)}`}
      role={runCommandSelect === undefined ? "img" : "group"}
      aria-label="Graph"
    >
      {edges.map(([from, to]) => {
        const a = at(from)
        const b = at(to)
        if (a === undefined || b === undefined) return null
        const x1 = x(a) + boxWidth
        const y1 = y(a) + boxHeight / 2
        const x2 = x(b)
        const y2 = y(b) + boxHeight / 2
        const mid = (x1 + x2) / 2
        return (
          <path
            key={`${from}-${to}`}
            className="xp-graph-edge"
            d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
          />
        )
      })}
      {nodes.map((node) => (
        <g
          key={node.id}
          className="xp-graph-node"
          data-tone={node.tone ?? "muted"}
          data-selected={node.id === selected}
          data-selectable={runCommandSelect !== undefined}
          tabIndex={runCommandSelect === undefined ? undefined : 0}
          role={runCommandSelect === undefined ? undefined : "button"}
          aria-pressed={runCommandSelect === undefined ? undefined : node.id === selected}
          onClick={runCommandSelect === undefined ? undefined : () => runCommandSelect(node.id)}
          onKeyDown={runCommandSelect === undefined ? undefined : (event) => {
            if (event.key !== "Enter" && event.key !== " ") return
            event.preventDefault()
            runCommandSelect(node.id)
          }}
        >
          <rect x={x(node)} y={y(node)} width={boxWidth} height={boxHeight} rx={6} />
          <text x={x(node) + boxWidth / 2} y={y(node) + boxHeight / 2} dominantBaseline="central" textAnchor="middle">
            {node.label}
          </text>
        </g>
      ))}
    </svg>
  )
}

/** The honest empty state: one line, no advice. */
export function Empty({ children }: { readonly children: ReactNode }) {
  return <p className="xp-empty">{children}</p>
}

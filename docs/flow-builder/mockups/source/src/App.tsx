import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { indexNodes, MORNING_TRIAGE, REKEYED, type NodeState } from "./flow.ts"
import { LIBRARY, type LibraryFlow } from "./library.ts"
import { ACT_META, ACT_STARTS, FRAMES, type Act, type Frame } from "./script.ts"
import { Canvas } from "./components/Canvas.tsx"
import { Chat } from "./components/Chat.tsx"
import {
  IconChevron,
  IconDispatch,
  IconFlows,
  IconHistory,
  IconKey,
  IconMoon,
  IconPause,
  IconPlay,
  IconRestart,
  IconSun,
  IconUser,
  IconWiki
} from "./components/Icons.tsx"
import { Drawer } from "./components/Drawer.tsx"

const RAIL = [
  { id: "wiki", label: "Wiki", Icon: IconWiki },
  { id: "dispatcher", label: "Dispatcher", Icon: IconDispatch },
  { id: "flows", label: "Flows", Icon: IconFlows },
  { id: "secrets", label: "Secrets", Icon: IconKey },
  { id: "history", label: "History", Icon: IconHistory },
  { id: "account", label: "Account", Icon: IconUser }
] as const

const SPEEDS = [1, 1.5, 2] as const

/** A library flow opens on its last settled run. */
const settledFrame = (flow: LibraryFlow): Frame => ({
  act: 2,
  ms: 0,
  label: flow.verdict,
  mode: "run",
  nodes: flow.settled as Record<string, NodeState>,
  captions: {},
  attempts: {},
  settled: Object.fromEntries(flow.nodes.map((node) => [node.id, node.ms])),
  activeEdges: [],
  doneEdges: [],
  chat: [],
  selected: null,
  cursor: null,
  hud: null,
  focus: null,
  zoom: 0.8
})

export const App = () => {
  const [index, setIndex] = useState(0)
  const [playing, setPlaying] = useState(true)
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1)
  const [pick, setPick] = useState<string | null>(null)
  const [dark, setDark] = useState(true)
  const [flowId, setFlowId] = useState<string>(MORNING_TRIAGE.id)
  const [menu, setMenu] = useState(false)
  const timer = useRef<number | undefined>(undefined)

  const library = LIBRARY.find((flow) => flow.id === flowId)
  const spec = library ?? MORNING_TRIAGE
  const scripted = library === undefined
  const demoFrame = FRAMES[index]
  const frame = useMemo(() => (library ? { ...settledFrame(library), chat: demoFrame.chat } : demoFrame), [library, demoFrame])
  const nodesById = useMemo(() => indexNodes(spec), [spec])
  const last = index >= FRAMES.length - 1

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light"
  }, [dark])

  useEffect(() => {
    if (!playing || last || !scripted) return
    timer.current = window.setTimeout(() => setIndex((value) => value + 1), frame.ms / speed)
    return () => window.clearTimeout(timer.current)
  }, [playing, index, frame.ms, speed, last, scripted])

  useEffect(() => {
    if (last) setPlaying(false)
  }, [last])

  const jump = useCallback((act: Act) => {
    setFlowId(MORNING_TRIAGE.id)
    setPick(null)
    setIndex(ACT_STARTS[act])
    setPlaying(true)
  }, [])

  const restart = useCallback(() => {
    setPick(null)
    setIndex(0)
    setPlaying(true)
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === " ") {
        event.preventDefault()
        setPlaying((value) => !value)
      }
      if (event.key === "ArrowRight") setIndex((value) => Math.min(FRAMES.length - 1, value + 1))
      if (event.key === "ArrowLeft") setIndex((value) => Math.max(0, value - 1))
      if (event.key === "1" || event.key === "2" || event.key === "3") jump(Number(event.key) as Act)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [jump])

  const selected = pick ?? (scripted ? frame.selected : null)
  const meta = ACT_META[frame.act - 1]
  const elapsedShare = useMemo(() => index / (FRAMES.length - 1), [index])

  return (
    <div className="app">
      <nav className="rail" aria-label="Smithers">
        <span className="rail-mark" aria-hidden="true">S</span>
        {RAIL.map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            className="rail-btn"
            data-active={id === "flows" ? "true" : undefined}
            title={label}
            aria-label={label}
          >
            <Icon />
          </button>
        ))}
        <span className="rail-spacer" />
        <button
          type="button"
          className="rail-btn"
          onClick={() => setDark((value) => !value)}
          title={dark ? "Light" : "Dark"}
          aria-label={dark ? "Switch to light" : "Switch to dark"}
        >
          {dark ? <IconSun /> : <IconMoon />}
        </button>
      </nav>

      <main className="main">
        <header className="topbar">
          <div className="crumbs">
            <span>tevm</span>
            <span aria-hidden="true">/</span>
            <strong>tevm-monorepo</strong>
            <span className="crumb-branch">main</span>
          </div>
          <div className="acts" role="tablist" aria-label="Acts">
            {ACT_META.map((item) => (
              <button
                key={item.act}
                type="button"
                role="tab"
                aria-selected={frame.act === item.act}
                className="act-chip"
                data-active={frame.act === item.act ? "true" : undefined}
                onClick={() => jump(item.act)}
              >
                <span className="act-n">{item.act}</span>
                {item.title}
              </button>
            ))}
          </div>
          <div className="topbar-right">
            <span className="act-blurb">{meta.blurb}</span>
          </div>
        </header>

        <div className="split">
          <section className="chat-col" aria-label="Chat">
            <Chat items={frame.chat} />
          </section>

          <section className="pane" aria-label="Flow canvas">
            <div className="pane-canvas">
              <Canvas spec={spec} verdict={library?.verdict} frame={frame} selected={selected} onSelect={setPick} />

              <div className="flowpick">
                <button type="button" className="fl-panel flowpick-btn" onClick={() => setMenu((value) => !value)} aria-expanded={menu}>
                  <span className="fl-panel-name">{spec.title}</span>
                  {scripted ? (
                    <span className="fl-panel-mode" data-mode={frame.mode}>
                      {frame.mode === "draft" ? "drafting" : frame.mode === "run" ? "running" : "re-key"}
                    </span>
                  ) : null}
                  <IconChevron />
                </button>
                {menu ? (
                  <ul className="flowpick-menu" role="listbox">
                    {[MORNING_TRIAGE, ...LIBRARY].map((flow) => (
                      <li key={flow.id}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={flow.id === flowId}
                          data-active={flow.id === flowId ? "true" : undefined}
                          onClick={() => { setFlowId(flow.id); setMenu(false); setPick(null); if (flow.id !== MORNING_TRIAGE.id) setPlaying(false) }}
                        >
                          <strong>{flow.summary}</strong>
                          <code>{flow.pattern ? `${flow.pattern}.make` : "flows/morning-triage/flow.ts"}</code>
                          <span>{flow.nodes.filter((node) => node.kind !== "trigger").length} nodes</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </div>
            <Drawer
              key={`${spec.id}/${selected}`}
              spec={selected ? nodesById[selected] ?? null : null}
              state={selected ? frame.nodes[selected] : undefined}
              rekeyed={Boolean(scripted && selected && frame.act === 3 && REKEYED.includes(selected))}
              settledMs={selected ? frame.settled[selected] : undefined}
              scripted={scripted}
              onClose={() => setPick(null)}
              onSelect={(id) => { if (nodesById[id]) setPick(id) }}
            />
          </section>
        </div>

        <footer className="transport">
          <button
            type="button"
            className="icon-btn icon-btn-solid"
            onClick={() => (last ? restart() : setPlaying((value) => !value))}
            aria-label={last ? "Restart" : playing ? "Pause" : "Play"}
          >
            {last ? <IconRestart /> : playing ? <IconPause /> : <IconPlay />}
          </button>
          <button type="button" className="icon-btn" onClick={restart} aria-label="Restart">
            <IconRestart />
          </button>

          <div className="scrub">
            <input
              type="range"
              min={0}
              max={FRAMES.length - 1}
              value={index}
              onChange={(event) => {
                setPlaying(false)
                setPick(null)
                setIndex(Number(event.target.value))
              }}
              aria-label="Scrub the demo"
              style={{ ["--fill" as string]: `${elapsedShare * 100}%` }}
            />
            <div className="scrub-marks" aria-hidden="true">
              {ACT_META.map((item) => (
                <span
                  key={item.act}
                  style={{ left: `${(ACT_STARTS[item.act] / (FRAMES.length - 1)) * 100}%` }}
                />
              ))}
            </div>
          </div>

          <span className="transport-label">{frame.label}</span>

          <div className="speeds" role="group" aria-label="Speed">
            {SPEEDS.map((value) => (
              <button
                key={value}
                type="button"
                className="speed"
                data-active={speed === value ? "true" : undefined}
                onClick={() => setSpeed(value)}
              >
                {value}×
              </button>
            ))}
          </div>
        </footer>
      </main>
    </div>
  )
}

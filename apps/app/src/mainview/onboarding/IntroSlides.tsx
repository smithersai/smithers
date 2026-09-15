import { useCallback, useRef, type CSSProperties } from "react"
import { useLiveQuery } from "@tanstack/react-db"
import { X } from "lucide-react"
import { useController } from "../ControllerContext"
import { librarianLaunchFor } from "../state/LibrarianLaunch"
import type { GuideState } from "../state/AppState"
import { GuideButton, GUIDE_KEYS } from "./GuideButton"
import { INTRO_SLIDES, type IntroKind } from "./introScript"
import { bindPressActions, type PressAction } from "../runtime/PressActions"

type IntroDispatch = (action: "intro-next" | "intro-back" | "intro-close") => void

/* Inline, self-contained scenes: currentColor follows the slideshow's accent tokens. */
function Illustration({ kind, index }: { kind: IntroKind; index: number }) {
  if (kind === "wiki") {
    if (index === 0) return (
      /* Smithers scans the repository's files. */
      <svg className="guide-intro-art" viewBox="0 0 320 190" aria-hidden="true">
        <rect x="66" y="38" width="120" height="132" rx="10" className="art-sheet art-back" />
        <rect x="80" y="30" width="120" height="140" rx="10" className="art-sheet art-back" />
        <rect x="94" y="22" width="120" height="146" rx="10" className="art-sheet" />
        <rect x="110" y="42" width="64" height="7" rx="3.5" className="art-line art-strong" />
        <rect x="110" y="62" width="88" height="5" rx="2.5" className="art-line" />
        <rect x="110" y="76" width="72" height="5" rx="2.5" className="art-line" />
        <rect x="110" y="90" width="88" height="5" rx="2.5" className="art-line" />
        <rect x="110" y="104" width="56" height="5" rx="2.5" className="art-line" />
        <rect x="110" y="122" width="88" height="5" rx="2.5" className="art-line" />
        <rect x="110" y="136" width="70" height="5" rx="2.5" className="art-line" />
        <rect x="86" y="26" width="136" height="4" rx="2" className="art-scan" />
        {[[248, 62], [268, 102], [248, 142]].map(([x, y], i) => (
          <g key={i} className="art-check" style={{ "--d": `${0.5 + i * 0.45}s` } as CSSProperties}>
            <circle cx={x} cy={y} r="11" />
            <path d={`M${x - 4.5} ${y} l3 3 l6 -6`} />
          </g>
        ))}
      </svg>
    )
    if (index === 1) return (
      /* Folders become pages that list their files. */
      <svg className="guide-intro-art" viewBox="0 0 320 190" aria-hidden="true">
        <g>
          <path d="M52 46 a8 8 0 0 1 8 -8 h34 l16 16 v82 a8 8 0 0 1 -8 8 h-42 a8 8 0 0 1 -8 -8 z" className="art-sheet" />
          <path d="M94 38 v14 a4 4 0 0 0 4 4 h12" className="art-edge" />
          <rect x="62" y="70" width="36" height="5" rx="2.5" className="art-line" />
          <rect x="62" y="84" width="28" height="5" rx="2.5" className="art-line" />
          <rect x="62" y="98" width="36" height="5" rx="2.5" className="art-line" />
        </g>
        <path d="M126 95 h34" className="art-arrow" />
        <path d="M154 89 l10 6 -10 6" className="art-arrow" fill="none" />
        <g className="art-page" style={{ "--d": "0.25s" } as CSSProperties}>
          <rect x="182" y="28" width="104" height="62" rx="8" className="art-sheet art-page-fill" />
          <rect x="194" y="42" width="48" height="6" rx="3" className="art-line art-on-fill" />
          <rect x="194" y="58" width="80" height="4" rx="2" className="art-line art-on-fill" />
          <rect x="194" y="70" width="64" height="4" rx="2" className="art-line art-on-fill" />
        </g>
        <g className="art-page" style={{ "--d": "0.55s" } as CSSProperties}>
          <rect x="182" y="102" width="104" height="62" rx="8" className="art-sheet art-page-fill" />
          <rect x="194" y="116" width="48" height="6" rx="3" className="art-line art-on-fill" />
          <rect x="194" y="132" width="80" height="4" rx="2" className="art-line art-on-fill" />
          <rect x="194" y="144" width="64" height="4" rx="2" className="art-line art-on-fill" />
        </g>
        <path d="M234 90 v12" className="art-link" />
        <circle cx="234" cy="95" r="3.5" className="art-knot" />
      </svg>
    )
    if (index === 2) return (
      /* One index page links to each folder page. */
      <svg className="guide-intro-art" viewBox="0 0 320 190" aria-hidden="true">
        <path d="M160 95 L82 52 M160 95 L238 52 M160 95 L70 142 M160 95 L250 142" className="art-edge" />
        <circle cx="82" cy="52" r="10" className="art-node" style={{ "--d": "0s" } as CSSProperties} />
        <circle cx="238" cy="52" r="10" className="art-node" style={{ "--d": "0.4s" } as CSSProperties} />
        <circle cx="70" cy="142" r="10" className="art-node" style={{ "--d": "0.8s" } as CSSProperties} />
        <circle cx="250" cy="142" r="10" className="art-node" style={{ "--d": "1.2s" } as CSSProperties} />
        <circle cx="160" cy="95" r="16" className="art-node art-hub" />
        <circle cx="160" cy="95" r="16" className="art-ring" />
      </svg>
    )
    return (
      /* Every page points back to the commit it was built from. */
      <svg className="guide-intro-art" viewBox="0 0 320 190" aria-hidden="true">
        <rect x="58" y="36" width="104" height="120" rx="10" className="art-sheet" />
        <rect x="74" y="54" width="56" height="7" rx="3.5" className="art-line art-strong" />
        <rect x="74" y="74" width="72" height="5" rx="2.5" className="art-line" />
        <rect x="74" y="88" width="60" height="5" rx="2.5" className="art-line" />
        <rect x="74" y="102" width="72" height="5" rx="2.5" className="art-line" />
        <rect x="74" y="126" width="40" height="5" rx="2.5" className="art-line art-accent-2" />
        <path d="M118 128 C 170 128, 190 96, 222 96" className="art-link" />
        <circle cx="118" cy="128" r="3.5" className="art-knot" />
        <path d="M196 96 h84" className="art-trail art-fade" />
        <circle cx="236" cy="96" r="12" className="art-commit" style={{ "--d": "0.3s" } as CSSProperties} />
        <rect x="214" y="122" width="44" height="5" rx="2.5" className="art-line art-strong" />
        <rect x="220" y="134" width="32" height="4" rx="2" className="art-line art-fade" />
      </svg>
    )
  }
  if (index === 0) return (
    /* Today's files, captured as one snapshot. */
    <svg className="guide-intro-art" viewBox="0 0 320 190" aria-hidden="true">
      <rect x="104" y="46" width="96" height="112" rx="10" className="art-sheet art-back" />
      <rect x="116" y="38" width="96" height="116" rx="10" className="art-sheet art-back" />
      <rect x="128" y="30" width="96" height="120" rx="10" className="art-sheet" />
      <rect x="142" y="50" width="52" height="6" rx="3" className="art-line art-strong" />
      <rect x="142" y="68" width="68" height="5" rx="2.5" className="art-line" />
      <rect x="142" y="82" width="56" height="5" rx="2.5" className="art-line" />
      <rect x="142" y="96" width="68" height="5" rx="2.5" className="art-line" />
      <rect x="142" y="110" width="44" height="5" rx="2.5" className="art-line" />
      <path d="M84 40 v-16 h16 M236 24 h16 v16 M252 150 v16 h-16 M100 166 h-16 v-16" className="art-edge" />
      <rect x="86" y="26" width="164" height="4" rx="2" className="art-scan" />
    </svg>
  )
  if (index === 1) return (
    /* The snapshot becomes one commit on a fresh mythical branch. */
    <svg className="guide-intro-art" viewBox="0 0 320 190" aria-hidden="true">
      <rect x="40" y="52" width="80" height="96" rx="9" className="art-sheet" />
      <rect x="52" y="70" width="44" height="5" rx="2.5" className="art-line art-strong" />
      <rect x="52" y="84" width="56" height="4" rx="2" className="art-line" />
      <rect x="52" y="96" width="48" height="4" rx="2" className="art-line" />
      <rect x="52" y="108" width="56" height="4" rx="2" className="art-line" />
      <path d="M134 100 h30" className="art-arrow" />
      <path d="M158 94 l10 6 -10 6" className="art-arrow" fill="none" />
      <path d="M190 100 h96" className="art-myth" />
      <path className="art-star" style={{ "--d": "0.4s" } as CSSProperties} d="M228 83.8 l4.68 9.72 10.62 1.44 -7.74 7.38 1.8 10.44 -9.36 -5.04 -9.36 5.04 1.8 -10.44 -7.74 -7.38 10.62 -1.44 z" />
      <rect x="204" y="124" width="52" height="5" rx="2.5" className="art-line art-accent-2" />
    </svg>
  )
  if (index === 2) return (
    /* The source branch keeps every commit; the mythical branch stands apart. */
    <svg className="guide-intro-art" viewBox="0 0 320 190" aria-hidden="true">
      <path d="M34 66 h252" className="art-trail" />
      {[[54, 66], [110, 66], [166, 66], [230, 66], [286, 66]].map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r="7" className="art-commit" style={{ "--d": `${i * 0.12}s` } as CSSProperties} />
      ))}
      <rect x="40" y="40" width="44" height="4" rx="2" className="art-line art-fade" />
      <path d="M150 132 h136" className="art-myth" />
      <path className="art-star" style={{ "--d": "0.6s" } as CSSProperties} d="M200 115.8 l4.68 9.72 10.62 1.44 -7.74 7.38 1.8 10.44 -9.36 -5.04 -9.36 5.04 1.8 -10.44 -7.74 -7.38 10.62 -1.44 z" />
      <rect x="222" y="152" width="64" height="4" rx="2" className="art-line art-accent-2" />
    </svg>
  )
  return (
    /* A note on the snapshot names its source commit and tree. */
    <svg className="guide-intro-art" viewBox="0 0 320 190" aria-hidden="true">
      <path d="M40 124 h96" className="art-myth" />
      <path className="art-star" style={{ "--d": "0.2s" } as CSSProperties} d="M92 107.8 l4.68 9.72 10.62 1.44 -7.74 7.38 1.8 10.44 -9.36 -5.04 -9.36 5.04 1.8 -10.44 -7.74 -7.38 10.62 -1.44 z" />
      <path d="M104 116 C 136 94, 156 74, 184 68" className="art-link" />
      <circle cx="104" cy="116" r="3.5" className="art-knot" />
      <g className="art-page" style={{ "--d": "0.4s" } as CSSProperties}>
        <rect x="186" y="36" width="104" height="96" rx="8" className="art-sheet" />
        <rect x="198" y="52" width="52" height="6" rx="3" className="art-line art-strong" />
        <rect x="198" y="68" width="80" height="4" rx="2" className="art-line" />
        <rect x="198" y="80" width="64" height="4" rx="2" className="art-line" />
        <rect x="198" y="92" width="72" height="4" rx="2" className="art-line" />
        <rect x="198" y="110" width="40" height="4" rx="2" className="art-line art-accent-2" />
      </g>
    </svg>
  )
}

/** One slideshow: the art and words of the current slide, gated by Next, over the building run. */
export function IntroSlides({ kind, index, guide, dispatch }: {
  kind: IntroKind; index: number; guide: GuideState; dispatch: IntroDispatch
}) {
  const slides = INTRO_SLIDES[kind]
  const slide = slides[index] ?? slides[0]
  const last = index >= slides.length - 1
  /* The run's own durable launch receipt drives the chip; no parallel state. */
  const phase = librarianLaunchFor(guide, kind)?.phase
  const chip = phase === "started" ? "Started" : phase === "failed" ? "Failed" : "Building…"
  /* The mount ref survives slide changes; the resolve closure reads the latest slide. */
  const state = useRef({ index, dispatch })
  state.current = { index, dispatch }
  const mount = useCallback((node: HTMLDialogElement | null) => {
    if (!node) return
    if (!node.open) node.showModal()
    node.querySelector<HTMLElement>("[data-intro-next]")?.focus()
    const resolve = (event: KeyboardEvent): PressAction | undefined => {
      if (event.isComposing || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
      const { index: at, dispatch: act } = state.current
      const button = (selector: string) => node.querySelector<HTMLElement>(selector) ?? undefined
      if (event.key === "ArrowRight" || event.key === "Enter") return { element: button("[data-intro-next]"), activate: () => act("intro-next") }
      if (event.key === GUIDE_KEYS.back && at > 0) return { element: button("[data-intro-back]"), activate: () => act("intro-back") }
      if (event.key === "Escape") return { element: button("[data-intro-close]"), activate: () => act("intro-close") }
    }
    const stop = bindPressActions({ root: node, resolveShortcut: resolve })
    /* Modal Tab cycle, the same shape as the composer dock's. */
    const tab = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || event.defaultPrevented) return
      const controls = [...node.querySelectorAll<HTMLElement>("button, [tabindex]")]
        .filter(control => control.tabIndex >= 0 && !control.matches(":disabled") && !control.closest("[hidden], [inert]"))
      const first = controls[0], lastControl = controls.at(-1)
      const next = event.shiftKey && node.ownerDocument.activeElement === first ? lastControl
        : !event.shiftKey && node.ownerDocument.activeElement === lastControl ? first : undefined
      if (next) { event.preventDefault(); next.focus() }
    }
    node.addEventListener("keydown", tab)
    const flow = kind === "wiki" ? "wiki.create" : "history.bootstrap"
    return () => {
      stop()
      node.removeEventListener("keydown", tab)
      /* Focus returns to the pill that launched this introduction. */
      const launcher = node.ownerDocument.querySelector<HTMLElement>(`.guide-actions [data-flow="${flow}"]`)
      ;(launcher ?? node.ownerDocument.querySelector<HTMLElement>(".guide-shell"))?.focus()
    }
  }, [kind])
  return (
    <dialog
      className="guide-intro-dock"
      data-intro={kind}
      role="dialog"
      aria-modal="true"
      aria-labelledby="guide-intro-heading"
      ref={mount}
      onCancel={event => event.preventDefault()}
      onPointerDown={event => {
        if (event.target === event.currentTarget) {
          event.preventDefault()
          dispatch("intro-close")
        }
      }}
      onMouseDown={event => {
        if (event.target === event.currentTarget) event.preventDefault()
      }}
    >
      <section className="guide-intro-card">
        <header className="guide-intro-head">
          <span className="guide-intro-chip" role="status" data-phase={phase ?? "building"}>{chip}</span>
          <GuideButton className="guide-intro-close" data-intro-close="" shortcut="Escape" aria-label="Close introduction"
            onClick={() => dispatch("intro-close")}>
            <X size={15} aria-hidden="true" />
          </GuideButton>
        </header>
        <div className="guide-intro-figure" key={`${kind}:${index}`}>
          <Illustration kind={kind} index={index} />
        </div>
        <h2 className="guide-intro-heading" id="guide-intro-heading">{slide.headline}</h2>
        <p className="guide-intro-caption">{slide.caption}</p>
        <div className="guide-intro-dots" role="group" aria-label={`Slide ${index + 1} of ${slides.length}`}>
          {slides.map((entry, dot) => <span key={entry.id} data-current={dot === index || undefined} />)}
        </div>
        <div className="guide-intro-controls">
          <GuideButton className="guide-intro-back" data-intro-back="" shortcut={GUIDE_KEYS.back} disabled={index === 0}
            onClick={() => dispatch("intro-back")}>
            Back
          </GuideButton>
          <GuideButton className="guide-primary guide-intro-next" data-intro-next="" shortcut="ArrowRight"
            onClick={() => dispatch("intro-next")}>
            {last ? "Back to tutorial" : "Next"}
          </GuideButton>
        </div>
      </section>
    </dialog>
  )
}

/** Standalone projection, like the reel: the guide record owns which introduction is open. */
export function IntroSlidesShell() {
  const controller = useController()
  const { data: sessions } = useLiveQuery(controller.store.collections.sessions)
  const guide = sessions[0]?.guide
  const open = guide?.introSlides
  const dispatch = useCallback<IntroDispatch>((action) => {
    controller.runCommand("onboarding.act", action)
  }, [controller])
  if (!guide || open === undefined) return null
  return <IntroSlides kind={open.kind} index={open.index} guide={guide} dispatch={dispatch} />
}

/*
 * The GitHub anatomy the issue and PR cards share, ported from multi's
 * src/components/github (primitives.tsx, state.ts, CommentCard.tsx,
 * MetadataSidebar.tsx): the state glyph and pill, label pills in their
 * colors, initials avatars, relative time, the bordered comment box with its
 * avatar gutter, and the metadata sidebar section. Styles: styles/github-cards.css.
 */
import type { CSSProperties, ReactNode } from "react"
import { trustedHttpsUrl } from "../state/seams/SeamContext"
import { Octicon, type OcticonName } from "./Octicon"

/** A person the forge names; the avatar URL is followed only on avatars.githubusercontent.com. */
export interface Person {
  readonly login: string
  readonly avatarUrl?: string | null
}

export type Tone = "open" | "done" | "closed" | "draft" | "queued"

export interface StateDisplay {
  readonly icon: OcticonName
  readonly tone: Tone
  readonly label: string
}

/** Open is green; closed is GitHub's purple "completed". */
export const issueDisplay = (state: "open" | "closed"): StateDisplay =>
  state === "open"
    ? { icon: "issue-opened", tone: "open", label: "Open" }
    : { icon: "issue-closed", tone: "done", label: "Closed" }

/** The platform's landing state word to GitHub's PR states; a land is "queued", never "merged". */
export const prDisplay = (state: string, draft = false): StateDisplay => {
  const word = state.toLowerCase()
  if (word === "merged") return { icon: "git-merge", tone: "done", label: "Merged" }
  if (word === "landed") return { icon: "git-merge", tone: "done", label: "Landed" }
  if (word === "closed") return { icon: "git-pull-request-closed", tone: "closed", label: "Closed" }
  if (word === "queued") return { icon: "git-merge", tone: "queued", label: "Queued" }
  if (draft || word === "draft") return { icon: "git-pull-request-draft", tone: "draft", label: "Draft" }
  if (word === "open" || word === "") return { icon: "git-pull-request", tone: "open", label: "Open" }
  return { icon: "git-pull-request", tone: "open", label: `${state.charAt(0).toUpperCase()}${state.slice(1)}` }
}

/** A check's state word to its glyph: passed, failed, or still running. */
export const checkDisplay = (state: string): StateDisplay => {
  const word = state.toLowerCase()
  if (["success", "succeeded", "passed", "pass", "completed", "ok"].includes(word)) return { icon: "check-circle-fill", tone: "open", label: state }
  if (["failure", "failed", "fail", "error", "errored", "cancelled", "canceled", "timed_out"].includes(word)) return { icon: "x-circle-fill", tone: "closed", label: state }
  return { icon: "dot-fill", tone: "queued", label: state }
}

/** The leading 16px state glyph of a list row. */
export const StateIcon = ({ display }: { readonly display: StateDisplay }) => (
  <span className={`ghc-state-icon ghc-tone-${display.tone}`} data-tone={display.tone}>
    <Octicon name={display.icon} label={display.label} />
  </span>
)

/** The filled state badge of a detail header. */
export const StatePill = ({ display }: { readonly display: StateDisplay }) => (
  <span className={`ghc-pill ghc-pill-${display.tone}`} data-tone={display.tone}>
    <Octicon name={display.icon} />
    {display.label}
  </span>
)

/* GitHub's default label colors; any other name hashes to a stable hue. */
const DEFAULT_LABEL_COLORS: Readonly<Record<string, string>> = {
  bug: "#d73a4a",
  documentation: "#0075ca",
  duplicate: "#cfd3d7",
  enhancement: "#a2eeef",
  "good first issue": "#7057ff",
  "help wanted": "#008672",
  invalid: "#e4e669",
  question: "#d876e3",
  wontfix: "#ffffff"
}

const hue = (text: string): number => {
  let hash = 0
  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return hash % 360
}

/** The label's color: the forge's hex when it carried one, GitHub's default, or a hashed hue. */
export const labelColor = (name: string, color?: string | null): string => {
  if (color != null && /^#?[0-9a-fA-F]{6}$/.test(color)) return color.startsWith("#") ? color : `#${color}`
  return DEFAULT_LABEL_COLORS[name.toLowerCase()] ?? `hsl(${hue(name)} 55% 50%)`
}

/** One label pill. `world-card-label` and `data-label` stay for the tutorial's selectors. */
export const LabelPill = ({ name, color }: { readonly name: string; readonly color?: string | null }) => (
  <span
    className="world-card-label ghc-label"
    data-label={name}
    title={name}
    style={{ "--ghc-label": labelColor(name, color) } as CSSProperties}
  >
    {name}
  </span>
)

const initials = (name: string): string => {
  const words = name.trim().split(/[\s._-]+/).filter((word) => word !== "")
  return (words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : (words[0] ?? "?").slice(0, 1)).toUpperCase()
}

/** A round avatar: the forge's image on its own host, else initials on a hashed hue. */
export const Avatar = ({ person, size = 20 }: { readonly person: Person; readonly size?: number }) => {
  /* A data: image (the practice bundle's avatars) or an https image on GitHub's avatar host; nothing else is fetched. */
  const src = person.avatarUrl == null ? null :
    person.avatarUrl.startsWith("data:image/") ? person.avatarUrl :
    trustedHttpsUrl(person.avatarUrl, "avatars.githubusercontent.com")
  const dim: CSSProperties = { width: size, height: size }
  return src !== null ?
    <img className="ghc-avatar" style={dim} src={src} alt={`@${person.login}`} loading="lazy" /> :
    (
      <span
        className="ghc-avatar ghc-avatar-fallback"
        style={{ ...dim, fontSize: Math.round(size * 0.42), "--ghc-avatar-hue": hue(person.login) } as CSSProperties}
        role="img"
        aria-label={`@${person.login}`}
        title={person.login}
      >
        {initials(person.login)}
      </span>
    )
}

export const AvatarStack = ({ people, size = 20 }: { readonly people: ReadonlyArray<Person>; readonly size?: number }) => (
  <span className="ghc-avatar-stack" title={`Assigned to ${people.map((person) => person.login).join(", ")}`}>
    {people.slice(0, 4).map((person) => <Avatar key={person.login} person={person} size={size} />)}
  </span>
)

const UNITS: ReadonlyArray<readonly [Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 31_536_000],
  ["month", 2_592_000],
  ["week", 604_800],
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60]
]

/** "3 weeks ago"; past a year, the date. A string that is not a timestamp passes through. */
export const relativeTime = (iso: string, now: number = Date.now()): string => {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return iso
  const seconds = Math.round((then - now) / 1000)
  const abs = Math.abs(seconds)
  if (abs < 45) return "just now"
  if (abs >= 31_536_000) return `on ${new Date(then).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`
  const format = new Intl.RelativeTimeFormat("en", { numeric: "auto" })
  for (const [unit, size] of UNITS) if (abs >= size) return format.format(Math.round(seconds / size), unit)
  return format.format(seconds, "second")
}

export const RelativeTime = ({ iso }: { readonly iso: string }) => (
  <time className="ghc-time" dateTime={iso} title={iso.replace("T", " ").slice(0, 16)}>{relativeTime(iso)}</time>
)

/** The comment box: avatar gutter, a header (author · verb · time), and the body. */
export const CommentBox = ({
  author,
  avatarUrl,
  createdAt,
  verb,
  children
}: {
  readonly author: string | null
  readonly avatarUrl?: string | null | undefined
  readonly createdAt?: string | null | undefined
  readonly verb: string
  readonly children: ReactNode
}) => (
  <div className="ghc-comment">
    <Avatar person={{ login: author ?? "?", avatarUrl }} size={32} />
    <div className="ghc-bubble">
      <div className="ghc-comment-head">
        <strong className="ghc-author">{author ?? "Someone"}</strong>
        <span>{verb}</span>
        {createdAt != null ? <RelativeTime iso={createdAt} /> : null}
      </div>
      <div className="ghc-comment-body">{children}</div>
    </div>
  </div>
)

/** One metadata sidebar section: a heading, then values or a muted empty line. */
export const SideSection = ({
  title,
  empty = "None yet",
  children
}: {
  readonly title: string
  readonly empty?: string
  readonly children?: ReactNode
}) => {
  const isEmpty = children == null || children === false || (Array.isArray(children) && children.length === 0)
  return (
    <section className="ghc-side-section" aria-label={title}>
      <h4 className="ghc-side-title">{title}</h4>
      <div className="ghc-side-body">{isEmpty ? <span className="ghc-side-empty">{empty}</span> : children}</div>
    </section>
  )
}

/** Assignees and reviewers as the rpc card schema carries them ({ login, avatar }). */
export const people = (rows: ReadonlyArray<{ readonly login: string; readonly avatar?: string | undefined }> | undefined): ReadonlyArray<Person> =>
  (rows ?? []).map((row) => ({ login: row.login, avatarUrl: row.avatar ?? null }))

/** The practice key reads as its repository name. */
export const repoLabel = (repo: string): string => repo.replace(/^practice:/, "")

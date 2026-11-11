/**
 * The dialogs: the Ctrl+K palette and every picker. What each lists, its
 * title and empty line, and the palette's background `text:` and `session:`
 * reads. The dialog itself draws in `app-view.tsx`; picking stays in the app.
 */
import { useEffect, useRef, useState } from "react"
import * as Catalog from "./catalog.ts"
import * as Editor from "./editor.ts"
import * as Failures from "./failures.ts"
import * as Fuzzy from "./fuzzy.ts"
import type * as Models from "./models.ts"
import * as Palette from "./palette.ts"
import * as Search from "./search.ts"
import * as Session from "./session.ts"
import { color } from "./theme.ts"
import * as Timeline from "./timeline.ts"
import * as Timer from "./timer.ts"
import * as Undo from "./undo.ts"
import * as View from "./view.tsx"
import type { Tab } from "./workspace.ts"

export type Picker =
  | { readonly kind: "model"; readonly query: string; readonly selected: number }
  | {
    readonly kind: "stop"
    readonly id: string
    readonly title: string
    readonly run: string
    readonly query: ""
    readonly selected: number
  }
  | { readonly kind: "worker-model"; readonly id: string; readonly query: string; readonly selected: number }
  | { readonly kind: "flows"; readonly query: string; readonly selected: number }
  | { readonly kind: "filter"; readonly query: string; readonly selected: number }
  | {
    readonly kind: "resume"
    readonly query: string
    readonly selected: number
    readonly sessions: ReadonlyArray<Session.Summary>
  }
  | {
    readonly kind: "palette"
    readonly query: string
    readonly selected: number
    /** Read on the first `session:`; undefined until then. */
    readonly sessions?: ReadonlyArray<Session.Summary>
  }
  | {
    readonly kind: "undo"
    readonly query: ""
    readonly selected: number
    /** The run's name: a worker's title, or a chat turn's prompt. */
    readonly title: string
    readonly plan: Undo.Plan
    /** The paths undo writes; a refused file is never checked. */
    readonly checked: ReadonlySet<string>
    /** The worker whose run this is; the chat's own turn otherwise. */
    readonly tab?: string
  }

/** A `text:` search in the palette, from launch through its real settlement. */
export interface TextSearch {
  readonly query: string
  readonly startedAt: number
  readonly status: "running" | "done"
  readonly hits: ReadonlyArray<Search.Hit>
  /** rg stopped at `Search.limit`. */
  readonly truncated: boolean
}

/** Read at render time, so a theme change repaints it. */
const lastTone = (status: Catalog.Last["status"]): string =>
  status === "done"
    ? color.success
    : status === "failed"
    ? color.danger
    : status === "running"
    ? color.info
    : color.faint

/** A dialog's rows and the value each one picks. */
export const rows = (
  picker: Picker,
  models: ReadonlyArray<Models.Model>,
  seat: string,
  filter: Timeline.Filter,
  tabs: ReadonlyArray<Tab>,
  files: () => ReadonlyArray<string>,
  hits: ReadonlyArray<Search.Hit>,
  catalog: ReadonlyArray<Catalog.Entry>,
  actions: NonNullable<Palette.Sources["actions"]> = [],
  acts: ReadonlyArray<Palette.ActRow> = [],
  /** Whether a model's account ran out of credit this session. */
  spent: (seat: string) => boolean = () => false,
  now = Date.now()
): ReadonlyArray<View.Row & { readonly value: string }> => {
  if (picker.kind === "flows") {
    // The selected row says what the flow does; the rest stay one short line each.
    return Fuzzy.filter(catalog, picker.query, (entry) => entry.name).map((entry, index) => ({
      key: entry.name,
      label: entry.name,
      hint: entry.hint,
      ...(index === picker.selected && !entry.unloaded ? { detail: entry.description } : {}),
      ...(entry.last === undefined ? {} : {
        aside: {
          mark: Catalog.mark(entry.last),
          tone: lastTone(entry.last.status),
          text: View.ago(entry.last.at, now)
        }
      }),
      value: entry.name
    }))
  }
  if (picker.kind === "palette") {
    const sources = {
      commands: Editor.commands,
      files,
      sessions: picker.sessions,
      tabs,
      hits,
      now: Date.now(),
      acts,
      actions
    }
    // The value is the JSON of a `Palette.Value`, so every dialog picks a string.
    return Palette.rows(Palette.parse(picker.query), sources).map((row) => ({
      ...row,
      value: JSON.stringify(row.value)
    }))
  }
  if (picker.kind === "filter") {
    const rows = Timeline.kinds.map(([kind, label]) => ({
      key: `kind:${kind}`,
      label,
      current: !filter.kinds.includes(kind),
      value: `kind:${kind}`
    }))
    return [
      // Always first, so toggling never moves the selected row.
      { key: "all", label: "Show all", value: "all" },
      ...Fuzzy.filter(rows, picker.query, (row) => row.label)
    ]
  }

  if (picker.kind === "model" || picker.kind === "worker-model") {
    const worker = picker.kind === "worker-model" ? tabs.find((tab) => tab.id === picker.id) : undefined
    const current = picker.kind === "model" ? seat : worker?.activeSeat ?? worker?.seat
    // Models with credit first; the rest say `no credit`.
    const listed = Fuzzy.filter(models, picker.query, (model) => `${model.label} ${model.seat} ${model.provider}`)
      .toSorted((a, b) => Number(spent(a.seat)) - Number(spent(b.seat)))
    const custom = picker.query.includes(":") && !models.some((model) => model.seat === picker.query)
    return [
      ...(custom ? [{ key: picker.query, label: picker.query, hint: "any seat", value: picker.query }] : []),
      ...listed.map((model) => ({
        key: model.seat,
        label: model.label,
        hint: model.provider,
        ...(spent(model.seat) ? { detail: "no credit" } : {}),
        current: model.seat === current,
        value: model.seat
      }))
    ]
  }
  if (picker.kind === "stop") {
    return [{ key: "stop", label: "Stop", value: "stop" }, { key: "cancel", label: "Cancel", value: "cancel" }]
  }
  if (picker.kind === "undo") {
    return picker.plan.entries.map((entry) => ({
      key: entry.path,
      label: `${picker.checked.has(entry.path) ? "[x]" : "[ ]"} ${entry.path}`,
      hint: entry.refused === undefined ? Undo.counts(entry) : Undo.words[entry.refused],
      value: entry.path
    }))
  }

  return Palette.sessionRows(picker.sessions, picker.query, Date.now()).map(({ file, ...row }) => ({
    ...row,
    value: file
  }))
}

/** The dialog's title; a capped `text:` search says so. */
export const title = (picker: Picker, truncated: boolean): string =>
  picker.kind === "model" || picker.kind === "worker-model"
    ? "Select model"
    : picker.kind === "flows"
    ? "Flows"
    : picker.kind === "filter"
    ? "Filter chat"
    : picker.kind === "palette"
    ? truncated ? `Search · first ${Search.limit}` : "Search"
    : picker.kind === "stop"
    ? `Stop ${picker.title}?`
    : picker.kind === "undo"
    ? `Undo ${picker.title}?`
    : "Resume session"

/** What the dialog says with no rows. */
export const empty = (picker: Picker, flows: () => string, searching: boolean): string =>
  picker.kind === "resume"
    ? "No sessions in this directory"
    : picker.kind === "flows"
    ? flows()
    : picker.kind === "palette"
    ? searching ? "Searching" : "No matches"
    : `No ${picker.kind} matches "${picker.query}"`

/**
 * The palette's background reads. `text:` runs rg; a newer query, leaving
 * text mode, or closing cancels it. `session:` reads the session files once
 * per palette opening.
 */
export const useSearch = (options: {
  readonly picker: Picker | undefined
  readonly setPicker: (update: (current: Picker | undefined) => Picker | undefined) => void
  readonly cwd: string
  readonly setStatus: (text: string, tone: "danger") => void
}) => {
  const { picker, setPicker, cwd, setStatus } = options
  const [search, setSearch] = useState<TextSearch | undefined>()
  const searchGeneration = useRef(0)
  const parsed = picker?.kind === "palette" ? Palette.parse(picker.query) : undefined
  const textQuery = parsed?.mode === "text" && parsed.query.length >= 2 ? parsed : undefined
  const textKey = textQuery === undefined ? "" : `${textQuery.query} ${textQuery.regex ?? ""}`
  useEffect(() => {
    const generation = ++searchGeneration.current
    setSearch(undefined)
    if (textQuery === undefined) return
    let running: ReturnType<typeof Search.run> | undefined
    const cancel = Timer.after(150, () => {
      running = Search.run({
        cwd,
        query: textQuery.query,
        ...(textQuery.regex === undefined ? {} : { regex: textQuery.regex })
      })
      setSearch({ query: textQuery.query, startedAt: Date.now(), status: "running", hits: [], truncated: false })
      void running.done.then((outcome) => {
        if (generation !== searchGeneration.current || outcome._tag === "cancelled") return
        if (outcome._tag === "done") {
          setSearch({
            query: textQuery.query,
            startedAt: 0,
            status: "done",
            hits: outcome.hits,
            truncated: outcome.truncated
          })
          return
        }
        setSearch(undefined)
        setStatus(Failures.line("search", Search.failure(outcome)), "danger")
      })
    })
    return () => {
      cancel()
      running?.cancel()
    }
  }, [textKey, cwd])

  const needsSessions = parsed?.mode === "sessions" && picker?.kind === "palette" && picker.sessions === undefined
  useEffect(() => {
    if (!needsSessions) return
    let sessions: ReadonlyArray<Session.Summary> = []
    try {
      sessions = Session.list(cwd)
    } catch (error) {
      setStatus(Failures.line("sessions", error), "danger")
    }
    setPicker((current) => (current?.kind === "palette" ? { ...current, sessions } : current))
  }, [needsSessions, cwd])
  return { search, parsed }
}

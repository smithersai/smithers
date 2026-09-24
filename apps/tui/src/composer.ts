/**
 * The composer: its draft and cursor, prompt history, the completion menu,
 * and where a submitted line goes. `route` is the one rule for that: a
 * steered worker, a `!` shell line, a `/` command, or a prompt.
 */
import type { CliRenderer, KeyBinding, TextareaRenderable } from "@opentui/core"
import { type MutableRefObject, useCallback, useEffect, useMemo, useRef, useState } from "react"
import * as Approvals from "./approvals.ts"
import * as Complete from "./complete.ts"
import * as Editor from "./editor.ts"
import * as Extension from "./extension.ts"
import * as External from "./external.ts"
import type { FlowRuns } from "./flows.ts"
import * as Log from "./log.ts"
import type * as Models from "./models.ts"
import * as Shell from "./shell.ts"

export const keys: Array<KeyBinding> = [
  { name: "return", action: "submit" },
  { name: "kpenter", action: "submit" },
  { name: "return", shift: true, action: "newline" },
  { name: "linefeed", action: "newline" }
]

export type Route =
  | { readonly _tag: "steer" }
  | { readonly _tag: "shell"; readonly command: string; readonly excluded: boolean }
  | { readonly _tag: "command" }
  | { readonly _tag: "prompt" }

/**
 * Where a submitted line goes. While a worker is steered, everything but a
 * shell line or a command goes to it. A `/` line that names no command is a
 * prompt; the caller learns that when the command refuses it.
 */
export const route = (text: string, steering: boolean): Route => {
  const shellLine = Shell.parse(text)
  if (steering && shellLine === undefined && !text.startsWith("/")) return { _tag: "steer" }
  if (shellLine !== undefined) return { _tag: "shell", command: shellLine.command, excluded: shellLine.excluded }
  if (text.startsWith("/")) return { _tag: "command" }
  return { _tag: "prompt" }
}

export const useComposer = (options: {
  readonly models: ReadonlyArray<Models.Model>
  readonly runs: FlowRuns
  /** Bumped by every store change; the menu re-lists flows and files on it. */
  readonly revision: number
  readonly files: MutableRefObject<() => ReadonlyArray<string>>
  /** Typing delays the approval row's keys; see `Approvals.Arming`. */
  readonly arming: MutableRefObject<Approvals.Arming>
  readonly prompts: ReadonlyArray<string>
}) => {
  const { models, runs, revision, files, arming } = options
  const composer = useRef<TextareaRenderable>(null)
  const [draft, setDraft] = useState("")
  const [cursor, setCursor] = useState(0)
  const [menuIndex, setMenuIndex] = useState(0)
  const [menuDismissed, setMenuDismissed] = useState(false)
  const history = useRef(new Editor.History(options.prompts))
  /** The draft a palette command with an argument displaced; restored by the next submit. */
  const parkedDraft = useRef<string | undefined>(undefined)

  const completion = useMemo(
    () => (menuDismissed
      ? undefined
      : Complete.complete(draft, cursor, {
        models,
        files: () => files.current(),
        flows: runs.listed,
        agents: () => runs.listed().filter(Extension.isAgent)
      })),
    [draft, cursor, menuDismissed, models, runs, revision]
  )
  const menu = completion !== undefined && (completion.items.length > 0 || completion.kind !== "file")
    ? completion
    : undefined
  const menuIdentity = menu === undefined ? "" : `${menu.kind}:${menu.query}`
  useEffect(() => setMenuIndex(0), [menuIdentity])

  const setText = useCallback((text: string, at?: number) => {
    const input = composer.current
    if (input === null) return
    input.setText(text)
    if (at === undefined) input.gotoBufferEnd()
    else input.cursorOffset = at
    arming.current = Approvals.edited(arming.current, Date.now())
    setDraft(text)
    setCursor(input.cursorOffset)
  }, [])

  /** Tab inserts the selected completion; Enter also runs it through `submit` when it is a whole command. */
  const accept = (open: Complete.Completion, index: number, run: boolean, submit: (text: string) => void) => {
    const input = composer.current
    if (input === null) return
    const suggestion = open.items[index]
    if (suggestion === undefined) return
    const next = Complete.apply(input.plainText, open, suggestion)
    if (run && suggestion.submit) return submit(next.text)
    setText(next.text, next.cursor)
  }

  /** Ctrl+G: the draft in $VISUAL or $EDITOR, with the terminal handed over until it exits. */
  const externalEditor = async (renderer: CliRenderer, setStatus: (text: string, tone: "warning") => void) => {
    const editor = process.env.VISUAL ?? process.env.EDITOR ?? "nano"
    renderer.suspend()
    let edited: string | undefined
    try {
      edited = await External.edit(composer.current?.plainText ?? "", editor)
    } catch (error) {
      Log.write("editor", error)
      setStatus("Editor unavailable", "warning")
    } finally {
      renderer.resume()
    }
    if (edited !== undefined) setText(edited)
  }

  /** The textarea's change handlers. */
  const onContentChange = () => {
    arming.current = Approvals.edited(arming.current, Date.now())
    setDraft(composer.current?.plainText ?? "")
    setCursor(composer.current?.cursorOffset ?? 0)
    setMenuDismissed(false)
  }
  const onCursorChange = () => setCursor(composer.current?.cursorOffset ?? 0)

  return {
    composer,
    draft,
    setText,
    history,
    parkedDraft,
    menu,
    menuIndex,
    setMenuIndex,
    dismissMenu: () => setMenuDismissed(true),
    accept,
    externalEditor,
    onContentChange,
    onCursorChange
  }
}

import { afterEach, expect, test } from "bun:test"
import { act } from "react"
import { EditorView } from "@codemirror/view"
import { syntaxTree } from "@codemirror/language"
import { StateEffect } from "@codemirror/state"
import { CodeEditorView, minimalChange } from "../src/adapters/code-editor"
const { createRoot } = await import("react-dom/client")
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const cleanups: (() => void)[] = []
afterEach(() => { while (cleanups.length) cleanups.pop()!() })
function mount(text = 'const emoji = "😀"\nsecond\nthird', language = "typescript") {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host), actions: unknown[] = [], lines: unknown[] = []
  const props = { path: 'x.ts', text, language, diagnostics: [], gestures: { hover: { tag: 'code.hover', label: 'Hover', args: { path: 'bound' } }, definition: { tag: 'code.definition', label: 'Go to definition' } }, onAction: (...args: unknown[]) => actions.push(args), onView: (patch: unknown) => lines.push(patch) }
  act(() => root.render(<CodeEditorView {...props} />))
  const view = EditorView.findFromDOM(host.querySelector('.cm-editor')!)!
  cleanups.push(() => { act(() => root.unmount()); host.remove() })
  return { host, view, props, actions, lines, root }
}
// T-UI-11 Tests: independent literal edit ranges; not generated from implementation.
test('minimal transactions cover insertion, deletion, replacement and unchanged text', () => {
  expect(minimalChange('abcd', 'abXcd')).toEqual({ from: 2, to: 2, insert: 'X' })
  expect(minimalChange('abcd', 'ad')).toEqual({ from: 1, to: 3, insert: '' })
  expect(minimalChange('abcd', 'aXYd')).toEqual({ from: 1, to: 3, insert: 'XY' })
  expect(minimalChange('', 'new')).toEqual({ from: 0, to: 0, insert: 'new' })
  expect(minimalChange('same', 'same')).toEqual({ from: 4, to: 4, insert: '' })
})
test('CodeMirror read-only updates preserve identity, scroll and cursor in one document transaction', () => {
  const { host, view, root, props } = mount()
  act(() => view.dispatch({ selection: { anchor: 23 } }))
  view.scrollDOM.scrollTop = 45; view.scrollDOM.scrollLeft = 12
  const transactions: unknown[] = []
  view.dispatch({ effects: StateEffect.appendConfig.of(EditorView.updateListener.of(update => {
    for (const transaction of update.transactions) transaction.changes.iterChanges((from, to, _fromB, _toB, inserted) => {
      transactions.push({ changes: { from, to, insert: inserted.toString() } })
    })
  })) })
  act(() => root.render(<CodeEditorView {...props} text={'const emoji = "😀"\nsecond\nTHIRD'} />))
  expect(EditorView.findFromDOM(host.querySelector('.cm-editor')!)).toBe(view)
  expect(view.state.selection.main.head).toBe(23)
  expect([view.scrollDOM.scrollTop, view.scrollDOM.scrollLeft]).toEqual([45, 12])
  expect(transactions).toEqual([{ changes: { from: 26, to: 31, insert: 'THIRD' } }])
  expect(view.contentDOM.getAttribute('aria-readonly')).toBe('true')
  expect(view.contentDOM.contentEditable).toBe('false')
})
test('keyboard hover and definition dispatch exact UTF-16 coordinates once without moving cursor', () => {
  const { view, actions, lines } = mount()
  act(() => view.dispatch({ selection: { anchor: 18 } }))
  expect(lines).toEqual([{ line: 1 }])
  actions.length = 0; lines.length = 0
  act(() => view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', ctrlKey: true, bubbles: true })))
  act(() => view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'F12', bubbles: true })))
  expect(actions).toEqual([['code.hover', { path: 'x.ts', line: '1', col: '18' }], ['code.definition', { path: 'x.ts', line: '1', col: '18' }]])
  expect(view.state.selection.main.head).toBe(18)
  expect(lines).toEqual([])
})
test('reveal clamps positions; omitted gestures do not dispatch; hostile hover remains text', () => {
  const { root, props, view, host, actions } = mount()
  act(() => root.render(<CodeEditorView {...props} gestures={{}} reveal={{ line: 999, col: 999 }} hover={{ line: 1, col: 0, markdown: '<img src=x onerror=alert(1)>' }} />))
  expect(view.state.selection.main.head).toBe(31)
  expect(host.querySelector('[role=tooltip]')!.textContent).toBe('<img src=x onerror=alert(1)>')
  expect(host.querySelector('img')).toBeNull()
  act(() => view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'F12', bubbles: true })))
  expect(actions).toEqual([])
})
// T-UI-11: CodeMirror normalizes source line endings; prop refreshes preserve reading position.
test('CRLF input and updates keep two source lines without redundant changes', () => {
  const { root, props, view } = mount('a\r\nb')
  expect(view.state.doc.toString()).toBe('a\nb')
  expect(view.state.doc.lines).toBe(2)
  act(() => root.render(<CodeEditorView {...props} text={'a\r\nc'} />))
  expect(view.state.doc.toString()).toBe('a\nc')
  expect(view.state.doc.lines).toBe(2)
})
test('path updates the accessible textbox name', () => {
  const { root, props, view } = mount()
  act(() => root.render(<CodeEditorView {...props} path='new.ts' />))
  expect(view.contentDOM.getAttribute('aria-label')).toBe('new.ts')
})
test('equal reveal coordinates do not reset selection or emit another view patch', () => {
  const { root, props, view, lines } = mount()
  act(() => root.render(<CodeEditorView {...props} reveal={{ line: 2, col: 1 }} />))
  act(() => view.dispatch({ selection: { anchor: 0 } }))
  lines.length = 0
  act(() => root.render(<CodeEditorView {...props} reveal={{ line: 2, col: 1 }} diagnostics={[]} />))
  expect(view.state.selection.main.head).toBe(0)
  expect(lines).toEqual([])
})
test('Ctrl pointer hover emits once per position and resets when released or leaving', () => {
  const { view, actions } = mount()
  // happy-dom has no text layout; isolate only the browser coordinate lookup.
  let pos: number | null = 2
  function positionAtCoords(coords: { x: number; y: number }, precise: false): number
  function positionAtCoords(coords: { x: number; y: number }): number | null
  function positionAtCoords(_coords: { x: number; y: number }, precise?: false): number | null {
    return precise === false ? pos ?? 0 : pos
  }
  view.posAtCoords = positionAtCoords
  const move = (ctrlKey: boolean) => {
    const event = new MouseEvent('mousemove', { ctrlKey, bubbles: true, cancelable: true })
    act(() => view.contentDOM.dispatchEvent(event))
    expect(event.defaultPrevented).toBe(false)
  }
  move(true); move(true)
  expect(actions).toEqual([['code.hover', { path: 'x.ts', line: '1', col: '2' }]])
  pos = 3; move(true); move(true)
  expect(actions).toHaveLength(2)
  move(false); move(true)
  expect(actions).toHaveLength(3)
  act(() => view.contentDOM.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true })))
  move(true)
  expect(actions).toHaveLength(4)
  pos = null; move(true)
  expect(actions).toHaveLength(4)
})

test('disabled pointer gesture and omitted definition emit no action', () => {
  const { root, props, view, actions } = mount()
  act(() => root.render(<CodeEditorView {...props} gestures={{ hover: { tag: 'code.hover', label: 'Hover', disabled: { reason: 'Unavailable' } } }} />))
  // happy-dom cannot resolve coordinates; all dispatch and editor behavior remain real.
  view.posAtCoords = () => 2
  act(() => view.contentDOM.dispatchEvent(new MouseEvent('mousemove', { ctrlKey: true, bubbles: true })))
  act(() => view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'F12', bubbles: true })))
  expect(actions).toEqual([])
  expect(view.state.selection.main.head).toBe(0)
})

// T-APP-14a: a binding replaces read-only data without feeding it back as an edit.
import * as Y from "yjs"
import { yCollab } from "y-codemirror.next"
test("binding replacement and removal keep one editor and never write stale props to either document", () => {
  const { root, props, view } = mount("seed")
  const a = new Y.Doc(), b = new Y.Doc()
  a.getText("content").insert(0, "first")
  b.getText("content").insert(0, "second")
  const binding = (doc: Y.Doc) => ({ text: doc.getText("content").toString(), extensions: yCollab(doc.getText("content"), null, { undoManager: false }) })
  act(() => root.render(<CodeEditorView {...props} binding={binding(a)} />))
  expect(view.state.doc.toString()).toBe("first")
  expect(view.contentDOM.getAttribute("aria-readonly")).toBe("false")
  act(() => root.render(<CodeEditorView {...props} binding={binding(b)} />))
  expect(view.state.doc.toString()).toBe("second")
  expect(a.getText("content").toString()).toBe("first")
  expect(b.getText("content").toString()).toBe("second")
  act(() => root.render(<CodeEditorView {...props} text="read again" />))
  expect(view.state.doc.toString()).toBe("read again")
  expect(b.getText("content").toString()).toBe("second")
  expect(view.contentDOM.getAttribute("aria-readonly")).toBe("true")
  a.destroy(); b.destroy()
})

test("live CRLF source retains exact Yjs UTF-16 offsets", () => {
  const { root, props, view } = mount("")
  const doc = new Y.Doc(); doc.getText("content").insert(0, "a\r\nb")
  act(() => root.render(<CodeEditorView {...props} binding={{ text: "a\r\nb", extensions: yCollab(doc.getText("content"), null, { undoManager: false }) }} />))
  expect(view.state.doc.toString()).toBe("a\r\nb")
  act(() => view.dispatch({ changes: { from: 4, insert: "!" } }))
  expect(doc.getText("content").toString()).toBe("a\r\nb!")
  doc.destroy()
})

test("changing files reveals the same coordinates in the replacement document", () => {
  const { root, props, view, host } = mount("first\nsecond\nthird")
  const reveal = { line: 2, col: 1, to_line: 3 }
  act(() => root.render(<CodeEditorView {...props} reveal={reveal} />))
  expect(view.state.doc.sliceString(view.state.selection.main.from, view.state.selection.main.to)).toBe("econd\nthird")
  act(() => root.render(<CodeEditorView {...props} path="other.ts" text={"a\nbb\nccc"} reveal={reveal} />))
  expect(EditorView.findFromDOM(host.querySelector(".cm-editor")!)).toBe(view)
  expect(view.state.selection.main.anchor).toBe(3)
  expect(view.state.selection.main.head).toBe(8)
  expect(view.state.doc.sliceString(view.state.selection.main.from, view.state.selection.main.to)).toBe("b\nccc")
})

test("changing only the path reveals equal coordinates again", () => {
  const { root, props, view } = mount()
  const reveal = { line: 2, col: 1 }
  act(() => root.render(<CodeEditorView {...props} reveal={reveal} />))
  act(() => view.dispatch({ selection: { anchor: 0 } }))
  act(() => root.render(<CodeEditorView {...props} path="other.ts" reveal={reveal} />))
  expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(2)
  expect(view.state.selection.main.head - view.state.doc.line(2).from).toBe(1)
})

test("receiving text after an empty document replays the pending reveal", () => {
  const { root, props, view } = mount("")
  const reveal = { line: 3, col: 2 }
  act(() => root.render(<CodeEditorView {...props} reveal={reveal} />))
  expect(view.state.selection.main.head).toBe(0)
  act(() => root.render(<CodeEditorView {...props} text={"one\ntwo\nthree"} reveal={reveal} />))
  expect(view.state.selection.main.head).toBe(10)
})

test("binding text takes precedence over text props when revealing a replacement", () => {
  const { root, props, view } = mount("")
  const reveal = { line: 2, col: 1 }
  const doc = new Y.Doc()
  cleanups.push(() => doc.destroy())
  const text = doc.getText("content")
  text.insert(0, "first\nsecond")
  act(() => root.render(<CodeEditorView {...props} reveal={reveal} />))
  const binding = { text: text.toString(), extensions: yCollab(text, null, { undoManager: false }) }
  act(() => root.render(<CodeEditorView {...props} binding={binding} reveal={reveal} />))
  expect(view.state.selection.main.head).toBe(7)
  act(() => view.dispatch({ selection: { anchor: 0 } }))
  act(() => root.render(<CodeEditorView {...props} text="unrelated props" binding={binding} reveal={reveal} />))
  expect(view.state.doc.toString()).toBe("first\nsecond")
  expect(view.state.selection.main.head).toBe(0)
})


test.each(["tsx", "TSX", "TsX", "jsx", "JSX", "JsX"])("language %s parses JSX on mount and reconfiguration", language => {
  const { root, props, view } = mount("const view = <div title=\"ok\">Hello</div>", language)
  expect(syntaxTree(view.state).toString()).toContain("JSXElement")
  act(() => root.render(<CodeEditorView {...props} language={language.toUpperCase()} />))
  const tree = syntaxTree(view.state)
  expect(tree.toString()).toContain("JSXElement")
  const errors: string[] = []
  tree.iterate({ enter: node => { if (node.type.isError) errors.push(node.name) } })
  expect(errors).toEqual([])
})

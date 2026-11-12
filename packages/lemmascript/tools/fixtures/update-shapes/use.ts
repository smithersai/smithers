// The shapes of a Foldkit `update`: a match table with whole-payload and defaulted bindings, guards on optional
// fields in `||` chains and early returns, a regular-expression test, an immediately invoked arrow, rest
// destructuring, a namespace constant, and an anonymous result of a declared projection.
import { Message, screenOf } from "./messages";
import * as State from "./state";

export interface Item { readonly n: number; readonly label: string }
export interface Issues { readonly open: boolean; readonly items: ReadonlyArray<Item> }
export interface Box { readonly x: number; readonly y: number }
export interface Model { readonly box?: Box; readonly following: boolean; readonly intent: number; readonly role: string; readonly issues?: Issues; readonly seq: number }

//@ verify
//@ ensures message._tag == "Measured" ==> \result.box == { x: message.x, y: message.y }
//@ ensures message._tag == "Scrolled" ==> \result.following == message.bottom
//@ ensures message._tag == "Scrolled" && message.intent === undefined ==> \result.intent == model.intent
//@ ensures message._tag == "Loaded" && message.data.role === undefined ==> \result.role == "viewer"
export function arms(model: Model, message: Message): Model {
  return Message.match(message, {
    Measured: (box) => ({ ...model, box }),
    Scrolled: ({ bottom, intent = model.intent }) => ({ ...model, following: bottom, intent }),
    Loaded: ({ data }) => ({ ...model, role: data.role ?? "viewer", seq: data.seq }),
  })
}

//@ verify
//@ ensures model.issues === undefined || !open ==> \result == model
export function closed(model: Model, open: boolean): Model {
  return model.issues === undefined || !open ? model : { ...model, issues: { ...model.issues, open: false } }
}

//@ verify
//@ ensures model.issues === undefined ==> \result == 0
export function firstLabelLength(model: Model): number {
  if (model.issues === undefined || model.issues.items.length === 0) return 0
  const items = { ...model.issues }.items
  return model.issues.items[0]!.n + items.length - items.length
}

//@ verify
//@ ensures model.issues === undefined ==> \result == ""
export function found(model: Model): string {
  return model.issues === undefined ? "" : model.issues.items.find(item => item.n > 0)?.label ?? ""
}

//@ verify
//@ ensures \result == linksIssue(text)
export function linksIssue(text: string): boolean {
  return /\]\(#issue-[1-9][0-9]*\)/.test(text)
}

//@ verify
//@ ensures \result.following == !model.following && \result.seq == model.seq
export function toggled(model: Model): Model {
  return (() => { const following = !model.following; return { ...model, following } })()
}

export interface Counts { readonly box?: Box; readonly intent: number; readonly issues?: Issues; readonly seq: number }

//@ verify
//@ ensures \result.box === undefined && \result.seq == model.seq && \result.following == model.following
export function withoutBox(model: Model): Model {
  const { box, ...rest } = model
  return rest
}

//@ verify
//@ ensures \result.intent == model.intent && \result.seq == model.seq && \result.box == model.box
export function counts(model: Model): Counts {
  const { following, role, ...kept } = model
  return kept
}

//@ verify
//@ ensures \result == 1
export function start(): number {
  return State.startIntent
}

//@ verify
//@ ensures \result == screenOf(model).count
export function counted(model: Model): number {
  return screenOf(model).count
}

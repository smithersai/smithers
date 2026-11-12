// The shapes of a whole Foldkit `update`: a host library's `Return` alias of a plain object type is a record with a
// `never` field dropped; a message constructor is its variant; a string method given a regular expression, or one LemmaScript does not
// model, is an opaque extern; a string-union value takes string methods and its length; a generated table is a fixed unknown
// value. spread.ts: a spread override with optional fields reads a narrowed `??` inside its call.
import type * as Hostlib from "hostlib";
import { Message } from "./messages";
import { pages } from "./table";

export type Role = "owner" | "viewer"
export interface Model { readonly page: string; readonly count: number }

//@ verify
//@ ensures \result.model == model && \result.commands == []
export function same(model: Model): Hostlib.Return<Model, Message> {
  return { model, commands: [] }
}

//@ verify
//@ ensures \result == { _tag: "Opened", page: page }
export function opened(page: string): Message {
  return Message.Opened({ page })
}

//@ verify
//@ ensures true
export function words(text: string): ReadonlyArray<string> {
  return text.trim().split(/\s+/)
}

//@ verify
//@ ensures \result.length == role.length - 1
export function tail(role: Role): string {
  return role.slice(1)
}

//@ verify
//@ ensures \result == pages.length
export function pageCount(): number {
  return pages.length
}

//@ verify
//@ ensures \result == words(text)
export function wordsAgain(text: string): ReadonlyArray<string> {
  return text.trim().split(/\s+/)
}

//@ verify
//@ ensures \result == shown(text)
export function shown(text: string): string {
  return text.toWellFormed().padStart(2, "0")
}

//@ verify
//@ ensures \result == shown(text)
export function shownAgain(text: string): string {
  return text.toWellFormed().padStart(2, "0")
}

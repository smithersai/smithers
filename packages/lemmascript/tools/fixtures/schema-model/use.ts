import type { Client, Model } from "./model"

//@ verify
//@ ensures \result.docs == docs
//@ ensures \result.sources == model.sources && \result.account == model.account && \result.status == model.status
export function writeDocs(model: Model, docs: "pane" | "max"): Model {
  return { ...model, docs }
}

// Two fields of one schema are one datatype, so one can replace the other.
//@ verify
//@ ensures \result.previous == model.current
export function remember(model: Model): Model {
  return { ...model, previous: model.current }
}

// An element of an array of anonymous structs has its fields.
//@ verify
//@ requires model.rows.length > 0
//@ ensures \result == model.rows[0].at
export function firstAt(model: Model): number {
  return model.rows[0]!.at
}

//@ verify
//@ ensures model.account === undefined ==> \result == ""
export function accountName(model: Model): string {
  return model.account?.name ?? ""
}

//@ verify
//@ ensures \result == (model.status._tag == "Busy")
export function busy(model: Model): boolean {
  return model.status._tag === "Busy"
}

// A field's inlined copy of a schema and the schema's own alias are one type: the Model reaches it first here.
//@ verify
//@ ensures \result.current == client && \result.previous == model.previous
export function adopt(model: Model, client: Client): Model {
  return { ...model, current: client }
}

//@ verify
//@ ensures \result.seq == seq && \result.entries.length == 0
export function fresh(seq: number): Client {
  return { seq, entries: [], pending: [] }
}

import type { Client, Model } from "./model"

// The schema's own alias reached before the Model that holds a copy of it: the Model's field reuses its datatype.
//@ verify
//@ ensures \result.seq == seq && \result.pending.length == 0
export function fresh(seq: number): Client {
  return { seq, entries: [], pending: [] }
}

//@ verify
//@ ensures \result.current == client
export function adopt(model: Model, client: Client): Model {
  return { ...model, current: client }
}

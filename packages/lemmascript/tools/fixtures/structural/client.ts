// The same structure, named, as a proved module declares it.
export type Status = "idle" | "busy";
export interface Pending { readonly id: string; readonly text: string }
export type Last = { readonly type: "Posted"; readonly id: string } | { readonly type: "Cleared" };
export interface Client { readonly gap: boolean; readonly status: Status; readonly pending: ReadonlyArray<Pending>; readonly last: Last }
export interface Ref { readonly id: string }

//@ verify
//@ ensures \result.gap == !client.gap && \result.status == client.status && \result.pending == client.pending
export function flipped(client: Client): Client {
  return { ...client, gap: !client.gap }
}

//@ verify
//@ ensures \result == refs.length
export function counted(refs: ReadonlyArray<Ref>): number {
  return refs.length
}

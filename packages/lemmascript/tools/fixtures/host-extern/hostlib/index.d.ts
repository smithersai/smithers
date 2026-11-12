// A host library's typings, shaped like Foldkit's commands over Effect. The test copies this folder to
// node_modules/hostlib, where LemmaScript reads it as a host library.
export interface Effect<A> {
  readonly [Symbol.iterator]: () => Iterator<A>;
  readonly pipe: (f: (a: A) => A) => Effect<A>;
}
export type Command<M> = Readonly<{ name: string; args?: Record<string, unknown>; effect: Effect<M> }>;
export interface DefinitionWithArgs<Name extends string, Fields> {
  readonly name: Name;
  (args: Fields): Readonly<{ name: Name; args: Fields; effect: Effect<unknown> }>;
}

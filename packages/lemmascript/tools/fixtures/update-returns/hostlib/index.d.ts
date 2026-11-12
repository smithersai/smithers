// A host library's typings, shaped like Foldkit's `Update.Return` and commands. The test copies this folder to
// node_modules/hostlib, where LemmaScript reads it as a host library.
export interface Command<M> { readonly name: string; readonly run: (m: M) => M }
export type Return<Model, M> = Readonly<{ model: Model; commands: ReadonlyArray<Command<M>>; outMessage?: never }>;

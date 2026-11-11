// A field typed by a string index signature, as `Schema.Record` decodes to, is a Dafny map that keeps its value.
export interface Sources { readonly media?: { readonly [name: string]: string }; readonly count: number }

//@ verify
//@ ensures \result.media == sources.media && \result.count == sources.count + 1
export function counted(sources: Sources): Sources {
  return { ...sources, count: sources.count + 1 }
}

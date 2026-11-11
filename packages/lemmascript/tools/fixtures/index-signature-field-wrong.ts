// The map field is carried over unchanged, so it cannot be proved absent.
export interface Sources { readonly media?: { readonly [name: string]: string }; readonly count: number }

//@ verify
//@ ensures \result.media === undefined
export function counted(sources: Sources): Sources {
  return { ...sources, count: sources.count + 1 }
}

// A proved decision another module calls through a namespace import.
export interface Screen { readonly open: boolean; readonly count: number }

//@ verify
//@ ensures \result.open && \result.count == screen.count
export function opened(screen: Screen): Screen {
  return { ...screen, open: true }
}

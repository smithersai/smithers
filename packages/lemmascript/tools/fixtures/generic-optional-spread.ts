export interface Options<I, S> { readonly enabled: boolean; readonly instance?: I; readonly snapshot?: S }
//@ verify
//@ ensures \result.enabled == enabled
//@ ensures \result.instance == instance
//@ ensures \result.snapshot == snapshot
export function build<I, S>(enabled: boolean, instance: I | undefined, snapshot: S | undefined): Options<I, S> {
  return { enabled, ...(instance === undefined ? {} : { instance }), ...(snapshot === undefined ? {} : { snapshot }) }
}

//@ verify
//@ ensures \result.enabled == options.enabled
//@ ensures \result.instance == options.instance
//@ ensures \result.snapshot == options.snapshot
export function rebuilt<I, S>(options: Options<I, S>): Options<I, S> {
  return { enabled: options.enabled, ...(options.instance === undefined ? {} : { instance: options.instance }), ...(options.snapshot === undefined ? {} : { snapshot: options.snapshot }) }
}

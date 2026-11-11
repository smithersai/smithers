// A computed generic alias is instantiated before reading its field types.
interface Model { readonly value: number }
interface Returned<M, C> { readonly model: M; readonly stamp: number; readonly commands?: ReadonlyArray<C> }
type WithCommands<R extends { readonly commands?: unknown }> = R & { readonly commands: NonNullable<R["commands"]> };

//@ verify
//@ ensures \result.stamp == state.stamp
//@ ensures \result.model == state.model
//@ ensures state.commands === undefined ==> \result.commands == []
//@ ensures state.commands !== undefined ==> \result.commands == state.commands
export function normalize(state: Returned<Model, number>): WithCommands<Returned<Model, number>> {
  return { ...state, commands: [] };
}

//@ verify
//@ ensures \result.stamp == state.stamp
//@ ensures \result.model == state.model && \result.commands == [command]
export function named(state: Returned<Model, string>, command: string): WithCommands<Returned<Model, string>> {
  return { ...state, commands: [command] };
}


//@ extern
//@ impure
//@ ensures \result.model.value == \result.stamp
declare function observe(): Returned<Model, number>;

//@ verify
//@ ensures \result.model.value == \result.stamp
export function fromObservation(): WithCommands<Returned<Model, number>> {
  return { ...observe(), commands: [] };
}

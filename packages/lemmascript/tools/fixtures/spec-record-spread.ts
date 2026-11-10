// A record spread inside a contract states the whole next value: changed fields and the frame together.
type Screen = { readonly menu: boolean; readonly count: number; readonly name: string }
type Command = { readonly type: "Focus"; readonly open: boolean } | { readonly type: "Stop" }
type Step = { readonly state: Screen; readonly commands: ReadonlyArray<Command> }

//@ verify
//@ ensures \result.state == { ...state, menu: !state.menu }
//@ ensures \result.commands == [{ type: "Focus", open: !state.menu }]
function toggled(state: Screen): Step {
  return { state: { ...state, menu: !state.menu }, commands: [{ type: "Focus", open: !state.menu }] }
}

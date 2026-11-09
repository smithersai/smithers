// A body that changes a field the contract's spread frame keeps must fail.
type Screen = { readonly menu: boolean; readonly count: number }

//@ verify
//@ ensures \result == { ...state, menu: !state.menu }
function toggled(state: Screen): Screen {
  return { ...state, menu: !state.menu, count: state.count + 1 }
}

// A spread whose source field is required (`step: string`) over a target where it is optional (`step?: string`)
// writes the present value; it read the source field as an Option.
interface Panel { readonly step?: string; readonly open: boolean; readonly count: number }
interface Selection { readonly step: string; readonly open: boolean }

//@ verify
//@ ensures \result == { ...panel, open: selection.open }
export function follow(panel: Panel, selection: Selection): Panel {
  return { ...panel, ...selection }
}

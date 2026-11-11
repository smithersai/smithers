/-
The build's check of the invariant matrix, `INVARIANTS.md`.

`lake build` reads the matrix and fails when a row is not well formed: a
`Proved` row that names no theorem, a name that is not a theorem of this model,
a status that is not one of the three, or an `Assumed` or `Open` row with no
reason. The matrix is an input of this module, so editing it runs the check
again. The method is the lang factory model's (`factory/model/Matrix/Check.lean`).
-/
import Lean
import MergeQueue.Audit

open Lean Elab Command

namespace MergeQueue.Matrix

/-- The cells of one Markdown table row, trimmed. -/
def cells (line : String) : List String :=
  let parts := (line.splitOn "|").map fun cell => cell.trimAscii.toString
  (parts.drop 1).dropLast

/-- The names in backticks in a cell: every second piece between backticks. -/
def codeSpans (cell : String) : List String :=
  let pieces := cell.splitOn "`"
  (pieces.zip (List.range pieces.length)).filterMap fun item => if item.2 % 2 == 1 then some item.1 else none

/-- A cited name as a constant of the model: `main_always_green` is `MergeQueue.main_always_green`. -/
def toName (cited : String) : Name :=
  (cited.splitOn ".").foldl (fun name part => Name.str name part) `MergeQueue

/-- The statuses a row can have. -/
def statuses : List String := ["Proved", "Assumed", "Open"]

run_cmd do
  let env ← getEnv
  let text ← IO.FS.readFile "INVARIANTS.md"
  let mut bad : Array String := #[]
  let mut counts : List (String × Nat) := statuses.map fun status => (status, 0)
  let mut theorems : Array Name := #[]
  let mut number := 0
  for line in text.splitOn "\n" do
    number := number + 1
    unless line.startsWith "| " do continue
    if line.startsWith "| ---" || line.startsWith "| Invariant" then continue
    match cells line with
    | [invariant, status, detail] =>
      unless statuses.contains status do
        bad := bad.push s!"line {number}: \"{status}\" is not a status"
        continue
      counts := counts.map fun item => if item.1 == status then (item.1, item.2 + 1) else item
      if invariant.isEmpty || detail.isEmpty then
        bad := bad.push s!"line {number}: a row needs an invariant and a theorem or a reason"
      if status == "Proved" then
        let names := codeSpans detail
        if names.isEmpty then bad := bad.push s!"line {number}: a Proved row names no theorem"
        for cited in names do
          let name := toName cited
          match env.find? name with
          | some (.thmInfo _) => theorems := theorems.push name
          | _ => bad := bad.push s!"line {number}: {cited} is not a theorem of the model"
    | _ => bad := bad.push s!"line {number}: a row has three cells: invariant, status, and theorems or a reason"
  unless bad.isEmpty do
    throwError "INVARIANTS.md does not check:\n{"\n".intercalate bad.toList}"
  let total := counts.foldl (fun sum item => sum + item.2) 0
  let distinct := theorems.toList.eraseDups.length
  if total == 0 then throwError "INVARIANTS.md has no rows"
  logInfo m!"INVARIANTS.md: {total} rows. {counts.map fun item => s!"{item.2} {item.1}"}. \
    {distinct} theorems named, all present."

end MergeQueue.Matrix

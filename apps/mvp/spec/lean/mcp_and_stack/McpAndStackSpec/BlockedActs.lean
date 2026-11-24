import Lean.Elab.Term

/-!
# Person-only acts

`MCP_BLOCKED_ACTS` (`src/features/mcp/contract.ts`) and the two ways the Worker recognises one by name:
`isBlockedName` (`worker/mcp/Tools.ts`), which reads `pull/merge` and `pull_merge`, and `isBlockedMcpAct`
(`worker/mcp/Auth.ts`), which reads every `_` and `.` as `/`.

A name is a JavaScript string: its UTF-16 code units.
-/

namespace McpAndStackSpec

/-- A JavaScript string: its UTF-16 code units. -/
abbrev Text := List Nat

open Lean Elab Term in
/-- `u16! "abc"` is the code units of an ASCII literal, written out so the kernel compares numbers. -/
elab "u16! " s:str : term => do
  let chars := s.getString.toList
  unless chars.all (fun c => c.toNat < 128) do throwError "u16! takes an ASCII literal"
  let units : Array (TSyntax `term) := (chars.map fun c => Syntax.mkNumLit (toString c.toNat)).toArray
  let list ← `(([$units,*] : List Nat))
  elabTerm list none

def slash : Nat := 47
def underscore : Nat := 95
def dot : Nat := 46

/-- The acts no agent may do, whatever its person's role. -/
def blockedActs : List Text := [
  u16! "pull/merge",
  u16! "issue/triage",
  u16! "issue/commitment",
  u16! "triage/enable",
  u16! "triage/pause",
  u16! "todo/commit",
  u16! "todo/drop",
  u16! "secrets/write",
  u16! "runner/register",
  u16! "model/write"]

/-- `text.replace(old, new)` for one code unit: the first occurrence only. -/
def replaceFirst (old new : Nat) : Text → Text
  | [] => []
  | unit :: rest => if unit = old then new :: rest else unit :: replaceFirst old new rest

/-- An act as a tool would be named: `pull_merge`. -/
def underscored (act : Text) : Text := replaceFirst slash underscore act

/-- `isBlockedName`: the act itself, or its tool spelling. -/
def isBlockedName (name : Text) : Bool :=
  blockedActs.any fun act => decide (act = name) || decide (underscored act = name)

/-- `act.replace(/[_.]/g, "/")`: every `_` and `.` read as `/`. -/
def canonical (name : Text) : Text :=
  name.map fun unit => if unit = underscore ∨ unit = dot then slash else unit

/-- `isBlockedMcpAct`: the name, or its canonical form, is a person-only act. -/
def isBlockedMcpAct (name : Text) : Bool :=
  decide (name ∈ blockedActs) || decide (canonical name ∈ blockedActs)

end McpAndStackSpec

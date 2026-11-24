import CapabilitySpec.Path

/-!
# Patterns against capabilities and against each other

`selected` is the grant matcher. `subsumes` proves coverage and answers `false` when it cannot; `mayOverlap` proves
disjointness and answers `true` when it cannot.
-/

namespace CapabilitySpec

/-- `matches`: the pattern selects the capability, in every form of its resource. -/
def selected (pattern : Pattern) (capability : Capability) : Bool :=
  pattern.action.selects capability.action &&
    match forms (.exact capability.action) capability.resource with
    | none => false
    | some texts => texts.all (matchesResource pattern.resource)

/-- `withinMatchBudget`: the matcher can decide the pair. -/
def withinMatchBudget (pattern : Pattern) (capability : Capability) : Bool :=
  !pattern.action.selects capability.action || withinWork pattern.resource capability.resource

/-- The text before a trailing `/**`. -/
def recursiveRoot (resource : Text) : Option Text :=
  match resource.reverse with
  | 42 :: 42 :: 47 :: rest => some rest.reverse
  | _ => none

/-- Coverage of one resource text by another that the syntax proves. -/
def resourceSubsumes (left right : Text) : Bool :=
  left = right || left = [star, star] ||
    match recursiveRoot left with
    | some root => (root ++ [slash]).isPrefixOf right
    | none => false

/-- `subsumes`: every capability `right` selects, `left` provably selects. -/
def subsumes (left right : Pattern) : Bool :=
  left.action.covers right.action &&
    match forms right.action right.resource with
    | none => false
    | some texts => texts.all (resourceSubsumes left.resource)

def resourcesMayOverlap (left right : Text) : Bool :=
  if isLiteral left ∧ isLiteral right then left = right
  else
    let shared := min (literalPrefix left).length (literalPrefix right).length
    (literalPrefix left).take shared = (literalPrefix right).take shared

/-- `mayOverlap`: `false` only when no capability can be selected by both. -/
def mayOverlap (left right : Pattern) : Bool :=
  (left.action.covers right.action || right.action.covers left.action) &&
    resourcesMayOverlap left.resource right.resource

/-- `patternFromCapability`: the pattern that selects exactly this capability, when the grammar can write it. -/
def exactPattern (capability : Capability) : Option Pattern :=
  let pattern : Pattern := { action := .exact capability.action, resource := capability.resource }
  if capability.resource.length ≤ maxResourceLength ∧ isLiteral capability.resource ∧ selected pattern capability
  then some pattern
  else none

/-- `format`: `action:resource`. -/
def format (pattern : Pattern) : Text := units pattern.action.name ++ colon :: pattern.resource

/-- `parse`: the first two colon-separated components are the action; the rest is the resource. -/
def parse (input : Text) : Option Capability :=
  match splitOn colon input with
  | scope :: operation :: first :: rest =>
    let resource := joinWith colon (first :: rest)
    match Action.all.find? (fun action => units action.name = scope ++ colon :: operation) with
    | some action => if resource.length ≤ maxResourceLength then some { action, resource } else none
    | none => none
  | _ => none

/-- `parsePattern`: as `parse`, with `*` in one component and the bare `*` read as `*:**`. -/
def parsePattern (input : Text) : Option Pattern :=
  match splitOn colon input with
  | [[42]] => some { action := .any, resource := [star, star] }
  | [42] :: first :: rest =>
    let resource := joinWith colon (first :: rest)
    if resource.length ≤ maxResourceLength then some { action := .any, resource } else none
  | scope :: operation :: first :: rest =>
    let resource := joinWith colon (first :: rest)
    match Selector.all.find? (fun action => units action.name = scope ++ colon :: operation) with
    | some action => if resource.length ≤ maxResourceLength then some { action, resource } else none
    | none => none
  | _ => none

end CapabilitySpec

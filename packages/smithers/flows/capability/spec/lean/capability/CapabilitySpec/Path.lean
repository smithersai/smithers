import CapabilitySpec.Glob

/-!
# Filesystem resources with dot or empty segments

The matcher compares text, so `/w/**` would textually select `/w/../etc/passwd`. A filesystem resource that still
carries a `.`, `..` or empty segment is therefore read through its *forms*: none at all when no pattern may select it,
or the written text together with its lexical normal form.
-/

namespace CapabilitySpec

def dot : Text := [46]
def parent : Text := [46, 46]
def backslash : Nat := 92
def tilde : Nat := 126
def colon : Nat := 58

/-- The pieces of a text between separators; a text with `n` separators has `n + 1` pieces. -/
def splitOn (separator : Nat) : Text → List Text
  | [] => [[]]
  | unit :: rest =>
    if unit = separator then [] :: splitOn separator rest
    else
      match splitOn separator rest with
      | [] => [[unit]]
      | piece :: pieces => (unit :: piece) :: pieces

/-- The pieces with one separator between neighbours. -/
def joinWith (separator : Nat) : List Text → Text
  | [] => []
  | [piece] => piece
  | piece :: pieces => piece ++ separator :: joinWith separator pieces

/-- `hasDotSegment`: a filesystem resource other than the root with a `.`, `..` or empty segment. -/
def hasDotSegment (action : Selector) (resource : Text) : Bool :=
  action.selectsFilesystem && resource ≠ [slash] &&
    ((splitOn slash resource).any (fun segment => segment = dot ∨ segment = parent) ||
      ((splitOn slash resource).drop 1).any (fun segment => segment = []))

/-- Folds segments onto a stack (newest first); `none` when a `..` climbs above the start. -/
def foldSegments : List Text → List Text → Option (List Text)
  | stack, [] => some stack
  | stack, segment :: rest =>
    if segment = [] ∨ segment = dot then foldSegments stack rest
    else if segment = parent then
      match stack with
      | [] => none
      | _ :: below => foldSegments below rest
    else foldSegments (segment :: stack) rest

/-- `normalizeRelative`: drops `.` and empty segments and folds `name/..`; `.` for an empty result. -/
def normalizeRelative (resource : Text) : Option Text :=
  (foldSegments [] (splitOn slash resource)).map fun stack =>
    if stack.isEmpty then dot else joinWith slash stack.reverse

def isLetter (unit : Nat) : Bool := (65 ≤ unit ∧ unit ≤ 90) || (97 ≤ unit ∧ unit ≤ 122)

/-- A resource that names an absolute, home or Windows path: its dot segments cannot be folded lexically. -/
def anchored (resource : Text) : Bool :=
  resource.head? = some slash || resource.contains backslash || resource.head? = some tilde ||
    (match resource with
      | letter :: 58 :: _ => isLetter letter
      | _ => false)

/-- The segments before the last `..`; empty when there is none. -/
def beforeLastParent (segments : List Text) : List Text :=
  ((segments.reverse.dropWhile (fun segment => segment ≠ parent)).drop 1).reverse

/-- `dotSegmentForms`: the texts a pattern must select, or `none` when no pattern may select the resource. -/
def forms (action : Selector) (resource : Text) : Option (List Text) :=
  if hasDotSegment action resource then
    if anchored resource then none
    else if (beforeLastParent (splitOn slash resource)).any (fun segment => !isLiteral segment) then none
    else (normalizeRelative resource).map fun normal => [resource, normal]
  else some [resource]

end CapabilitySpec

import FlowSpec.Basic

/-!
# Capability ceilings

The reference for `intersectCeilings` and `ceilingWithin` of
`packages/smithers/flows/flow/src/Flow/CapabilityCeiling.ts`, and for what they rest on in `@smthrs/capability`:
`parsePattern`, the normal form of a `CapabilitySet`, `CapabilitySet.intersect`, `CapabilitySet.within` and
`subsumes`.

A ceiling in transported form is groups of pattern text. Authority is the conjunction of its groups, and each group
allows what any of its patterns allows: no group is unrestricted, and a group with no valid pattern denies everything.
The normal form sorts and deduplicates the patterns of each group and then the groups, and is the single deny-all
group as soon as one group is empty, so equal authority built from the same patterns has one form.
-/

namespace FlowSpec

/-- A capability pattern: an action of the pattern vocabulary and a resource glob. -/
structure Pattern where
  action : Text
  resource : Text
  deriving Repr, DecidableEq

/-- `*` -/
def star : Text := [42]

/-- `**` -/
def anything : Text := [42, 42]

/-- The longest resource a pattern may carry, in code units. -/
def maxResourceLength : Nat := 4096

/-- The pattern action vocabulary: every exact action, every namespace wildcard, and `*`. -/
def patternActions : List Text :=
  ["fs:read", "fs:write", "net:get", "net:post", "net:private", "model:call", "memory:read", "memory:write",
    "proc:spawn", "jj:status", "jj:diff", "jj:snapshot", "jj:restore", "jj:workspace-add", "jj:workspace-forget",
    "jj:root", "jj:revert", "jj:op-restore", "remote:acquire", "fs:*", "net:*", "model:*", "memory:*", "proc:*",
    "jj:*", "remote:*", "*"].map utf16

/-- `text.split(separator)` for a separator of one code unit: at least one piece, empty pieces kept. -/
def splitOn (separator : Nat) : Text → List Text
  | [] => [[]]
  | unit :: rest =>
    if unit = separator then [] :: splitOn separator rest
    else
      match splitOn separator rest with
      | [] => [[unit]]
      | piece :: pieces => (unit :: piece) :: pieces

/-- `pieces.join(separator)`. -/
def joinWith (separator : Nat) : List Text → Text
  | [] => []
  | [piece] => piece
  | piece :: pieces => piece ++ separator :: joinWith separator pieces

/--
`parsePattern`: a bare `*` is every action on every resource; `*:<resource>` is every action on a resource; anything
else is `<namespace>:<operation>:<resource>` with an action of the vocabulary. A resource may hold colons.
-/
def parsePattern (input : Text) : Option Pattern :=
  match splitOn 58 input with
  | [] => none
  | first :: rest =>
    if first = star then
      match rest with
      | [] => some { action := star, resource := anything }
      | _ :: _ =>
        if (joinWith 58 rest).length ≤ maxResourceLength then some { action := star, resource := joinWith 58 rest }
        else none
    else
      match rest with
      | operation :: resource :: more =>
        if patternActions.contains (first ++ 58 :: operation)
            && decide ((joinWith 58 (resource :: more)).length ≤ maxResourceLength) then
          some { action := first ++ 58 :: operation, resource := joinWith 58 (resource :: more) }
        else none
      | _ => none

/-- `format`: `<action>:<resource>`. -/
def format (pattern : Pattern) : Text := pattern.action ++ 58 :: pattern.resource

/-! ## The normal form -/

/-- `comparePattern(a, b) < 0`: by action, then by resource, each as JavaScript compares strings. -/
def patternLt (a b : Pattern) : Bool := lexLt textLt [a.action, a.resource] [b.action, b.resource]

/-- `compareGroup(a, b) < 0`: the first differing pattern decides, and a proper prefix comes first. -/
def groupLt : List Pattern → List Pattern → Bool := lexLt patternLt

/-- A group's patterns, sorted and distinct. -/
def normalizeGroup (group : List Pattern) : List Pattern := canon patternLt group

/-- A set of groups in normal form: the deny-all group alone when any group is empty, else sorted and distinct. -/
def make (groups : List (List Pattern)) : List (List Pattern) :=
  if (groups.map normalizeGroup).any List.isEmpty then [[]] else canon groupLt (groups.map normalizeGroup)

/-- The authority a transported ceiling describes: its groups parsed, invalid patterns dropped so they deny. -/
def authorityOf (groups : List (List Text)) : List (List Pattern) :=
  make (groups.map (fun group => group.filterMap parsePattern))

/-- `CapabilitySet.intersect`: an unrestricted side returns the other, and otherwise the groups of both. -/
def intersect (left right : List (List Pattern)) : List (List Pattern) :=
  if right = [] then left else if left = [] then right else make (left ++ right)

/-- `intersectCeilings`. -/
def intersectCeilings (left right : List (List Text)) : List (List Text) :=
  (intersect (authorityOf left) (authorityOf right)).map (fun group => group.map format)

/-- A set allows a capability when every group has a pattern that matches it, whatever matching is. -/
def allows {κ : Type} (selects : Pattern → κ → Bool) (set : List (List Pattern)) (capability : κ) : Bool :=
  set.all (fun group => group.any (fun pattern => selects pattern capability))

/-! ## Containment -/

/-- `actionSubsumes`: `*` covers every action, a namespace wildcard its own namespace, an action itself. -/
def actionSubsumes (left right : Text) : Bool :=
  left == star || left == right ||
    ((utf16 ":*").isSuffixOf left && right != star && left.dropLast.isPrefixOf right)

/-- `resourceSubsumes`: the same text, `**`, or a `<prefix>/**` whose prefix directory holds the other. -/
def resourceSubsumes (left right : Text) : Bool :=
  left == right || left == anything ||
    ((utf16 "/**").isSuffixOf left && (left.take (left.length - 3) ++ [47]).isPrefixOf right)

/-- The action selects the filesystem: `*`, or one in the `fs:` namespace. -/
def selectsFilesystem (action : Text) : Bool := action == star || (utf16 "fs:").isPrefixOf action

/-- `.` or `..` -/
def isDotSegment (segment : Text) : Bool := segment == [46] || segment == [46, 46]

/-- `hasDotSegment`: a filesystem resource other than `/` with a `.`, `..` or empty path segment. -/
def hasDotSegment (action resource : Text) : Bool :=
  if !selectsFilesystem action || resource == [47] then false
  else (splitOn 47 resource).any isDotSegment || ((splitOn 47 resource).drop 1).contains []

/-- The index of the last `..` segment. -/
def lastParent : List Text → Option Nat
  | [] => none
  | segment :: rest =>
    match lastParent rest with
    | some index => some (index + 1)
    | none => if segment == [46, 46] then some 0 else none

/-- The segments kept so far, last first, after one more segment; nothing when a `..` climbs above the start. -/
def foldSegment (kept : Option (List Text)) (segment : Text) : Option (List Text) :=
  match kept with
  | none => none
  | some kept =>
    if segment == [] || segment == [46] then some kept
    else if segment == [46, 46] then
      match kept with
      | [] => none
      | _ :: below => some below
    else some (segment :: kept)

/-- `normalizeRelative`: drops `.` and empty segments and folds `name/..`; `.` for an empty result. -/
def normalizeRelative (resource : Text) : Option Text :=
  match (splitOn 47 resource).foldl foldSegment (some []) with
  | none => none
  | some [] => some [46]
  | some kept => some (joinWith 47 kept.reverse)

/-- The resource starts with a drive letter: `/^[A-Za-z]:/`. -/
def driveLetter : Text → Bool
  | letter :: 58 :: _ => (65 ≤ letter && letter ≤ 90) || (97 ≤ letter && letter ≤ 122)
  | _ => false

/--
`dotSegmentForms`: the forms a pattern must select for a filesystem resource with a dot or empty segment, or nothing
when no pattern may select it. Anything else is its own single form.
-/
def dotSegmentForms (action resource : Text) : Option (List Text) :=
  if !hasDotSegment action resource then some [resource]
  else if [47].isPrefixOf resource || resource.contains 92 || driveLetter resource || [126].isPrefixOf resource then
    none
  else if (match lastParent (splitOn 47 resource) with
    | some index => ((splitOn 47 resource).take index).any (fun segment => segment.contains 42 || segment.contains 63)
    | none => false) then none
  else
    match normalizeRelative resource with
    | none => none
    | some normal => some [resource, normal]

/-- `subsumes`: everything `right` selects is provably selected by `left`. -/
def subsumes (left right : Pattern) : Bool :=
  actionSubsumes left.action right.action &&
    (match dotSegmentForms right.action right.resource with
    | none => false
    | some forms => forms.all (resourceSubsumes left.resource))

/-- `CapabilitySet.within` over any covering test: each outer group covers every pattern of some inner group. -/
def withinBy (covers : Pattern → Pattern → Bool) (inner outer : List (List Pattern)) : Bool :=
  outer.all (fun group =>
    inner.any (fun candidate => candidate.all (fun pattern => group.any (fun cover => covers cover pattern))))

/-- `CapabilitySet.within`. -/
def within (inner outer : List (List Pattern)) : Bool := withinBy subsumes inner outer

/-- `ceilingWithin`. -/
def ceilingWithin (inner outer : List (List Text)) : Bool := within (authorityOf inner) (authorityOf outer)

end FlowSpec

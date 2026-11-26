import ChainSpec.JsonBoundary

/-!
# Authorization

The reference specification of `src/Authorize.ts` (`claimPattern`, `layerRules`) and of what it asks
`@smthrs/capability` for: `parsePattern`, `Permission.evaluate` over one ruleset, `subsumes` and `mayOverlap`.

A claim that names one exact capability is decided rule by rule, last match wins. A claim that names a set is
decided pattern to pattern: a rule covering the whole set is the last word, and a `deny` or `ask` that may cover
part of it can only raise the verdict. Across a request's claims `deny` beats `ask` beats `allow`.

Every text is its UTF-16 code units: `?` matches one code unit, and a resource is measured in code units.
-/

namespace ChainSpec

def colon : Nat := 58
def slash : Nat := 47
def star : Nat := 42
def question : Nat := 63
def dot : Nat := 46
def backslash : Nat := 92
def tilde : Nat := 126

-- --- text ----------------------------------------------------------------------------------------------------------

/-- `text.split(separator)`: never empty, an empty text is one empty piece. -/
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
  | piece :: rest => piece ++ separator :: joinWith separator rest

def startsWith (text start : Text) : Bool := start.isPrefixOf text

def endsWith (text ending : Text) : Bool := ending.isSuffixOf text

-- --- actions -------------------------------------------------------------------------------------------------------

/-- The exact actions a capability may name. -/
def actions : List Text :=
  [ "fs:read", "fs:write", "net:get", "net:post", "net:private", "model:call", "memory:read", "memory:write",
    "messages:read", "messages:write", "proc:spawn", "jj:status", "jj:diff", "jj:snapshot", "jj:restore",
    "jj:workspace-add", "jj:workspace-forget", "jj:root", "jj:revert", "jj:op-restore", "remote:acquire" ].map ascii

/-- The family selectors a pattern may name besides an exact action. -/
def families : List Text :=
  ["fs:*", "net:*", "model:*", "memory:*", "messages:*", "proc:*", "jj:*", "remote:*", "*"].map ascii

def isAction (action : Text) : Bool := actions.contains action

def isPatternAction (action : Text) : Bool := isAction action || families.contains action

def netPrivate : Text := ascii "net:private"

/-- Whether a pattern's action selects an exact action. -/
def matchesAction (pattern action : Text) : Bool :=
  pattern == [star] || pattern == action || (endsWith pattern [colon, star] && startsWith action pattern.dropLast)

/-- Whether every action the right selects, the left selects too. -/
def actionSubsumes (left right : Text) : Bool :=
  left == [star] || left == right ||
    (endsWith left [colon, star] && right != [star] && startsWith right left.dropLast)

-- --- resources -----------------------------------------------------------------------------------------------------

def maxResourceLength : Nat := 4096

def maxMatchWork : Nat := maxResourceLength * maxResourceLength

/-- Whether a predicate holds of some suffix of a text, the whole text and the empty one included. -/
def anySuffix (holds : Text → Bool) : Text → Bool
  | [] => holds []
  | unit :: rest => holds (unit :: rest) || anySuffix holds rest

/-- The glob: `*` is any run of code units, `?` is any one, everything else is itself. -/
def glob : Text → Text → Bool
  | [], resource => resource.isEmpty
  | unit :: pattern, resource =>
    if unit = star then anySuffix (glob pattern) resource
    else
      match resource with
      | [] => false
      | first :: rest => (unit == question || unit == first) && glob pattern rest

/--
Whether a pattern's resource matches a resource. An undecidable pair matches nothing. A pattern ending in ` *`
also matches the resource without its trailing argument text.
-/
def matchesResource (pattern resource : Text) : Bool :=
  if pattern.length * resource.length > maxMatchWork then false
  else (endsWith pattern [32, star] && glob pattern.dropLast.dropLast resource) || glob pattern resource

def isLiteralResource (resource : Text) : Bool := !(resource.contains star || resource.contains question)

def isDotSegment (segment : Text) : Bool := segment == [dot] || segment == [dot, dot]

def selectsFilesystem (action : Text) : Bool := action == [star] || startsWith action (ascii "fs:")

def hasDotSegment (action resource : Text) : Bool :=
  if !selectsFilesystem action || resource == [slash] then false
  else
    let segments := splitOn slash resource
    segments.any isDotSegment || (segments.drop 1).contains []

/-- The kept segments, most recent first, after dropping empty and `.` segments and resolving `..`. -/
def normalizeSegments : List Text → List Text → Option (List Text)
  | [], kept => some kept
  | segment :: rest, kept =>
    if segment == [] || segment == [dot] then normalizeSegments rest kept
    else if segment == [dot, dot] then
      match kept with
      | [] => none
      | _ :: outer => normalizeSegments rest outer
    else normalizeSegments rest (segment :: kept)

def normalizeRelative (resource : Text) : Option Text :=
  match normalizeSegments (splitOn slash resource) [] with
  | none => none
  | some [] => some [dot]
  | some kept => some (joinWith slash kept.reverse)

def isAsciiLetter (unit : Nat) : Bool := (65 ≤ unit && unit ≤ 90) || (97 ≤ unit && unit ≤ 122)

/-- `/^[A-Za-z]:/`. -/
def hasDrive : Text → Bool
  | letter :: second :: _ => isAsciiLetter letter && second == colon
  | _ => false

/-- The segments before the last `..`, when there is one. -/
def beforeLastParent : List Text → Option (List Text)
  | [] => none
  | segment :: rest =>
    match beforeLastParent rest with
    | some before => some (segment :: before)
    | none => if segment == [dot, dot] then some [] else none

def hasMetacharacter (segment : Text) : Bool := segment.contains star || segment.contains question

/--
The readings of a resource: itself, and for a filesystem resource with dot segments its normal form too. Nothing
when the resource has dot segments and no normal form to trust.
-/
def dotSegmentForms (action resource : Text) : Option (List Text) :=
  if !hasDotSegment action resource then some [resource]
  else if startsWith resource [slash] || resource.contains backslash || hasDrive resource
      || startsWith resource [tilde] then none
  else if ((beforeLastParent (splitOn slash resource)).getD []).any hasMetacharacter then none
  else
    match normalizeRelative resource with
    | none => none
    | some normal => some [resource, normal]

-- --- patterns ------------------------------------------------------------------------------------------------------

/-- A capability pattern, and with an exact action and a literal resource a capability. -/
structure Pattern where
  action : Text
  resource : Text
  deriving DecidableEq, Repr

/-- `Capability.parsePattern`. -/
def parsePattern (input : Text) : Option Pattern :=
  match splitOn colon input with
  | [] => none
  | first :: rest =>
    if first = [star] then
      match rest with
      | [] => some ⟨[star], [star, star]⟩
      | _ =>
        let resource := joinWith colon rest
        if resource.length ≤ maxResourceLength then some ⟨[star], resource⟩ else none
    else
      match rest with
      | operation :: more =>
        match more with
        | [] => none
        | _ =>
          let action := first ++ colon :: operation
          let resource := joinWith colon more
          if isPatternAction action && resource.length ≤ maxResourceLength then some ⟨action, resource⟩ else none
      | [] => none

/-- `Authorize.claimPattern`: a two-component claim with no resource claims the whole family. -/
def claimPattern (declared : Text) : Option Pattern :=
  match parsePattern declared with
  | some pattern => some pattern
  | none =>
    if (splitOn colon declared).length = 2 then parsePattern (declared ++ [colon, star, star]) else none

/-- The claim as one exact capability, when it names one. -/
def exactCapability (claim : Pattern) : Option Pattern :=
  if isLiteralResource claim.resource && isAction claim.action then some claim else none

def matchesCapability (pattern capability : Pattern) (forms : List Text) : Bool :=
  matchesAction pattern.action capability.action && forms.all (matchesResource pattern.resource)

def restricts (pattern capability : Pattern) (forms : List Text) : Bool :=
  matchesAction pattern.action capability.action && forms.any (matchesResource pattern.resource)

def withinMatchBudget (pattern capability : Pattern) : Bool :=
  !matchesAction pattern.action capability.action
    || pattern.resource.length * capability.resource.length ≤ maxMatchWork

def resourceSubsumes (left right : Text) : Bool :=
  left == right || left == [star, star] ||
    (endsWith left [slash, star, star] && startsWith right (left.dropLast.dropLast.dropLast ++ [slash]))

/-- Whether the left provably covers every capability the right selects. -/
def subsumes (left right : Pattern) : Bool :=
  actionSubsumes left.action right.action &&
    match dotSegmentForms right.action right.resource with
    | none => false
    | some forms => forms.all (resourceSubsumes left.resource)

def literalPrefix (resource : Text) : Text := resource.takeWhile fun unit => unit != star && unit != question

def resourcesMayOverlap (left right : Text) : Bool :=
  if isLiteralResource left && isLiteralResource right then left == right
  else
    let leftPrefix := literalPrefix left
    let rightPrefix := literalPrefix right
    let shared := min leftPrefix.length rightPrefix.length
    leftPrefix.take shared == rightPrefix.take shared

/-- Whether two patterns may select a capability in common: conservative, never a false no. -/
def mayOverlap (left right : Pattern) : Bool :=
  (actionSubsumes left.action right.action || actionSubsumes right.action left.action) &&
    resourcesMayOverlap left.resource right.resource

-- --- verdicts ------------------------------------------------------------------------------------------------------

inductive Effect where
  | allow
  | deny
  | ask
  deriving DecidableEq, Repr

structure Rule where
  effect : Effect
  pattern : Pattern
  deriving DecidableEq, Repr

/-- How permissive an effect is: `deny < ask < allow`. -/
def Effect.rank : Effect → Nat
  | .deny => 0
  | .ask => 1
  | .allow => 2

/-- At least as restrictive. -/
def Effect.le (left right : Effect) : Prop := left.rank ≤ right.rank

instance : LE Effect := ⟨Effect.le⟩

/-- The more restrictive of two effects. -/
def Effect.meet (left right : Effect) : Effect := if left.rank ≤ right.rank then left else right

/-- One rule against one exact capability: a match is the last word. -/
def stepExact (capability : Pattern) (forms : List Text) (verdict : Effect) (rule : Rule) : Effect :=
  if capability.action == netPrivate && rule.effect == .allow && rule.pattern.action != netPrivate then verdict
  else if (if rule.effect == .allow then matchesCapability rule.pattern capability forms
      else restricts rule.pattern capability forms) then rule.effect
  else verdict

/-- The rules in order against one exact capability; a rule too large to decide vetoes. -/
def evaluateRules (capability : Pattern) (forms : List Text) : List Rule → Effect → Effect
  | [], verdict => verdict
  | rule :: rest, verdict =>
    if withinMatchBudget rule.pattern capability then
      evaluateRules capability forms rest (stepExact capability forms verdict rule)
    else .deny

/-- `Permission.evaluate` over one ruleset. -/
def evaluateExact (rules : List Rule) (capability : Pattern) : Effect :=
  match dotSegmentForms capability.action capability.resource with
  | none => .deny
  | some forms => evaluateRules capability forms rules .ask

/-- One rule against a claimed set. -/
def stepPattern (claim : Pattern) (verdict : Effect) (rule : Rule) : Effect :=
  if subsumes rule.pattern claim then rule.effect
  else if rule.effect != .allow && mayOverlap rule.pattern claim && rule.effect.rank < verdict.rank then rule.effect
  else verdict

/-- `evaluatePattern`: the rules in order against a claimed set. -/
def evaluatePattern (rules : List Rule) (claim : Pattern) : Effect := rules.foldl (stepPattern claim) .ask

/-- The verdict for one declared claim: an unparseable claim asks. -/
def claimVerdict (rules : List Rule) (declared : Text) : Effect :=
  match claimPattern declared with
  | none => .ask
  | some claim =>
    match exactCapability claim with
    | some capability => evaluateExact rules capability
    | none => evaluatePattern rules claim

/-- What the seam answers: nothing to refuse, the first claim that asks, or the first claim that is denied. -/
inductive Decision where
  | allowed
  | approvalRequired (claim : Text)
  | denied (claim : Text)
  deriving DecidableEq, Repr

def Decision.effect : Decision → Effect
  | .allowed => .allow
  | .approvalRequired _ => .ask
  | .denied _ => .deny

/-- The seam's loop: a denied claim ends it, the first asking claim is remembered. -/
def decideClaims (rules : List Rule) : List Text → Option Text → Decision
  | [], none => .allowed
  | [], some asking => .approvalRequired asking
  | declared :: rest, asking =>
    match claimVerdict rules declared with
    | .deny => .denied declared
    | .allow => decideClaims rules rest asking
    | .ask => decideClaims rules rest (some (asking.getD declared))

/-- An empty claim set claims everything. -/
def effectiveClaims (claims : List Text) : List Text := if claims.isEmpty then [[star]] else claims

/-- `layerRules(rules).authorize({ capabilities: claims })`. -/
def authorize (rules : List Rule) (claims : List Text) : Decision := decideClaims rules (effectiveClaims claims) none

/-- The most restrictive verdict among the claims, said without an order. -/
def worstVerdict (rules : List Rule) (claims : List Text) : Effect :=
  (claims.map (claimVerdict rules)).foldr Effect.meet .allow

/-- The rule that denies everything. -/
def denyAll : Rule := ⟨.deny, ⟨[star], [star, star]⟩⟩

end ChainSpec

import CapabilitySpec.Basic

/-!
# The resource glob

`*` matches any run of code units, `?` matches exactly one, every other unit is itself. The grammar has no escape.
The specification is the textbook recursive definition; the implementation is a two-pointer scan that must agree.
-/

namespace CapabilitySpec

def star : Nat := 42
def question : Nat := 63
def space : Nat := 32
def slash : Nat := 47

/-- `accept` holds for some suffix of the text. -/
def anySuffix (accept : Text → Bool) : Text → Bool
  | [] => accept []
  | unit :: rest => accept (unit :: rest) || anySuffix accept rest

/-- The whole text is in the language of the pattern. -/
def glob : Text → Text → Bool
  | [], text => text.isEmpty
  | unit :: pattern, text =>
    if unit = star then anySuffix (glob pattern) text
    else
      match text with
      | [] => false
      | head :: tail => (unit = question ∨ unit = head) && glob pattern tail

/-- A pattern ending in ` *` without that ending: a command grant `npm *` also grants the bare `npm`. -/
def bare (pattern : Text) : Option Text :=
  match pattern.reverse with
  | 42 :: 32 :: rest => some rest.reverse
  | _ => none

/-- The match is within the work budget. -/
def withinWork (pattern text : Text) : Bool := pattern.length * text.length ≤ maxMatchWork

/-- `matchesResource`: the budgeted match of one resource form, with the bare-command rule. -/
def matchesResource (pattern text : Text) : Bool :=
  withinWork pattern text &&
    ((match bare pattern with
      | some command => glob command text
      | none => false) || glob pattern text)

/-- A resource the grammar reads as literal text: `isLiteralResource`. -/
def isLiteral (resource : Text) : Bool := resource.all fun unit => unit ≠ star ∧ unit ≠ question

/-- The leading run of a resource before its first metacharacter. -/
def literalPrefix : Text → Text
  | [] => []
  | unit :: rest => if unit = star ∨ unit = question then [] else unit :: literalPrefix rest

end CapabilitySpec

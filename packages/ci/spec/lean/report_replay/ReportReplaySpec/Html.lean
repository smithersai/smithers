/-
Reference specification of what keeps a repository's text from being read as markup or as terminal control:
`escape` of `packages/ci/src/report/Html.vibe` and `clean` of `packages/ci/src/report/Text.vibe`.
-/
import ReportReplaySpec.Format

namespace ReportReplaySpec

/-- The entity `Html.escape` writes for a code unit, or the unit itself. -/
def escapeUnit (c : Nat) : Str :=
  if c = 38 then u!"&amp;"
  else if c = 60 then u!"&lt;"
  else if c = 62 then u!"&gt;"
  else if c = 34 then u!"&quot;"
  else if c = 39 then u!"&#39;"
  else [c]

/-- `Html.escape`: `&`, `<`, `>`, `"` and `'` as entities, every other code unit as it is. -/
def escape (s : Str) : Str := s.flatMap escapeUnit

/-- What may follow an `&` in escaped text: the rest of one of the five entities. -/
def entityTails : List Str := [u!"amp;", u!"lt;", u!"gt;", u!"quot;", u!"#39;"]

/-- The text starts with the rest of an entity. -/
def startsEntity (s : Str) : Bool := entityTails.any fun tail => tail.isPrefixOf s

/-- A code unit HTML reads as markup, or as the end of an attribute's value. -/
def isMarkup (c : Nat) : Bool := c == 60 || c == 62 || c == 34 || c == 39

/-- Text that is safe as HTML text and as an attribute's value: no markup unit, and every `&` starts an entity. -/
def wellEscaped : Str → Bool
  | [] => true
  | c :: rest => (if c = 38 then startsEntity rest else !isMarkup c) && wellEscaped rest

/-- A code unit of the Unicode category `Cc`: C0, DEL and C1. -/
def isControl (c : Nat) : Bool := c ≤ 31 || (127 ≤ c && c ≤ 159)

/-- `Text.clean`: every control character as U+FFFD, so a label cannot move a terminal's cursor. -/
def clean (s : Str) : Str := s.map fun c => if isControl c then 0xFFFD else c

end ReportReplaySpec

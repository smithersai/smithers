/-
Reference specification of what takes a URL's user name and password out of text:
`withoutCredentials` of `packages/ci/src/replay/Summary.vibe` and `errorLine` of
`packages/ci/src/contract/Command.vibe`, for an error that is a string.
-/
import ReportReplaySpec.Format

namespace ReportReplaySpec

/-- `[a-z]` under the `i` flag. -/
def isLetter (c : Nat) : Bool := (65 ≤ c && c ≤ 90) || (97 ≤ c && c ≤ 122)

/-- `[a-z0-9+.-]` under the `i` flag: what a URL's scheme holds after its first letter. -/
def isSchemeUnit (c : Nat) : Bool := isLetter c || (48 ≤ c && c ≤ 57) || c == 43 || c == 45 || c == 46

/-- `[^/?#]`: a code unit of a URL's authority. -/
def isAuthorityUnit (c : Nat) : Bool := !(c == 47 || c == 63 || c == 35)

/-- What follows the last `@` of a text, or all of it when it has none. -/
def afterLastAt (s : Str) : Str := (s.reverse.takeWhile (· != 64)).reverse

/-- A text that starts with a scheme and `://`, split after them. -/
def splitScheme : Str → Option (Str × Str)
  | [] => none
  | c :: rest =>
    if isLetter c then
      match rest.dropWhile isSchemeUnit with
      | 58 :: 47 :: 47 :: after => some (c :: rest.takeWhile isSchemeUnit ++ u!"://", after)
      | _ => none
    else none

/-- The authority a URL's remainder starts with: all before the first `/`, `?` or `#`. -/
def authorityOf (after : Str) : Str := after.takeWhile isAuthorityUnit

/--
A URL without its user name and password: `replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i, "$1")`. The host
starts after the last `@` of the authority, so a password may hold one.
-/
def scrub (url : Str) : Str :=
  match splitScheme url with
  | none => url
  | some (scheme, after) =>
    if 64 ∈ authorityOf after then scheme ++ afterLastAt (authorityOf after) ++ after.dropWhile isAuthorityUnit
    else url

/-- `Summary.withoutCredentials`. -/
def withoutCredentials (remote : Str) : Str := scrub (trim remote)

/-- `[^\s"]`: a code unit of what follows a scheme in running text. -/
def isUrlUnit (c : Nat) : Bool := !(isSpace c || c == 34)

/-- The most code units a scheme has after its first letter: no real scheme is longer, and it bounds the search. -/
def schemeTail : Nat := 31

/--
A match of `/([a-z][a-z0-9+.-]{0,31}:\/*)[^\s"]*@/i` that starts at the code unit `c` before `rest`: what
stays of it, and the text after it. A match is a letter, a scheme's other code units, a `:`, and a run up to
the last `@` before white space or a quote. Only the scheme, the `:` and the slashes after it stay.
-/
def credentialAt (c : Nat) (rest : Str) : Option (Str × Str) :=
  if isLetter c = true ∧ (rest.takeWhile isSchemeUnit).length ≤ schemeTail then
    match rest.dropWhile isSchemeUnit with
    | 58 :: after =>
      if 64 ∈ after.takeWhile isUrlUnit then
        some (c :: rest.takeWhile isSchemeUnit ++ u!":" ++ after.takeWhile (· == 47),
          afterLastAt (after.takeWhile isUrlUnit) ++ after.dropWhile isUrlUnit)
      else none
    | _ => none
  else none

/--
`replace(/([a-z][a-z0-9+.-]{0,31}:\/*)[^\s"]*@/gi, "$1")`, reading left to right: the leftmost match is
replaced, and the search goes on after it. A match may start at any letter, whatever stands before it.
`fuel` is at least the text's length.
-/
def scrubAll (fuel : Nat) (s : Str) : Str :=
  match fuel, s with
  | _, [] => []
  | 0, s => s
  | fuel + 1, c :: rest =>
    match credentialAt c rest with
    | some (stays, remainder) => stays ++ scrubAll fuel remainder
    | none => c :: scrubAll fuel rest

/-- `replace(/\s+/g, " ")`: every run of white space as one space. -/
def collapse : Str → Str
  | [] => []
  | c :: rest =>
    if isSpace c then
      match rest with
      | d :: _ => if isSpace d then collapse rest else 32 :: collapse rest
      | [] => [32]
    else c :: collapse rest

/-- The longest error a line quotes, in code units. -/
def longest : Nat := 300

/--
`Command.errorLine` of an error that is a string: no URL's user name or password, one line, and no more than
300 code units before a `…`.
-/
def errorLine (cause : Str) : Str :=
  let line := trim (collapse (scrubAll cause.length cause))
  if line.length > longest then line.take longest ++ u!"…" else line

end ReportReplaySpec

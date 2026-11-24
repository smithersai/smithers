import ReportReplaySpec.Format

/-!
# Credential redaction in remotes and error lines

This module specifies `withoutCredentials` of `packages/ci/src/replay/Summary.vibe` and `errorLine` of
`packages/ci/src/contract/Command.vibe`, for an error that is a string.
-/

namespace ReportReplaySpec

/-- `[a-z]` under the `i` flag. -/
def isLetter (c : Nat) : Bool := (65 ≤ c && c ≤ 90) || (97 ≤ c && c ≤ 122)

/-- `[0-9]`. -/
def isRedactDigit (c : Nat) : Bool := 48 ≤ c && c ≤ 57

/-- `\w`: `[A-Za-z0-9_]`. -/
def isWord (c : Nat) : Bool := isLetter c || isRedactDigit c || c == 95

/-- `[a-z0-9+.-]` under the `i` flag: what a URL's scheme holds after its first letter. -/
def isSchemeUnit (c : Nat) : Bool := isLetter c || isRedactDigit c || c == 43 || c == 45 || c == 46

/-- `[^/?#]`: a code unit of a URL's authority in `Summary.withoutCredentials`. -/
def isAuthorityUnit (c : Nat) : Bool := !(c == 47 || c == 63 || c == 35)

/-- `[^\s/?#]`: a code unit of a URL's authority in running text (`Command.errorLine`). -/
def isLineAuthorityUnit (c : Nat) : Bool := !(isSpace c || c == 47 || c == 63 || c == 35)

/-- `[A-Za-z0-9+/.=_~-]`: a code unit of a Bearer/Basic token. -/
def isTokenUnit (c : Nat) : Bool :=
  isLetter c || isRedactDigit c || c == 43 || c == 47 || c == 46 || c == 61 || c == 95 || c == 126 || c == 45

/-- ASCII lowercase of a code unit. -/
def lowerAscii (c : Nat) : Nat := if 65 ≤ c && c ≤ 90 then c + 32 else c

/-- Case-insensitive prefix match against an ASCII lowercase pattern. -/
def matchCiPrefix : Str → Str → Option (Str × Str)
  | [], rest => some ([], rest)
  | _, [] => none
  | p :: ps, c :: cs =>
    if lowerAscii c == p then
      match matchCiPrefix ps cs with
      | some (matched, rem) => some (c :: matched, rem)
      | none => none
    else none

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

/-- The most code units a scheme has after its first letter: no real scheme is longer, and it bounds the search. -/
def schemeTail : Nat := 31

/--
A match of `/([a-z][a-z0-9+.-]{0,31}:\/\/)([^\s/?#]*)/i` that starts at the code unit `c` before `rest`: what
stays of it (`prefix + authority.slice(authority.lastIndexOf("@") + 1)`), and the text after the authority.
-/
def credentialAt (c : Nat) (rest : Str) : Option (Str × Str) :=
  if isLetter c = true ∧ (rest.takeWhile isSchemeUnit).length ≤ schemeTail then
    match rest.dropWhile isSchemeUnit with
    | 58 :: 47 :: 47 :: after =>
      let authority := after.takeWhile isLineAuthorityUnit
      let rem := after.dropWhile isLineAuthorityUnit
      -- A raw delimiter in a password makes the authority ambiguous. Consume through the final @ in this word.
      let word := rem.takeWhile (fun u => !isSpace u)
      let user := authority.takeWhile (fun u => u != 58 && u != 91 && u != 93)
      if 64 ∈ word ∧ 64 ∉ authority ∧ !(user.isEmpty) ∧ (authority.drop user.length).head? = some 58 then
        some (c :: rest.takeWhile isSchemeUnit ++ u!"://", rem.drop (word.length - (afterLastAt word).length))
      else some (c :: rest.takeWhile isSchemeUnit ++ u!"://" ++ afterLastAt authority, rem)
    | _ => none
  else none

/--
`replace(/([a-z][a-z0-9+.-]{0,31}:\/\/)([^\s/?#]*)/gi, (_, p, a) => p + a.slice(a.lastIndexOf("@") + 1))`,
reading left to right. `fuel` is at least the text's length.
-/
def scrubAll (fuel : Nat) (s : Str) : Str :=
  match fuel, s with
  | _, [] => []
  | 0, s => s
  | fuel + 1, c :: rest =>
    match credentialAt c rest with
    | some (stays, remainder) => stays ++ scrubAll fuel remainder
    | none => c :: scrubAll fuel rest

/-- A match of `/(Bearer|Basic)\s+[A-Za-z0-9+/.=_~-]+/i` at `s` when `afterWord` is false. -/
def authHeaderAt (s : Str) : Option (Str × Bool × Str) :=
  let tryKind (kw : Str) : Option (Str × Bool × Str) :=
    match matchCiPrefix kw s with
    | some (matched, afterKw) =>
      let spaces := afterKw.takeWhile isSpace
      if spaces.isEmpty then none
      else
        let afterSpaces := afterKw.dropWhile isSpace
        let token := afterSpaces.takeWhile isTokenUnit
        if token.isEmpty then none
        else
          let rem := afterSpaces.dropWhile isTokenUnit
          let endsWord := match token.reverse with
            | last :: _ => isWord last
            | [] => false
          some (matched ++ u!" [redacted]", endsWord, rem)
    | none => none
  match tryKind (u!"bearer") with
  | some hit => some hit
  | none => tryKind (u!"basic")

/-- `replace(/(Bearer|Basic)\s+[A-Za-z0-9+/.=_~-]+/gi, "$1 [redacted]")`. -/
def redactAuth (fuel : Nat) (afterWord : Bool) (s : Str) : Str :=
  match fuel, s with
  | _, [] => []
  | 0, s => s
  | fuel + 1, c :: rest =>
    if !afterWord then
      match authHeaderAt (c :: rest) with
      | some (stays, endsWord, remainder) => stays ++ redactAuth fuel endsWord remainder
      | none => c :: redactAuth fuel (isWord c) rest
    else c :: redactAuth fuel (isWord c) rest

/-- `replace(/\s+/g, " ")`: every run of white space as one space. -/
def collapse : Str → Str
  | [] => []
  | c :: rest =>
    if isSpace c then
      match rest with
      | d :: _ => if isSpace d then collapse rest else 32 :: collapse rest
      | [] => [32]
    else c :: collapse rest

/-- Query keys compared case-insensitively by the diagnostic redactor. -/
def secretKey (key : Str) : Bool :=
  let k := key.map lowerAscii
  [u!"sig", u!"key", u!"auth", u!"secret_key", u!"access_key", u!"secret_access_key"].any (· == k) || [u!"token", u!"secret", u!"password", u!"passwd", u!"signature", u!"credential", u!"apikey", u!"api-key", u!"api_key"].any (·.isSuffixOf k)

/-- Redact query values up to the next parameter, fragment or whitespace. -/
def redactQuery : Nat → Str → Str
  | _, [] => []
  | 0, s => s
  | fuel + 1, c :: rest =>
    let key := rest.takeWhile (fun u => isWord u || u == 45 || u == 46)
    match rest.drop key.length with
    | 61 :: value =>
      if (c == 63 || c == 38) && secretKey key then
        c :: key ++ u!"=[redacted]" ++ redactQuery fuel (value.dropWhile (fun u => !isSpace u && u != 35 && u != 38))
      else c :: redactQuery fuel rest
    | _ => c :: redactQuery fuel rest

/-- The longest error a line quotes, in code units. -/
def longest : Nat := 300

/--
`Command.errorLine` of an error that is a string: no URL's user name or password, no Bearer/Basic token,
one line, and no more than 300 code units before a `…`.
-/
def errorLine (cause : Str) : Str :=
  let scrubbed := scrubAll cause.length cause
  let queried := redactQuery scrubbed.length scrubbed
  let redacted := redactAuth queried.length false queried
  let line := trim (collapse redacted)
  if line.length > longest then line.take longest ++ u!"…" else line

end ReportReplaySpec

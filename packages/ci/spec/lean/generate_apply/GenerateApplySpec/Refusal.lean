import GenerateApplySpec.Units

/-!
# Smithers build's refusal in one line: `refusalOf` of `src/apply/Planned.vibe`

Smithers build prints why it refuses to plan a job's targets. `refusalOf` reduces everything it printed to one line:
the `message` of the last complete JSON record, else the last line that is no Node runtime warning. Terminal control
sequences are removed first, and `errorLine` of `src/contract/Command.vibe` removes a URL's credentials, joins the
white space and cuts the line at 300 characters.
-/

namespace GenerateApplySpec.Refusal

open GenerateApplySpec

/-- The escape character, which starts every terminal control sequence. -/
def esc : Nat := 27

/-- A parameter byte of a control sequence: `[0-?]`. -/
def isParameter (c : Nat) : Bool := decide (0x30 ≤ c) && decide (c ≤ 0x3F)

/-- An intermediate byte of a control sequence: a space through a slash. -/
def isIntermediate (c : Nat) : Bool := decide (0x20 ≤ c) && decide (c ≤ 0x2F)

/-- The final byte of a control sequence: `[@-~]`. -/
def isFinal (c : Nat) : Bool := decide (0x40 ≤ c) && decide (c ≤ 0x7E)

/--
How many units after an escape character belong to its control sequence (`[`, parameter bytes, intermediate bytes
and one final byte): none when the escape starts no complete sequence. The three classes share no unit, so the greedy match is the only one.
-/
def csiLength : Str → Nat
  | 91 :: body =>
    match (body.dropWhile isParameter).dropWhile isIntermediate with
    | final :: _ =>
      if isFinal final then
        (body.takeWhile isParameter).length + ((body.dropWhile isParameter).takeWhile isIntermediate).length + 2
      else 0
    | [] => 0
  | _ => 0

/-- `stripAnsi` with `skip` units of a control sequence still to drop. -/
def stripFrom : Nat → Str → Str
  | _, [] => []
  | skip + 1, _ :: rest => stripFrom skip rest
  | 0, c :: rest => if c = esc then stripFrom (csiLength rest) rest else c :: stripFrom 0 rest

/--
`text.replace(ansiControl, "")`, where `ansiControl` matches a control sequence or else one escape character:
every control sequence goes, and so does an escape character that starts none, so what is left can start no
control sequence.
-/
def stripAnsi (text : Str) : Str := stripFrom 0 text

/-- `s.startsWith(p)`, with what follows the prefix. -/
def afterPrefix (s p : Str) : Option Str := if p.isPrefixOf s then some (s.drop p.length) else none

/--
`nodeWarning`: `/^\(node:\d+\)\s+\w*Warning:|^\(Use `node --trace-warnings /` on a trimmed line. `Warning` ends the
run of word characters before the colon, because a colon is no word character.
-/
def isNodeWarning (line : Str) : Bool :=
  startsWith line (lit "(Use `node --trace-warnings ") ||
    match afterPrefix line (lit "(node:") with
    | none => false
    | some rest =>
      match rest.dropWhile isDigit with
      | 41 :: afterParen =>
        let afterSpaces := afterParen.dropWhile isSpace
        !(rest.takeWhile isDigit).isEmpty && !(afterParen.takeWhile isSpace).isEmpty &&
          endsWith (afterSpaces.takeWhile isWord) (lit "Warning") &&
          (afterSpaces.dropWhile isWord).head? == some 58
      | _ => false

/-- `[a-z0-9+.-]` in either case: a character of a URL's scheme. -/
def isSchemeUnit (c : Nat) : Bool := isAlpha c || isDigit c || c == 43 || c == 46 || c == 45

/-- The most code units a scheme holds after its first letter, bounding the search on long words. -/
def schemeTail : Nat := 31

/-- `[^\s/?#]`: a code unit of a URL authority in `errorLine`. -/
def isLineAuthorityUnit (c : Nat) : Bool := !(isSpace c || c == 47 || c == 63 || c == 35)

/-- `[A-Za-z0-9+/.=_~-]`: a code unit of a Bearer/Basic token. -/
def isTokenUnit (c : Nat) : Bool :=
  isAlpha c || isDigit c || c == 43 || c == 47 || c == 46 || c == 61 || c == 95 || c == 126 || c == 45

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

/--
A match of `credential`, `/([a-z][a-z0-9+.-]{0,31}:\/\/)([^\s/?#]*)/gi`, at `c :: rest`:
keeps `prefix + authority.slice(authority.lastIndexOf("@") + 1)` and resumes after the authority.
-/
def credentialAt (c : Nat) (rest : Str) : Option (Str × Str) :=
  let tail := rest.takeWhile isSchemeUnit
  if isAlpha c && tail.length ≤ schemeTail then
    match rest.dropWhile isSchemeUnit with
    | 58 :: 47 :: 47 :: after =>
      let authority := after.takeWhile isLineAuthorityUnit
      let rem := after.dropWhile isLineAuthorityUnit
      some (c :: tail ++ lit "://" ++ afterLastAt authority, rem)
    | _ => none
  else none

/-- `text.replace(credential, ...)`, scanning left to right. -/
def withoutCredentials : Nat → Str → Str
  | _, [] => []
  | 0, s => s
  | fuel + 1, c :: rest =>
    match credentialAt c rest with
    | some (stays, rem) => stays ++ withoutCredentials fuel rem
    | none => c :: withoutCredentials fuel rest

/-- A match of `/\b(Bearer|Basic)\s+[A-Za-z0-9+/.=_~-]+/i` at `s`. -/
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
          some (matched ++ lit " [redacted]", endsWord, rem)
    | none => none
  match tryKind (lit "bearer") with
  | some hit => some hit
  | none => tryKind (lit "basic")

/-- `text.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/.=_~-]+/gi, "$1 [redacted]")`. -/
def redactAuth : Nat → Bool → Str → Str
  | _, _, [] => []
  | 0, _, s => s
  | fuel + 1, afterWord, c :: rest =>
    if !afterWord then
      match authHeaderAt (c :: rest) with
      | some (stays, endsWord, rem) => stays ++ redactAuth fuel endsWord rem
      | none => c :: redactAuth fuel (isWord c) rest
    else c :: redactAuth fuel (isWord c) rest

/-- `text.replace(/\s+/g, " ")`. `inRun` says the unit before was white space. -/
def collapse : Bool → Str → Str
  | _, [] => []
  | inRun, c :: rest =>
    if isSpace c then (if inRun then collapse true rest else 32 :: collapse true rest)
    else c :: collapse false rest

/-- The longest error a line quotes. -/
def longest : Nat := 300

/-- `errorLine` of a string: no credentials, no Bearer/Basic token, one line, at most 300 characters and an ellipsis. -/
def errorLine (text : Str) : Str :=
  let scrubbed := withoutCredentials text.length text
  let redacted := redactAuth scrubbed.length false scrubbed
  let line := trim (collapse false redacted)
  if longest < line.length then line.take longest ++ [0x2026] else line

/-! ## `JSON.parse`, as far as a record's `message` -/

/-- The white space `JSON.parse` allows between tokens. -/
def isJsonSpace (c : Nat) : Bool := c == 32 || c == 9 || c == 10 || c == 13

/-- The text after any JSON white space. -/
def skipSpace (text : Str) : Str := text.dropWhile isJsonSpace

/-- The value of a hexadecimal digit. -/
def hexValue (c : Nat) : Option Nat :=
  if isDigit c then some (c - 48)
  else if 97 ≤ c ∧ c ≤ 102 then some (c - 87)
  else if 65 ≤ c ∧ c ≤ 70 then some (c - 55)
  else none

/-- What a one-letter escape of a JSON string stands for. -/
def escaped (c : Nat) : Option Nat :=
  if c = 34 ∨ c = 92 ∨ c = 47 then some c
  else if c = 98 then some 8
  else if c = 102 then some 12
  else if c = 110 then some 10
  else if c = 114 then some 13
  else if c = 116 then some 9
  else none

/-- A JSON string after its opening quote: its value and the text after its closing quote. -/
def parseString : Str → Option (Str × Str)
  | [] => none
  | c :: rest =>
    if c = 34 then some ([], rest)
    else if c = 92 then
      match rest with
      | 117 :: a :: b :: c :: d :: more =>
        match hexValue a, hexValue b, hexValue c, hexValue d, parseString more with
        | some a, some b, some c, some d, some (text, after) =>
          some ((a * 4096 + b * 256 + c * 16 + d) :: text, after)
        | _, _, _, _, _ => none
      | e :: more =>
        match escaped e, parseString more with
        | some unit, some (text, after) => some (unit :: text, after)
        | _, _ => none
      | [] => none
    else if c < 32 then none
    else
      match parseString rest with
      | some (text, after) => some (c :: text, after)
      | none => none
termination_by text => text.length

/-- One or more digits: the text after them. -/
def digits (text : Str) : Option Str :=
  match text with
  | c :: _ => if isDigit c then some (text.dropWhile isDigit) else none
  | [] => none

/-- A JSON number: the text after it. -/
def parseNumber (text : Str) : Option Str :=
  let unsigned := match text with
    | 45 :: rest => rest
    | _ => text
  let afterInteger := match unsigned with
    | 48 :: rest => some rest
    | _ => digits unsigned
  let afterFraction := match afterInteger with
    | some (46 :: rest) => digits rest
    | other => other
  match afterFraction with
  | some (e :: rest) =>
    if e = 101 ∨ e = 69 then
      match rest with
      | sign :: more => if sign = 43 ∨ sign = 45 then digits more else digits rest
      | [] => none
    else afterFraction
  | other => other

/-- What a JSON value is, as far as `typeof value === "string"` asks. -/
inductive Parsed where
  | text (value : Str)
  | other

mutual
  /-- A JSON value and the text after it. `fuel` bounds the calls; a text takes fewer than its length. -/
  def parseValue : Nat → Str → Option (Parsed × Str)
    | 0, _ => none
    | fuel + 1, text =>
      match text with
      | 34 :: rest => (parseString rest).map fun found => (Parsed.text found.1, found.2)
      | 123 :: rest => (parseMembers fuel none (skipSpace rest) true).map fun found => (Parsed.other, found.2)
      | 91 :: rest => (parseItems fuel (skipSpace rest) true).map fun after => (Parsed.other, after)
      | _ =>
        if startsWith text (lit "true") then some (Parsed.other, text.drop 4)
        else if startsWith text (lit "false") then some (Parsed.other, text.drop 5)
        else if startsWith text (lit "null") then some (Parsed.other, text.drop 4)
        else (parseNumber text).map fun after => (Parsed.other, after)

  /--
  The members of a JSON object, from its first key or its closing brace: the value of its last `message` key and
  the text after the object. `first` is false after a comma, where a member must follow.
  -/
  def parseMembers : Nat → Option Parsed → Str → Bool → Option (Option Parsed × Str)
    | 0, _, _, _ => none
    | fuel + 1, message, text, first =>
      match text with
      | 125 :: rest => if first then some (message, rest) else none
      | 34 :: rest =>
        match parseString rest with
        | none => none
        | some (key, afterKey) =>
          match skipSpace afterKey with
          | 58 :: afterColon =>
            match parseValue fuel (skipSpace afterColon) with
            | none => none
            | some (value, afterValue) =>
              let found := if key = lit "message" then some value else message
              match skipSpace afterValue with
              | 44 :: more => parseMembers fuel found (skipSpace more) false
              | 125 :: after => some (found, after)
              | _ => none
          | _ => none
      | _ => none

  /-- The items of a JSON array, from its first item or its closing bracket: the text after the array. -/
  def parseItems : Nat → Str → Bool → Option Str
    | 0, _, _ => none
    | fuel + 1, text, first =>
      match text, first with
      | 93 :: rest, true => some rest
      | _, _ =>
        match parseValue fuel text with
        | none => none
        | some (_, afterValue) =>
          match skipSpace afterValue with
          | 44 :: more => parseItems fuel (skipSpace more) false
          | 93 :: after => some after
          | _ => none
end

/--
`JSON.parse(text).message` for a text that starts with `{`: `none` when the text is no JSON, `some none` when the
record has no `message` that is a string.
-/
def recordMessage (text : Str) : Option (Option Str) :=
  match text with
  | 123 :: rest =>
    match parseMembers (2 * text.length + 4) none (skipSpace rest) true with
    | some (message, after) =>
      if (skipSpace after).isEmpty then
        some (match message with
          | some (.text value) => some value
          | _ => none)
      else none
    | none => none
  | _ => none

/-! ## The last complete record -/

/--
How many units after an opening quote the token `"(?:\\[^\r\n]|[^"\\\r\n])*"` holds, through its closing quote:
`none` when the line ends first, and the quote is then no token.
-/
def stringBody : Str → Option Nat
  | [] => none
  | c :: rest =>
    if c = 34 then some 1
    else if c = 13 ∨ c = 10 then none
    else if c = 92 then
      match rest with
      | e :: more => if e = 13 ∨ e = 10 then none else (stringBody more).map (· + 2)
      | [] => none
    else (stringBody rest).map (· + 1)
termination_by text => text.length

/-- A brace outside every quoted string, and where it is. -/
inductive Token where
  | opened (index : Nat)
  | closed (index : Nat)

/-- The braces of `text` from `index` on, with `skip` units of a quoted string still to pass. -/
def tokensFrom : Nat → Nat → Str → List Token
  | _, _, [] => []
  | skip + 1, index, _ :: rest => tokensFrom skip (index + 1) rest
  | 0, index, c :: rest =>
    if c = 34 then tokensFrom ((stringBody rest).getD 0) (index + 1) rest
    else if c = 123 then .opened index :: tokensFrom 0 (index + 1) rest
    else if c = 125 then .closed index :: tokensFrom 0 (index + 1) rest
    else tokensFrom 0 (index + 1) rest

/-- A record that is open: where it starts, its text so far with each finished child replaced, and the message
found before it opened. -/
structure Frame where
  start : Nat
  unread : Nat
  parts : Str
  previous : Option Str

/-- `text.slice(start, stop)`. -/
def slice (text : Str) (start stop : Nat) : Str := (text.drop start).take (stop - start)

/-- One brace: an opening brace opens a record, a closing brace finishes the innermost one. -/
def step (text : Str) (state : List Frame × Option Str) : Token → List Frame × Option Str
  | .opened index => ({ start := index, unread := index, parts := [], previous := state.2 } :: state.1, state.2)
  | .closed index =>
    match state.1 with
    | [] => state
    | frame :: outer =>
      let stop := index + 1
      let outcome : Str × Option Str :=
        match recordMessage (frame.parts ++ slice text frame.unread stop) with
        | none => ([63], state.2)
        | some found =>
          let words := match found with
            | some message => trim (stripAnsi message)
            | none => []
          ([123, 125], if words.isEmpty then frame.previous else some (errorLine words))
      match outer with
      | [] => ([], outcome.2)
      | parent :: rest =>
        ({ parent with
            parts := parent.parts ++ slice text parent.unread frame.start ++ outcome.1, unread := stop } :: rest,
          outcome.2)

/-- `messageIn`: the message of the last complete record of `text`. -/
def messageIn (text : Str) : Option Str := ((tokensFrom 0 0 text).foldl (step text) ([], none)).2

/-- The lines of what was printed that hold more than white space, without their control sequences. -/
def substantive (printed : Str) : List Str := (splitOn 10 (stripAnsi printed)).filter fun line => !(trim line).isEmpty

/-- The lines that are no Node runtime warning. -/
def useful (lines : List Str) : List Str := lines.filter fun line => !isNodeWarning (trim line)

/-- What nothing printed is called. -/
def nothing : Str := lit "it printed nothing"

/-- The line quoted when no record holds a message: the last useful line, else the last line, else that nothing was printed. -/
def fallback (kept lines : List Str) : Str :=
  match kept.getLast? with
  | some line => line
  | none =>
    match lines.getLast? with
    | some line => line
    | none => nothing

/-- `refusalOf` from the substantive lines: the last record's message, else the fallback line. -/
def refusalOfLines (lines : List Str) : Str :=
  match messageIn (joinWith [10] (useful lines)) with
  | some message => message
  | none => errorLine (fallback (useful lines) lines)

/-- `refusalOf`: Smithers build's own words for a refusal, in one line. -/
def refusalOf (printed : Str) : Str := refusalOfLines (substantive printed)

end GenerateApplySpec.Refusal

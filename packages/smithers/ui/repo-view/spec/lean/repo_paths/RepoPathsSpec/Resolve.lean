/-!
# Repository paths: the reference specification of `src/paths.ts`

A text is the list of its UTF-16 code units, which is how JavaScript holds a string. A lone surrogate and a NUL are
units like any other, so every string the implementation can be given has exactly one value here.

The functions specified are `parentOf`, `ancestorsOf`, `directoriesOf`, the percent-decoding of one link segment and
`resolveLink`.
-/

namespace RepoPathsSpec

/-- A JavaScript string: its UTF-16 code units. -/
abbrev Text := List Nat

/-! ## Splitting and joining on `/` (code unit 47) -/

/-- `text.split("/")`: never empty, and no piece holds a `/`. -/
def splitSlash : Text → List Text
  | [] => [[]]
  | c :: cs =>
    if c = 47 then [] :: splitSlash cs
    else
      match splitSlash cs with
      | [] => [[c]]
      | piece :: rest => (c :: piece) :: rest

/-- `pieces.join("/")`. -/
def joinSlash : List Text → Text
  | [] => []
  | [a] => a
  | a :: b :: rest => a ++ 47 :: joinSlash (b :: rest)

/-- `path.split("/").filter(Boolean)`: the non-empty pieces. -/
def parts (path : Text) : List Text := (splitSlash path).filter (fun piece => piece ≠ [])

/-! ## `parentOf`, `ancestorsOf`, `directoriesOf` -/

/-- The text before the last `/`, or the empty text when there is no `/`. -/
def parentOf (path : Text) : Text := joinSlash (splitSlash path).dropLast

/-- Every directory above `path`, outermost first: each proper, non-empty prefix of its parts. -/
def ancestorsOf (path : Text) : List Text :=
  (List.range ((parts path).length - 1)).map (fun index => joinSlash ((parts path).take (index + 1)))

/-- `set.add(text)` on a set held in insertion order. -/
def add (seen : List Text) (text : Text) : List Text := if text ∈ seen then seen else seen ++ [text]

/-- The directories the files sit under, then the ones `folders` names, each once, in insertion order. -/
def directoriesOf (paths folders : List Text) : List Text :=
  let under := paths.foldl (fun seen path => (ancestorsOf path).foldl add seen) []
  folders.foldl
    (fun seen folder => ((ancestorsOf folder ++ [folder]).filter (fun directory => directory ≠ [])).foldl add seen)
    under

/-! ## Percent-decoding one segment -/

/-- The value of a hexadecimal digit. -/
def hexVal (c : Nat) : Option Nat :=
  if 48 ≤ c ∧ c ≤ 57 then some (c - 48)
  else if 65 ≤ c ∧ c ≤ 70 then some (c - 55)
  else if 97 ≤ c ∧ c ≤ 102 then some (c - 87)
  else none

/-- A leading `%XX`: its byte and the text after it. -/
def escape : Text → Option (Nat × Text)
  | 37 :: a :: b :: rest =>
    match hexVal a, hexVal b with
    | some high, some low => some (high * 16 + low, rest)
    | _, _ => none
  | _ => none

/-- A leading `%XX` that is a UTF-8 continuation byte: its six bits and the text after it. -/
def continuation (text : Text) : Option (Nat × Text) :=
  match escape text with
  | some (byte, rest) => if 128 ≤ byte ∧ byte ≤ 191 then some (byte - 128, rest) else none
  | none => none

/--
Decodes the head of a non-empty text `c :: cs`: the first unit decoded, any further units, and the text left.

A unit that is not `%` is itself. A `%` that two hexadecimal digits do not follow is a literal `%`. An escape below
128 is that unit. Any other escape must begin a well-formed UTF-8 sequence of escapes, with no overlong form, no
surrogate and nothing above U+10FFFF; otherwise the segment is undecodable, as `decodeURIComponent` throws.
-/
def decodeStep (c : Nat) (cs : Text) : Option (Nat × Text × Text) :=
  if c ≠ 37 then some (c, [], cs)
  else
    match escape (c :: cs) with
    | none => some (37, [], cs)
    | some (byte, rest) =>
      if byte < 128 then some (byte, [], rest)
      else if byte < 192 then none
      else if byte < 224 then
        match continuation rest with
        | none => none
        | some (c1, r1) =>
          let point := (byte - 192) * 64 + c1
          if point < 128 then none else some (point, [], r1)
      else if byte < 240 then
        match continuation rest with
        | none => none
        | some (c1, r1) =>
          match continuation r1 with
          | none => none
          | some (c2, r2) =>
            let point := (byte - 224) * 4096 + c1 * 64 + c2
            if point < 2048 ∨ (55296 ≤ point ∧ point ≤ 57343) then none else some (point, [], r2)
      else if byte < 248 then
        match continuation rest with
        | none => none
        | some (c1, r1) =>
          match continuation r1 with
          | none => none
          | some (c2, r2) =>
            match continuation r2 with
            | none => none
            | some (c3, r3) =>
              let point := (byte - 240) * 262144 + c1 * 4096 + c2 * 64 + c3
              if point < 65536 ∨ 1114111 < point then none
              else some (55296 + (point - 65536) / 1024, [56320 + (point - 65536) % 1024], r3)
      else none

/-- `decodeStep` until the text is spent. Every step consumes a unit, so the text's length is fuel enough. -/
def decodeAux : Nat → Text → Option Text
  | _, [] => some []
  | 0, _ :: _ => none
  | fuel + 1, c :: cs =>
    match decodeStep c cs with
    | none => none
    | some (first, more, rest) =>
      match decodeAux fuel rest with
      | none => none
      | some tail => some (first :: (more ++ tail))

/-- One link segment percent-decoded, or `none` when it is undecodable. A literal `%` is kept. -/
def decodeSegment (segment : Text) : Option Text := decodeAux segment.length segment

/-! ## `resolveLink` -/

def isAlpha (c : Nat) : Bool := (65 ≤ c && c ≤ 90) || (97 ≤ c && c ≤ 122)

/-- A unit a scheme may hold after its first letter: a letter, a digit, `+`, `.` or `-`. -/
def isSchemeChar (c : Nat) : Bool := isAlpha c || (48 ≤ c && c ≤ 57) || c == 43 || c == 46 || c == 45

/-- Scheme units and then a `:` (58). -/
def schemeTail : Text → Bool
  | [] => false
  | c :: cs => if c = 58 then true else if isSchemeChar c then schemeTail cs else false

/-- `/^[a-zA-Z][a-zA-Z0-9+.-]*:/`. -/
def hasScheme : Text → Bool
  | [] => false
  | c :: cs => isAlpha c && schemeTail cs

/-- `href.startsWith("//")`. -/
def protocolRelative : Text → Bool
  | 47 :: 47 :: _ => true
  | _ => false

/-- The link without its query (`?`, 63) and its fragment (`#`, 35). -/
def bareOf (href : Text) : Text := href.takeWhile (fun c => c != 63 && c != 35)

inductive Kind where
  | tree
  | blob
  deriving DecidableEq, Repr

structure LinkTarget where
  kind : Kind
  path : Text
  deriving DecidableEq, Repr

/--
Walks the link's raw pieces over a stack of directories held innermost first. An empty piece and `.` stay, `..`
leaves a directory and refuses at the root, and any other piece enters a directory. A piece that is undecodable, or
decodes to a text holding `/` or NUL, refuses the link.
-/
def walk : List Text → List Text → Option (List Text)
  | stack, [] => some stack
  | stack, raw :: rest =>
    if raw = [] then walk stack rest
    else
      match decodeSegment raw with
      | none => none
      | some segment =>
        if 47 ∈ segment ∨ 0 ∈ segment then none
        else if segment = [46] then walk stack rest
        else if segment = [46, 46] then
          match stack with
          | [] => none
          | _ :: below => walk below rest
        else walk (segment :: stack) rest

/-- Where the walk starts: the root for a link that starts with `/`, the document's directory otherwise. -/
def baseOf (source bare : Text) : List Text := if bare.head? = some 47 then [] else parts (parentOf source)

/-- The link written as `href` in the document at `source`, resolved against the repository. -/
def resolveLink (source href : Text) (paths folders : List Text) : Option LinkTarget :=
  if hasScheme href = true ∨ protocolRelative href = true then none
  else if bareOf href = [] then none
  else
    match walk (baseOf source (bareOf href)).reverse (splitSlash (bareOf href)) with
    | none => none
    | some stack =>
      if joinSlash stack.reverse = [] ∨ (bareOf href).getLast? = some 47
          ∨ joinSlash stack.reverse ∈ directoriesOf paths folders then
        some { kind := .tree, path := joinSlash stack.reverse }
      else some { kind := .blob, path := joinSlash stack.reverse }

end RepoPathsSpec

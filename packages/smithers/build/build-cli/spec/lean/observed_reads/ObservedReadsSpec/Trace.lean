import ObservedReadsSpec.Text

/-!
# Reading a line of a trace

The specification of the lexical core of `read` in `ObservedReads.ts`: a line's process id (`pidOf`), a call's
name, arguments and answer (`callOf`), the arguments apart (`split`), a quoted path as the tracer escapes it
(`unquote`), and one spelling for a path (`spelled`). `openLine` puts them together for the call nearly every
line of a trace is: an `open` of a path, found or missing.

The functions read a text character by character. Every delimiter is ASCII, so the parts they return are the
same in UTF-16 code units and in Unicode scalar values.
-/
namespace ObservedReadsSpec

/-! ## `pidOf` -/

/-- The number a run of decimal digits writes. -/
def natOfDigits (digits : List Char) : Nat := digits.foldl (fun n (c : Char) => 10 * n + (c.toNat - 48)) 0

/--
`pidOf`: a line's process id and what follows the spaces after it, as `/^(\d+)\s+(.*)$/s` reads it; none for a
line that starts otherwise.
-/
def pidOf (line : String) : Option (Nat × String) :=
  let chars := line.toList
  let digits := chars.takeWhile isDigit
  let after := chars.dropWhile isDigit
  let rest := after.dropWhile isJsSpace
  if digits.isEmpty || rest.length == after.length then none
  else some (natOfDigits digits, String.ofList rest)

/-! ## `callOf` -/

/-- A call's name, the text between its brackets, and its answer. -/
structure Call where
  name : String
  body : String
  answer : String
  deriving Repr, DecidableEq

/--
`callOf`: a call as `/^(\w+)\((.*)\)\s+= (.*)$/s` reads it. The answer follows the last `= ` that has white
space before it and, before that, a `)` past the name's `(`.
-/
def callOf (text : String) : Option Call :=
  let chars := text.toList.toArray
  let name := (chars.toList.takeWhile isWord).length
  if name == 0 || chars[name]? != some '(' then none
  else
    let fits (equals : Nat) : Option Call :=
      if chars[equals]? == some '=' && chars[equals + 1]? == some ' ' then
        let before := (chars.toList.take equals).reverse
        let spaces := (before.takeWhile isJsSpace).length
        let close := equals - spaces
        if spaces == 0 || close ≤ name + 1 || chars[close - 1]? != some ')' then none
        else
          some {
            name := String.ofList (chars.toList.take name)
            body := String.ofList ((chars.toList.take (close - 1)).drop (name + 1))
            answer := String.ofList (chars.toList.drop (equals + 2))
          }
      else none
    ((List.range chars.size).reverse.filter (fun equals => equals > name)).findSome? fits

/-! ## `split` -/

/-- Where the scan of a call's arguments stands. -/
inductive Scan where
  /-- Between strings and descriptors. -/
  | plain
  /-- Inside a string; `escaped` says an odd run of backslashes came just before. -/
  | text (escaped : Bool)
  /-- Inside a descriptor's path, after its `<`. -/
  | descriptor

/-- `/^(?:\d+|AT_FDCWD)$/` of the part so far, trimmed: what a descriptor's `<` follows. -/
def namesDescriptor (part : List Char) : Bool :=
  let name := trimJs part
  (!name.isEmpty && name.all isDigit) || name == "AT_FDCWD".toList

/--
The scan of `split`. `part` holds the argument under way, last character first; `parts` the arguments done,
last one first. A comma splits only outside every string, bracket and descriptor's path. A descriptor's path
ends at the `>` that ends the text or comes before a comma and a space.
-/
def splitScan : Scan → Int → List Char → List String → List Char → List String × List Char
  | _, _, part, parts, [] => (parts, part)
  | .text escaped, depth, part, parts, c :: rest =>
    if c == '"' && !escaped then splitScan .plain depth (c :: part) parts rest
    else splitScan (.text (c == '\\' && !escaped)) depth (c :: part) parts rest
  | .descriptor, depth, part, parts, c :: rest =>
    let closes := c == '>' &&
      (match rest with
        | [] => true
        | [_] => false
        | next :: after :: _ => next == ',' && isJsSpace after)
    splitScan (if closes then .plain else .descriptor) depth (c :: part) parts rest
  | .plain, depth, part, parts, c :: rest =>
    if c == '"' then splitScan (.text false) depth (c :: part) parts rest
    else if c == '<' && depth == 0 && namesDescriptor part.reverse then
      splitScan .descriptor depth (c :: part) parts rest
    else if c == '{' || c == '[' || c == '(' then splitScan .plain (depth + 1) (c :: part) parts rest
    else if c == '}' || c == ']' || c == ')' then splitScan .plain (depth - 1) (c :: part) parts rest
    else if c == ',' && depth == 0 then splitScan .plain depth [] (String.ofList (trimJs part.reverse) :: parts) rest
    else splitScan .plain depth (c :: part) parts rest

/--
`split`: a call's arguments, split at the commas that are not inside a string, a structure or a descriptor's
path, each trimmed. No argument at all for an empty text.
-/
def split (text : String) : List String :=
  let (parts, part) := splitScan .plain 0 [] [] text.toList
  let last := String.ofList (trimJs part.reverse)
  if last != "" || !parts.isEmpty then (last :: parts).reverse else []

/-! ## `unquote` -/

/-- The UTF-8 bytes of a character. -/
def utf8Bytes (c : Char) : List UInt8 := (String.singleton c).toUTF8.toList

/-- The byte a one-letter escape stands for. -/
def simpleEscape (c : Char) : Option UInt8 :=
  if c == '"' then some 0x22
  else if c == '\\' then some 0x5c
  else if c == 'n' then some 0x0a
  else if c == 't' then some 0x09
  else if c == 'r' then some 0x0d
  else if c == 'v' then some 0x0b
  else if c == 'f' then some 0x0c
  else if c == 'a' then some 0x07
  else if c == 'b' then some 0x08
  else if c == 'e' then some 0x1b
  else none

def octalValue (digits : List Char) : UInt8 :=
  (digits.foldl (fun n (c : Char) => 8 * n + (c.toNat - 48)) 0 % 256).toUInt8

/--
The bytes a quoted string's body stands for: a one-letter escape, `\x` and two hexadecimal digits, or a
backslash and one to three octal digits; any other character is its own UTF-8 bytes. None where a backslash
is followed by anything else, or by nothing.
-/
def unescape : List Char → Option (List UInt8)
  | [] => some []
  | '\\' :: rest =>
    match rest with
    | [] => none
    | c :: after =>
      match simpleEscape c with
      | some byte => (unescape after).map (byte :: ·)
      | none =>
        match c, after with
        | 'x', h1 :: h2 :: tail =>
          if isHex h1 && isHex h2 then (unescape tail).map ((16 * hexValue h1 + hexValue h2).toUInt8 :: ·) else none
        | o1, o2 :: o3 :: tail =>
          if isOctal o1 && isOctal o2 && isOctal o3 then (unescape tail).map (octalValue [o1, o2, o3] :: ·)
          else if isOctal o1 && isOctal o2 then (unescape (o3 :: tail)).map (octalValue [o1, o2] :: ·)
          else if isOctal o1 then (unescape (o2 :: o3 :: tail)).map (octalValue [o1] :: ·)
          else none
        | o1, [o2] =>
          if isOctal o1 && isOctal o2 then some [octalValue [o1, o2]]
          else if isOctal o1 then (unescape [o2]).map (octalValue [o1] :: ·)
          else none
        | o1, [] => if isOctal o1 then some [octalValue [o1]] else none
  | c :: rest => (unescape rest).map (utf8Bytes c ++ ·)

/-- Where a UTF-8 decoder stands: the bytes still needed, the code point so far, and the next byte's bounds. -/
structure Decoder where
  needed : Nat := 0
  point : Nat := 0
  lower : Nat := 0x80
  upper : Nat := 0xBF

/-- U+FFFD, written where bytes are no UTF-8. -/
def replacement : Char := Char.ofNat 0xFFFD

/-- A byte read with no sequence under way: the characters it gives, and where the decoder stands after it. -/
def decodeLead (byte : Nat) : List Char × Decoder :=
  if byte < 0x80 then ([Char.ofNat byte], {})
  else if 0xC2 ≤ byte && byte ≤ 0xDF then ([], { needed := 1, point := byte % 0x20 })
  else if 0xE0 ≤ byte && byte ≤ 0xEF then
    ([], { needed := 2, point := byte % 0x10, lower := if byte == 0xE0 then 0xA0 else 0x80,
           upper := if byte == 0xED then 0x9F else 0xBF })
  else if 0xF0 ≤ byte && byte ≤ 0xF4 then
    ([], { needed := 3, point := byte % 0x08, lower := if byte == 0xF0 then 0x90 else 0x80,
           upper := if byte == 0xF4 then 0x8F else 0xBF })
  else ([replacement], {})

/--
Decodes UTF-8 as `Buffer.prototype.toString("utf8")` does (the WHATWG decoder): each maximal run of bytes that
starts no character is one U+FFFD, and the byte that ended it is read again.
-/
def decodeUtf8 : Decoder → List UInt8 → List Char
  | state, [] => if state.needed == 0 then [] else [replacement]
  | state, byte :: rest =>
    let value := byte.toNat
    if state.needed == 0 then
      let (out, next) := decodeLead value
      out ++ decodeUtf8 next rest
    else if state.lower ≤ value && value ≤ state.upper then
      let point := state.point * 0x40 + value % 0x40
      if state.needed == 1 then Char.ofNat point :: decodeUtf8 {} rest
      else decodeUtf8 { needed := state.needed - 1, point := point } rest
    else
      let (out, next) := decodeLead value
      replacement :: out ++ decodeUtf8 next rest

/--
`unquote`: a quoted string as the tracer prints it, decoded; none when it is cut short or malformed. A string
with no backslash is itself.
-/
def unquote (text : String) : Option String :=
  let chars := text.toList
  if chars.length < 2 || chars.head? != some '"' || chars.getLast? != some '"' then none
  else
    let body := (chars.drop 1).dropLast
    if !body.contains '\\' then some (String.ofList body)
    else (unescape body).map fun bytes => String.ofList (decodeUtf8 {} bytes)

/--
A string with no backslash stands for its own UTF-8 bytes: the shortcut `unquote` takes for such a string
skips only an encoding and a decoding of the same text.
-/
theorem unescape_of_no_backslash (body : List Char) (plain : '\\' ∉ body) :
    unescape body = some (body.flatMap utf8Bytes) := by
  induction body with
  | nil => simp [unescape]
  | cons c rest step =>
    have differs : c ≠ '\\' := fun same => plain (same ▸ List.mem_cons_self)
    have later : '\\' ∉ rest := fun held => plain (List.mem_cons_of_mem _ held)
    unfold unescape
    split
    · rename_i same
      cases same
    · rename_i same
      cases same
      exact absurd rfl differs
    · rename_i head tail _ same
      cases same
      simp [step later]

/-- A string cut short inside an escape is no string: `unquote` never guesses the byte that was lost. -/
theorem unescape_dangling : unescape ['\\'] = none := by
  simp [unescape]

/-! ## `spelled` -/

/-- `replaceAll(/\/(?:\.?\/)+/g, "/")`: after a slash, every `/` and `./` that follows at once is dropped. -/
def collapse : Bool → List Char → List Char
  | _, [] => []
  | true, '/' :: rest => collapse true rest
  | true, '.' :: '/' :: rest => collapse true rest
  | _, c :: rest => c :: collapse (c == '/') rest

/--
`spelled`: one spelling for a path: no `//`, no `/./`, no `/.` or `/` at its end. A slash at the end stays
after a line terminator, which the expression's `.` does not match.
-/
def spelled (path : String) : String :=
  let collapsed := collapse false path.toList
  let reversed := collapsed.reverse
  let undotted := match reversed with
    | '.' :: '/' :: rest => rest
    | other => other
  let bare := undotted.dropWhile (· == '/')
  let trimmed :=
    if bare.length == undotted.length then undotted
    else match bare with
      | [] => undotted.take 1
      | before :: _ => if isJsLineEnd before then '/' :: bare else bare
  if trimmed.isEmpty then "/" else String.ofList trimmed.reverse

/-! ## An `open` line -/

/-- What one line of a trace says, for the lines this specification reads. -/
inductive Seen where
  /-- The run found the path. -/
  | found (path : String)
  /-- The run found nothing at the path. -/
  | missing (path : String)
  /-- The line holds a path that cannot be read: the run stores nothing. -/
  | unreadable (argument : String)
  /-- Not a line this specification reads. -/
  | other
  deriving Repr, DecidableEq

/--
What `read` makes of the line `<pid> openat(AT_FDCWD, <path>, O_RDONLY) = <answer>` for a process whose working
directory is `cwd`: the path found, or missing when the answer is `ENOENT` or `ENOTDIR`. An absolute path is
spelled as it is, a relative one from `cwd`, and an empty one names `cwd` itself.
-/
def openLine (cwd : String) (line : String) : Seen :=
  match pidOf line with
  | none => .other
  | some (_, rest) =>
    match callOf rest with
    | none => .other
    | some call =>
      let answer := call.answer
      let failed := answer.startsWith "-1 "
      let errno := if failed then ((answer.splitOn " ").drop 1).head? else none
      let gone := errno == some "ENOENT" || errno == some "ENOTDIR"
      let answered := if failed then gone else answer.toList.all isDigit && !answer.isEmpty
      if call.name != "openat" || !answered then .other
      else
        match split call.body with
        | [directory, argument, flags] =>
          if directory != "AT_FDCWD" || flags != "O_RDONLY" then .other
          else
            match unquote argument with
            | none => .unreadable argument
            | some text =>
              let path :=
                if text.startsWith "/" then spelled text
                else if text == "" then cwd
                else spelled (cwd ++ "/" ++ text)
              if gone then .missing path else .found path
        -- A backslash before the closing quote takes the flags into the string: no path can be read from it.
        | [directory, argument] =>
          if directory == "AT_FDCWD" && (unquote argument).isNone then .unreadable argument else .other
        | _ => .other

end ObservedReadsSpec

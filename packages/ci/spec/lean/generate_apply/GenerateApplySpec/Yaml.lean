import GenerateApplySpec.Units

/-!
# The YAML writer: `src/generate/Yaml.vibe`

The writer writes a string plain where YAML reads it back as the same string, and otherwise as a block scalar or a
quoted string. A mapping key is written plain, or double-quoted when it is no name YAML reads back as itself, and as an
explicit key (`? key`) past the 1024 characters YAML allows an implicit key.

Whether a parser reads a plain scalar back as the same string is the answer of a YAML parser (`readsBack`, the `yaml`
package under YAML 1.2 and 1.1). No parser is specified here: every string carries that answer with it.
-/

namespace GenerateApplySpec.Yaml

open GenerateApplySpec

/-- The longest line the writer writes. -/
def width : Nat := 80

/-- The spaces ESLint's `yml/no-irregular-whitespace` reports outside a quoted string. -/
def irregular (c : Nat) : Bool :=
  c == 0x1680 || c == 0x180e || c == 0x2028 || c == 0x2029 || c == 0x202f || c == 0x205f || c == 0x3000 ||
    c == 0xfeff

/-- `escapes`: a character no plain or block scalar holds as it is. The line feed is not one. -/
def escapes (c : Nat) : Bool :=
  (decide (c ≤ 0x1f) && c != 0x0a) || (decide (0x7f ≤ c) && decide (c ≤ 0xa0)) ||
    (decide (0x2000 ≤ c) && decide (c ≤ 0x200b)) || irregular c

/-- `needsEscape`. -/
def needsEscape (value : Str) : Bool := value.any escapes

/-- What a double-quoted string holds for one code unit. -/
def escapeUnit (c : Nat) : Str :=
  if c = 9 then [92, 116]
  else if c = 13 then [92, 114]
  else if c = 10 then [92, 110]
  else if c = 34 then [92, 34]
  else if c = 92 then [92, 92]
  else if escapes c then [92, 117] ++ hex4 c
  else [c]

/-- `doubleQuoted`. -/
def doubleQuoted (value : Str) : Str := [34] ++ value.flatMap escapeUnit ++ [34]

/-- `singleQuoted`. -/
def singleQuoted (value : Str) : Str := [39] ++ value.flatMap (fun c => if c = 39 then [39, 39] else [c]) ++ [39]

/-- `quoted`: double quotes when the text needs an escape or holds a single quote. -/
def quoted (value : Str) : Str :=
  if needsEscape value || value.contains 10 || value.contains 39 then doubleQuoted value else singleQuoted value

/-- The first characters that start something else than a plain scalar. -/
def indicators : List Nat := [44, 91, 93, 123, 125, 35, 38, 42, 33, 124, 62, 39, 34, 37, 64, 96]

/-- Every check `isPlain` makes before it asks a parser. -/
def plainShape (value : Str) : Bool :=
  match value with
  | [] => false
  | first :: rest =>
    trim value == value && !value.contains 10 && !needsEscape value && !indicators.contains first &&
      !((first == 45 || first == 63 || first == 58) && (rest.isEmpty || rest.head? == some 32)) &&
      !hasInfix value [58, 32] && !hasInfix value [32, 35] && !endsWith value [58]

/-- `isPlain`, given whether both YAML versions read the value back. -/
def isPlain (value : Str) (readsBack : Bool) : Bool := plainShape value && readsBack

/-- `words`, from the unit after `previous`. `word` holds the word so far, last unit first. -/
def wordsFrom (outside : Bool) : Option Nat → Bool → Str → Str → List Str
  | _, _, word, [] => [word.reverse]
  | previous, inside, word, c :: rest =>
    let opened := if startsWith (c :: rest) [36, 123, 123] then true else inside
    let within := if startsWith (c :: rest) [125, 125] then false else opened
    if c == 32 && previous != some 32 && rest.head? != some 32 && !(outside && within) then
      word.reverse :: wordsFrom outside (some c) within [] rest
    else wordsFrom outside (some c) within (c :: word) rest

/-- `words`: the words between the spaces a string can be folded at. -/
def words (value : Str) (outside : Bool) : List Str := wordsFrom outside none false [] value

/-- The greedy fill of `fold`: `lines` holds the finished lines, last first. -/
def fill (room : Nat) : List Str → Str → List Str → List Str
  | lines, line, [] => (line :: lines).reverse
  | lines, line, word :: rest =>
    if line.isEmpty then fill room lines word rest
    else if line.length + 1 + word.length ≤ room then fill room lines (line ++ [32] ++ word) rest
    else fill room (line :: lines) word rest

/-- `fold`: a single-line string as lines at most `room` long where its words allow. -/
def fold (value : Str) (room : Nat) : List Str :=
  fill room [] [] ((words value true).flatMap fun one => if room < one.length then words one false else [one])

/-- `" ".repeat(indent)`. -/
def pad (indent : Nat) : Str := List.replicate indent 32

/-- `scalarLines`: the lines of a string written after `head`. -/
def scalarLines (head value : Str) (readsBack : Bool) (indent : Nat) : List Str :=
  if isPlain value readsBack && decide (head.length + 1 + value.length ≤ width) then [head ++ [32] ++ value]
  else if !value.contains 10 then
    if value.isEmpty || trim value != value || needsEscape value then [head ++ [32] ++ quoted value]
    else (head ++ [32, 62, 45]) :: (fold value (width - indent)).map (pad indent ++ ·)
  else
    let body := (value.reverse.dropWhile (· == 10)).reverse
    let lines := splitOn 10 body
    let leading := match lines.find? (!·.isEmpty) with
      | some line => startsWith line [32]
      | none => false
    let literal := !(trim body).isEmpty && !needsEscape body && !lines.any (fun line => trimEnd line != line) &&
      !leading
    if !literal then [head ++ [32] ++ quoted value]
    else
      let ending := value.length - body.length
      let chomp := if ending = 0 then [45] else if ending = 1 then [] else [43]
      (head ++ [32, 124] ++ chomp) :: lines.map (fun line => if line.isEmpty then [] else pad indent ++ line) ++
        List.replicate (ending - 1) []

/-- `text.split(/\s+/)` less its empty words. `word` holds the word so far, last unit first. -/
def spaceWords : Str → Str → List Str
  | word, [] => if word.isEmpty then [] else [word.reverse]
  | word, c :: rest =>
    if isSpace c then (if word.isEmpty then spaceWords [] rest else word.reverse :: spaceWords [] rest)
    else spaceWords (c :: word) rest

/-- `commentLines`: a comment's lines at `indent`, wrapped at spaces to the width. -/
def commentLines (text : Str) (indent : Nat) : List Str :=
  let found := spaceWords [] text
  if found.isEmpty then [pad indent ++ [35]]
  else (fold (joinWith [32] found) (width - indent - 2)).map (pad indent ++ [35, 32] ++ ·)

/-- The words `ordinaryKey` leaves to `isPlain`: YAML 1.1 reads each as a boolean or null. -/
def reservedWords : List Str :=
  [lit "y", lit "yes", lit "n", lit "no", lit "on", lit "off", lit "true", lit "false", lit "null"]

/-- A unit of `[a-z0-9_-]`, in either case. -/
def keyUnit (c : Nat) : Bool := isAlpha c || isDigit c || c == 95 || c == 45

/-- `ordinaryKey`: `/^(?!(?:y|yes|n|no|on|off|true|false|null)$)[a-z_][a-z0-9_-]*$/i`. -/
def ordinaryKey (key : Str) : Bool :=
  match key with
  | [] => false
  | c :: rest => (isAlpha c || c == 95) && rest.all keyUnit && !reservedWords.contains (lowerStr key)

/--
`<<`, the one name that reads back as itself as a value and not as a key: YAML 1.1 merges the mapping after it into
the mapping it is a key of.
-/
def mergeKey : Str := [60, 60]

/-- The key as `mappingHead` writes it: as given when it is safe, else double-quoted. -/
def keyName (key : Str) (readsBack : Bool) (indent : Nat) : Str :=
  if (indent == 0 && key == [111, 110]) || ordinaryKey key || (key != mergeKey && isPlain key readsBack) then key
  else doubleQuoted key

/-- The longest implicit key YAML allows. -/
def longestImplicitKey : Nat := 1024

/-- `mappingHead`: a key and its colon, as an explicit key past the longest implicit one. -/
def mappingHead (key : Str) (readsBack : Bool) (indent : Nat) : Str :=
  let name := keyName key readsBack indent
  if name.length ≤ longestImplicitKey then pad indent ++ name ++ [58]
  else pad indent ++ [63, 32] ++ name ++ [10] ++ pad indent ++ [58]

mutual
  /-- A value the writer writes. A string carries whether a YAML parser reads it back plain. -/
  inductive Value where
    | str (text : Str) (readsBack : Bool)
    | int (value : Int)
    | bool (value : Bool)
    | mapping (entries : Entries)
    | sequence (items : Items)

  /-- The entries of a mapping: each a key, its value and the comments written before it. -/
  inductive Entries where
    | nil
    | cons (key : Str) (readsBack : Bool) (value : Value) (comments : List Str) (tail : Entries)

  /-- The items of a sequence: each a value and the comments written before it. -/
  inductive Items where
    | nil
    | cons (value : Value) (comments : List Str) (tail : Items)
end

/-- `String(value)` for an integer. -/
def intText (value : Int) : Str := if value < 0 then 45 :: decimal value.natAbs else decimal value.natAbs

/-- The line of a collection's first entry or item after its dash. -/
def dashed (indent : Nat) (comments : List Str) (lines : List Str) : List Str :=
  match lines with
  | [] => []
  | head :: rest =>
    comments.flatMap (commentLines · indent) ++ [pad indent ++ [45, 32] ++ head.drop (indent + 2)] ++ rest

mutual
  /-- `valueLines`: the lines of a value after `head`; a collection's own lines start at `indent`. -/
  def valueLines (head : Str) (indent : Nat) : Value → List Str
    | .str text readsBack => scalarLines head text readsBack indent
    | .int value => [head ++ [32] ++ intText value]
    | .bool value => [head ++ [32] ++ (if value then lit "true" else lit "false")]
    | .mapping entries =>
      match entries with
      | .nil => [head ++ [32, 123, 125]]
      | .cons .. => head :: entriesLines indent false entries
    | .sequence items =>
      match items with
      | .nil => [head ++ [32, 91, 93]]
      | .cons .. => head :: itemsLines indent false items

  /-- `mappingLines`. `bare` leaves out the comments of the first entry, which a dash before it has taken. -/
  def entriesLines (indent : Nat) (bare : Bool) : Entries → List Str
    | .nil => []
    | .cons key readsBack value comments tail =>
      (if bare then [] else comments.flatMap (commentLines · indent)) ++
        valueLines (mappingHead key readsBack indent) (indent + 2) value ++ entriesLines indent false tail

  /-- `sequenceLines`. An item that is a collection starts on its dash's line. -/
  def itemsLines (indent : Nat) (bare : Bool) : Items → List Str
    | .nil => []
    | .cons value comments tail =>
      (if bare then [] else comments.flatMap (commentLines · indent)) ++
        (match value with
          | .mapping entries =>
            match entries with
            | .nil => [pad indent ++ [45, 32, 123, 125]]
            | .cons _ _ _ first _ => dashed indent first (entriesLines (indent + 2) true entries)
          | .sequence items =>
            match items with
            | .nil => [pad indent ++ [45, 32, 91, 93]]
            | .cons _ first _ => dashed indent first (itemsLines (indent + 2) true items)
          | .str text readsBack => scalarLines (pad indent ++ [45]) text readsBack (indent + 2)
          | .int number => [pad indent ++ [45, 32] ++ intText number]
          | .bool flag => [pad indent ++ [45, 32] ++ (if flag then lit "true" else lit "false")]) ++
        itemsLines indent false tail
end

/-- `document`: the header comments, `---`, the mapping and a final newline. -/
def document (root : Entries) (header : List Str) : Str :=
  joinWith [10] (header.flatMap (commentLines · 0) ++ [[45, 45, 45]] ++ entriesLines 0 false root ++ [[]])

end GenerateApplySpec.Yaml

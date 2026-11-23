/-
Text as JavaScript reads it: one-character case mappings, white space, and UTF-16 code units.

The implementation runs on JavaScript strings, which are sequences of UTF-16 code units. Lean strings are
sequences of Unicode scalar values. The two agree on every well-formed text, and a text with a lone surrogate
has no Lean counterpart: such texts are outside this specification.
-/
import InventorySpec.CaseTables

namespace InventorySpec

/-- The image of a code point under a generated case table, or the code point itself. -/
def mapCodePoint (table : Array (Nat × Nat × Nat × Nat)) (c : Nat) : Nat :=
  match table.find? (fun (lo, hi, stride, _) => lo ≤ c && c ≤ hi && (c - lo) % stride == 0) with
  | some (lo, _, _, image) => image + (c - lo)
  | none => c

/-- `toUpperCase` of one character, kept only when the result has the character's length: what `fold` compares by. -/
def foldChar (c : Char) : Char :=
  let n := c.toNat
  if n < 0x80 then (if 'a'.toNat ≤ n && n ≤ 'z'.toNat then Char.ofNat (n - 32) else c)
  else Char.ofNat (mapCodePoint upperRanges n)

/-- Text without case, one character at a time: `é` equals `É`, and `ß` does not equal `SS`. -/
def fold (text : List Char) : List Char := text.map foldChar

/--
`toLowerCase` of one character. U+0130 becomes `i` and a combining dot. The final form of sigma, which depends on
the characters around it, is not modelled: a capital sigma is outside this specification.
-/
def lowerChar (c : Char) : List Char :=
  let n := c.toNat
  if n < 0x80 then [if 'A'.toNat ≤ n && n ≤ 'Z'.toNat then Char.ofNat (n + 32) else c]
  else if n == 0x130 then ['i', Char.ofNat 0x307]
  else [Char.ofNat (mapCodePoint lowerRanges n)]

/-- `String.prototype.toLowerCase`. -/
def lower (text : List Char) : List Char := text.flatMap lowerChar

/-- `lower` on strings. -/
def lowerString (text : String) : String := String.ofList (lower text.toList)

/-- The characters `\s` and `trim` count as space. -/
def isSpace (c : Char) : Bool :=
  let n := c.toNat
  (9 ≤ n && n ≤ 13) || n == 0x20 || n == 0xA0 || n == 0x1680 || (0x2000 ≤ n && n ≤ 0x200A)
    || n == 0x2028 || n == 0x2029 || n == 0x202F || n == 0x205F || n == 0x3000 || n == 0xFEFF

/-- `String.prototype.trim`. -/
def trim (text : List Char) : List Char :=
  ((text.dropWhile isSpace).reverse.dropWhile isSpace).reverse

/-- The UTF-16 code units of a text. -/
def utf16 (text : List Char) : List Nat :=
  text.flatMap fun c =>
    let n := c.toNat
    if n < 0x10000 then [n] else [0xD800 + (n - 0x10000) / 0x400, 0xDC00 + (n - 0x10000) % 0x400]

/-- The text of UTF-16 code units. A surrogate without its pair becomes U+FFFD. -/
def ofUtf16 : List Nat → List Char
  | [] => []
  | [u] => [if 0xD800 ≤ u && u ≤ 0xDFFF then Char.ofNat 0xFFFD else Char.ofNat u]
  | u :: v :: rest =>
    if 0xD800 ≤ u && u ≤ 0xDBFF && 0xDC00 ≤ v && v ≤ 0xDFFF then
      Char.ofNat (0x10000 + (u - 0xD800) * 0x400 + (v - 0xDC00)) :: ofUtf16 rest
    else (if 0xD800 ≤ u && u ≤ 0xDFFF then Char.ofNat 0xFFFD else Char.ofNat u) :: ofUtf16 (v :: rest)

/-- `a < b` on code units, as JavaScript orders strings. -/
def unitsLt : List Nat → List Nat → Bool
  | [], [] => false
  | [], _ :: _ => true
  | _ :: _, [] => false
  | a :: as, b :: bs => a < b || (a == b && unitsLt as bs)

/-- `a < b` on texts, by UTF-16 code unit. -/
def textLt (a b : List Char) : Bool := unitsLt (utf16 a) (utf16 b)

/-- Whether `needle` starts `text`. -/
def startsWith {α : Type} [BEq α] (needle text : List α) : Bool := needle.isPrefixOf text

/-- `String.prototype.includes`. -/
def includes {α : Type} [BEq α] (needle : List α) : List α → Bool
  | [] => needle.isEmpty
  | c :: rest => startsWith needle (c :: rest) || includes needle rest

/-- The digits of a number in lower-case hexadecimal, at least `width` of them. -/
def hexDigits (n width : Nat) : List Char :=
  let digits := Nat.toDigits 16 n
  List.replicate (width - digits.length) '0' ++ digits

/-- The pieces of a text between each occurrence of one character: `text.split(separator)`. -/
def splitOn {α : Type} [BEq α] (separator : α) : List α → List (List α)
  | [] => [[]]
  | c :: rest =>
    if c == separator then [] :: splitOn separator rest
    else match splitOn separator rest with
      | [] => [[c]]
      | first :: more => (c :: first) :: more

end InventorySpec

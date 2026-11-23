/-
Reference specification of `bytesOf` of `packages/ci/src/replay/Names.ts`: the bytes of a file name as git
prints it, in double quotes with C escapes, or as it is when it needs none.
-/
import ReportReplaySpec.Format

namespace ReportReplaySpec

/-- An octal digit. -/
def isOctal (c : Nat) : Bool := 48 ≤ c && c ≤ 55

/-- `Number.parseInt(text, 8)` of a text that starts with an octal digit: its leading octal digits. -/
def octalValue (text : Str) : Nat := (text.takeWhile isOctal).foldl (fun value d => value * 8 + (d - 48)) 0

/-- The byte an escape letter stands for; a letter git never writes gives zero, as `Uint8Array.from` does. -/
def escapeByte (c : Nat) : Nat :=
  if c = 97 then 7 else if c = 98 then 8 else if c = 116 then 9 else if c = 110 then 10
  else if c = 118 then 11 else if c = 102 then 12 else if c = 114 then 13
  else if c = 34 then 34 else if c = 92 then 92 else 0

/--
The bytes of what stands between the quotes. The argument is the text after the opening quote, with the
closing quote: the last code unit is never read as a byte. A code unit that is no backslash is its low eight
bits; a backslash before an octal digit reads up to three digits and always moves four code units on; any
other backslash reads one escape letter.
-/
def decodeQuoted : Str → List Nat
  | c :: next :: rest =>
    if c ≠ 92 then c % 256 :: decodeQuoted (next :: rest)
    else if isOctal next then octalValue ((next :: rest).take 3) % 256 :: decodeQuoted (rest.drop 2)
    else escapeByte next :: decodeQuoted rest
  | _ => []
termination_by s => s.length
decreasing_by all_goals (simp only [List.length_cons, List.length_drop]; omega)

/-- A UTF-16 surrogate. -/
def isSurrogate (c : Nat) : Bool := 0xD800 ≤ c && c ≤ 0xDFFF

/-- The UTF-8 bytes of a code point. -/
def utf8Of (cp : Nat) : List Nat :=
  if cp < 0x80 then [cp]
  else if cp < 0x800 then [0xC0 + cp / 64, 0x80 + cp % 64]
  else if cp < 0x10000 then [0xE0 + cp / 4096, 0x80 + cp / 64 % 64, 0x80 + cp % 64]
  else [0xF0 + cp / 262144, 0x80 + cp / 4096 % 64, 0x80 + cp / 64 % 64, 0x80 + cp % 64]

/-- `new TextEncoder().encode`: a surrogate pair is one code point, a lone surrogate is U+FFFD. -/
def utf8 : Str → List Nat
  | [] => []
  | [c] => utf8Of (if isSurrogate c then 0xFFFD else c)
  | hi :: lo :: rest =>
    if 0xD800 ≤ hi && hi ≤ 0xDBFF && 0xDC00 ≤ lo && lo ≤ 0xDFFF then
      utf8Of (0x10000 + (hi - 0xD800) * 0x400 + (lo - 0xDC00)) ++ utf8 rest
    else utf8Of (if isSurrogate hi then 0xFFFD else hi) ++ utf8 (lo :: rest)
termination_by s => s.length
decreasing_by all_goals (simp only [List.length_cons]; omega)

/-- `Names.bytesOf`. -/
def bytesOf (shown : Str) : List Nat :=
  match shown with
  | 34 :: inside => decodeQuoted inside
  | _ => utf8 shown

/-- How git writes one byte of a name it quotes (`quote_c_style`, with `core.quotePath`). -/
def quoteByte (b : Nat) : Str :=
  if b = 7 then u!"\\a" else if b = 8 then u!"\\b" else if b = 9 then u!"\\t" else if b = 10 then u!"\\n"
  else if b = 11 then u!"\\v" else if b = 12 then u!"\\f" else if b = 13 then u!"\\r"
  else if b = 34 then u!"\\\"" else if b = 92 then u!"\\\\"
  else if b < 32 ∨ 127 ≤ b then [92, 48 + b / 64, 48 + b / 8 % 8, 48 + b % 8]
  else [b]

/-- A name's bytes as git prints them in double quotes. -/
def gitQuote (bytes : List Nat) : Str := 34 :: bytes.flatMap quoteByte ++ [34]

end ReportReplaySpec

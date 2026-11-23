/-!
# JavaScript strings as UTF-16 code units

`packages/ci` is VibeLang that runs as JavaScript, and every rule specified here reads a string one UTF-16 code unit
at a time: a regular expression without the `u` flag, `length`, `slice`, `charCodeAt`. The specification therefore
holds a string as the list of its code units, so a lone surrogate, which no Lean `String` holds, is an ordinary value.
-/

namespace GenerateApplySpec

/-- A JavaScript string: its UTF-16 code units, in order. -/
abbrev Str := List Nat

/-- The code units of a literal. Used for ASCII and other Basic Multilingual Plane text only. -/
def lit (s : String) : Str := s.toList.map Char.toNat

/-- `\s` of a JavaScript regular expression, and what `trim` removes: white space and line terminators. -/
def isSpace (c : Nat) : Bool :=
  c == 9 || c == 10 || c == 11 || c == 12 || c == 13 || c == 32 || c == 0xA0 || c == 0x1680 ||
    (decide (0x2000 ≤ c) && decide (c ≤ 0x200A)) || c == 0x2028 || c == 0x2029 || c == 0x202F || c == 0x205F ||
    c == 0x3000 || c == 0xFEFF

/-- `[0-9]`. -/
def isDigit (c : Nat) : Bool := decide (48 ≤ c) && decide (c ≤ 57)

/-- `[A-Z]`. -/
def isUpper (c : Nat) : Bool := decide (65 ≤ c) && decide (c ≤ 90)

/-- `[a-z]`. -/
def isLower (c : Nat) : Bool := decide (97 ≤ c) && decide (c ≤ 122)

/-- `[A-Za-z]`. -/
def isAlpha (c : Nat) : Bool := isUpper c || isLower c

/-- `\w`: `[A-Za-z0-9_]`. -/
def isWord (c : Nat) : Bool := isAlpha c || isDigit c || c == 95

/-- `toLowerCase` of one ASCII code unit; every other unit is left as it is. -/
def lower (c : Nat) : Nat := if isUpper c then c + 32 else c

/-- `toLowerCase` of an ASCII string. -/
def lowerStr (s : Str) : Str := s.map lower

/-- `trimStart`. -/
def trimStart (s : Str) : Str := s.dropWhile isSpace

/-- `trimEnd`. -/
def trimEnd (s : Str) : Str := (s.reverse.dropWhile isSpace).reverse

/-- `trim`. -/
def trim (s : Str) : Str := trimEnd (trimStart s)

/-- `s.startsWith(p)`. -/
def startsWith (s p : Str) : Bool := p.isPrefixOf s

/-- `s.endsWith(p)`. -/
def endsWith (s p : Str) : Bool := p.isSuffixOf s

/-- `s.includes(p)`. -/
def hasInfix : Str → Str → Bool
  | [], p => p.isEmpty
  | c :: cs, p => p.isPrefixOf (c :: cs) || hasInfix cs p

/-- `s.split(sep)` for a separator of one code unit: never empty, and one longer than the count of separators. -/
def splitOn (sep : Nat) : Str → List Str
  | [] => [[]]
  | c :: cs =>
    if c = sep then [] :: splitOn sep cs
    else
      match splitOn sep cs with
      | [] => [[c]]
      | s :: ss => (c :: s) :: ss

/-- `parts.join(sep)`. -/
def joinWith (sep : Str) : List Str → Str
  | [] => []
  | [a] => a
  | a :: b :: rest => a ++ sep ++ joinWith sep (b :: rest)

/-- One lower-case hexadecimal digit. -/
def hexDigit (d : Nat) : Nat := if d < 10 then 48 + d else 87 + d

/-- A code unit as four lower-case hexadecimal digits. -/
def hex4 (n : Nat) : Str :=
  [hexDigit (n / 4096 % 16), hexDigit (n / 256 % 16), hexDigit (n / 16 % 16), hexDigit (n % 16)]

/-- `n.toString(16)`. -/
def hexOf (n : Nat) : Str := (Nat.toDigits 16 n).map Char.toNat

/-- `String(n)` for a natural number. -/
def decimal (n : Nat) : Str := (Nat.toDigits 10 n).map Char.toNat

/-- A high (leading) surrogate. -/
def isHigh (c : Nat) : Bool := decide (0xD800 ≤ c) && decide (c ≤ 0xDBFF)

/-- A low (trailing) surrogate. -/
def isLow (c : Nat) : Bool := decide (0xDC00 ≤ c) && decide (c ≤ 0xDFFF)

/-- What `JSON.stringify` writes for one code unit that is no surrogate. -/
def jsonUnit (c : Nat) : Str :=
  if c = 34 then [92, 34]
  else if c = 92 then [92, 92]
  else if c = 8 then [92, 98]
  else if c = 12 then [92, 102]
  else if c = 10 then [92, 110]
  else if c = 13 then [92, 114]
  else if c = 9 then [92, 116]
  else if c < 32 then [92, 117] ++ hex4 c
  else [c]

/-- The text of `JSON.stringify(s)` between its quotes. A surrogate without its pair is written as an escape. -/
def jsonBody : Str → Str
  | [] => []
  | [c] => if isHigh c || isLow c then [92, 117] ++ hex4 c else jsonUnit c
  | c :: d :: rest =>
    if isHigh c && isLow d then c :: d :: jsonBody rest
    else if isHigh c || isLow c then [92, 117] ++ hex4 c ++ jsonBody (d :: rest)
    else jsonUnit c ++ jsonBody (d :: rest)

/-- `JSON.stringify(s)` for a string. -/
def jsonQuote (s : Str) : Str := [34] ++ jsonBody s ++ [34]

end GenerateApplySpec

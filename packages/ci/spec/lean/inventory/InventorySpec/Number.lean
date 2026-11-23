/-
Numbers as JavaScript reads and writes them.

A number is an IEEE 754 double, which Lean's `Float` is. Reading a decimal and writing the shortest decimal that
reads back are defined here with exact arithmetic on natural numbers, so nothing depends on a C library.
-/
import InventorySpec.Unicode

namespace InventorySpec

/-- The double with these bits. -/
def floatOfBits (negative : Bool) (bits : Nat) : Float :=
  Float.ofBits ((if negative then 2 ^ 63 + bits else bits).toUInt64)

/-- Infinity with a sign. -/
def infinity (negative : Bool) : Float := floatOfBits negative (2047 * 2 ^ 52)

/-- Not a number. -/
def nan : Float := floatOfBits false (2047 * 2 ^ 52 + 2 ^ 51)

/-- The double nearest `num / den`, ties to even: IEEE 754 rounding of an exact fraction. -/
def ratToFloat (negative : Bool) (num den : Nat) : Float :=
  if num == 0 || den == 0 then floatOfBits negative 0
  else
    -- 2 ^ (e - 1) < num / den < 2 ^ (e + 1)
    let e : Int := (num.log2 : Int) - (den.log2 : Int)
    let scaled (shift : Int) : Nat × Nat :=
      if shift ≥ 0 then (num * 2 ^ shift.toNat, den) else (num, den * 2 ^ (-shift).toNat)
    let first := scaled (52 - e)
    -- The shift that leaves 53 bits before the point, held to the smallest exponent a double has.
    let shift : Int := min (if first.1 / first.2 < 2 ^ 52 then 53 - e else 52 - e) 1074
    let (n, d) := scaled shift
    let q := n / d
    let r := n % d
    let q := if 2 * r > d || (2 * r == d && q % 2 == 1) then q + 1 else q
    let (q, shift) : Nat × Int := if q ≥ 2 ^ 53 then (q / 2, shift - 1) else (q, shift)
    if q ≥ 2 ^ 52 then
      let exponent := 1075 - shift
      if exponent ≥ 2047 then infinity negative
      else floatOfBits negative (exponent.toNat * 2 ^ 52 + (q - 2 ^ 52))
    else floatOfBits negative q

/-- A finite double as `mantissa * 2 ^ exponent`, without its sign. -/
def floatParts (x : Float) : Nat × Int :=
  let bits := x.toBits.toNat % 2 ^ 63
  let e : Nat := bits / 2 ^ 52
  let f : Nat := bits % 2 ^ 52
  if e == 0 then (f, -1074) else (f + 2 ^ 52, (e : Int) - 1075)

/-- A finite double as an exact fraction, without its sign. -/
def floatRat (x : Float) : Nat × Nat :=
  let (m, e) := floatParts x
  if e ≥ 0 then (m * 2 ^ e.toNat, 1) else (m, 2 ^ (-e).toNat)

/-- Whether the sign bit is set. -/
def isNegative (x : Float) : Bool := x.toBits.toNat ≥ 2 ^ 63

/-- `Number.isInteger`. -/
def isInteger (x : Float) : Bool :=
  x.isFinite && (let (n, d) := floatRat x; n % d == 0)

/-- The natural number a double is, when it is one. -/
def floatNat? (x : Float) : Option Nat :=
  if isInteger x && (x == 0 || !isNegative x) then (let (n, d) := floatRat x; some (n / d)) else none

/-- The double nearest `mantissa * 10 ^ exponent`. -/
def decToFloat (negative : Bool) (mantissa : Nat) (exponent : Int) : Float :=
  if mantissa == 0 then floatOfBits negative 0
  else
    let digits : Int := (Nat.toDigits 10 mantissa).length
    if digits + exponent > 310 then infinity negative
    else if digits + exponent < -326 then floatOfBits negative 0
    else if exponent ≥ 0 then ratToFloat negative (mantissa * 10 ^ exponent.toNat) 1
    else ratToFloat negative mantissa (10 ^ (-exponent).toNat)

/-- `num / den < 10 ^ n`. -/
def belowPow10 (num den : Nat) (n : Int) : Bool :=
  if n ≥ 0 then num < den * 10 ^ n.toNat else num * 10 ^ (-n).toNat < den

/-- The `n` with `10 ^ (n - 1) ≤ num / den < 10 ^ n`, found from an estimate by steps of one. -/
def decimalExponent (num den : Nat) : Int :=
  let estimate : Int := ((num.log2 : Int) - (den.log2 : Int)) * 30103 / 100000
  let rec up (fuel : Nat) (n : Int) : Int :=
    match fuel with
    | 0 => n
    | fuel + 1 => if belowPow10 num den n then n else up fuel (n + 1)
  let rec down (fuel : Nat) (n : Int) : Int :=
    match fuel with
    | 0 => n
    | fuel + 1 => if belowPow10 num den (n - 1) then down fuel (n - 1) else n
  down 8 (up 8 estimate)

/--
A positive fraction to `k` significant digits: `(m, n)` with `10 ^ (k - 1) ≤ m < 10 ^ k` and `m * 10 ^ (n - k)`
nearest the fraction. A tie goes up with `halfUp`, as `toPrecision` and `toExponential` round, and to even without.
-/
def roundSignificant (num den k : Nat) (halfUp : Bool) : Nat × Int :=
  let n := decimalExponent num den
  let p : Int := n - k
  let (a, b) := if p ≥ 0 then (num, den * 10 ^ p.toNat) else (num * 10 ^ (-p).toNat, den)
  let q := a / b
  let r := a % b
  let q := if 2 * r > b || (2 * r == b && (halfUp || q % 2 == 1)) then q + 1 else q
  if q ≥ 10 ^ k then (10 ^ (k - 1), n + 1) else (q, n)

/-- How far `m * 10 ^ p` is from `num / den`, on a scale both candidates of one `p` share. -/
def distance (num den m : Nat) (p : Int) : Nat :=
  let (a, b) := if p ≥ 0 then (m * 10 ^ p.toNat * den, num) else (m * den, num * 10 ^ (-p).toNat)
  if a ≥ b then a - b else b - a

/--
The shortest decimal that reads back as a positive finite double: its digits as a number `m` of `k` digits and
the `n` with value `m * 10 ^ (n - k)`. Of the decimals of that length that read back, it is the nearest.
-/
def shortest (x : Float) : Nat × Nat × Int :=
  let (num, den) := floatRat x
  let readsBack (m : Nat) (p : Int) : Bool := (decToFloat false m p).toBits == x.toBits
  let rec search (fuel k : Nat) : Nat × Nat × Int :=
    let (m, n) := roundSignificant num den k false
    let p : Int := n - k
    match fuel with
    | 0 => (k, m, n)
    | fuel + 1 =>
      let near := [m, m + 1, m - 1].filter fun c => 10 ^ (k - 1) ≤ c && c < 10 ^ k && readsBack c p
      match near with
      | [] => search fuel (k + 1)
      | first :: more =>
        (k, more.foldl (fun best c => if distance num den c p < distance num den best p then c else best) first, n)
  search 16 1

/-- The digits of a natural number. -/
def natDigits (n : Nat) : List Char := Nat.toDigits 10 n

/-- `Number.prototype.toString` of a positive finite double. -/
def positiveText (x : Float) : List Char :=
  let (k, m, n) := shortest x
  let digits := natDigits m
  let zeros (count : Int) : List Char := List.replicate count.toNat '0'
  if (k : Int) ≤ n && n ≤ 21 then digits ++ zeros (n - k)
  else if 0 < n && n ≤ 21 then digits.take n.toNat ++ '.' :: digits.drop n.toNat
  else if -6 < n && n ≤ 0 then '0' :: '.' :: zeros (-n) ++ digits
  else
    let e := n - 1
    let exponent := (if e < 0 then '-' else '+') :: natDigits e.natAbs
    match digits with
    | [] => []
    | [d] => d :: 'e' :: exponent
    | d :: rest => d :: '.' :: rest ++ 'e' :: exponent

/-- `String(number)`. -/
def jsNumberText (x : Float) : List Char :=
  if x.isNaN then "NaN".toList
  else if x == 0 then ['0']
  else
    let sign := if isNegative x then ['-'] else []
    if x.isInf then sign ++ "Infinity".toList else sign ++ positiveText x.abs

/--
A number as GitHub's runner writes it: with 15 significant digits, and with an exponent, as `1.23456789012346E+17`
or `1.234E-06`, when the number has more digits before the point than that or starts more than four zeros after it.
-/
def numberText (x : Float) : List Char :=
  if !x.isFinite || (isInteger x && x.abs < 1e15) then jsNumberText x
  else
    let sign := if isNegative x then ['-'] else []
    let (num, den) := floatRat x
    let (m, n) := roundSignificant num den 15 true
    let power := n - 1
    if -5 ≤ power && power < 15 then sign ++ jsNumberText (decToFloat false m (n - 15))
    else
      let digits := (natDigits m).reverse.dropWhile (· == '0') |>.reverse
      let mantissa := match digits with
        | [] => []
        | [d] => [d]
        | d :: rest => d :: '.' :: rest
      let exponent := natDigits power.natAbs
      sign ++ mantissa ++ 'E' :: (if power < 0 then '-' else '+')
        :: (List.replicate (2 - exponent.length) '0' ++ exponent)

/-- Whether a character is a decimal digit. -/
def isDigit (c : Char) : Bool := '0' ≤ c && c ≤ '9'

/-- The value of a hexadecimal digit. -/
def hexValue? (c : Char) : Option Nat :=
  if isDigit c then some (c.toNat - '0'.toNat)
  else if 'a' ≤ c && c ≤ 'f' then some (c.toNat - 'a'.toNat + 10)
  else if 'A' ≤ c && c ≤ 'F' then some (c.toNat - 'A'.toNat + 10)
  else none

/-- The number digits spell in a base, or `none` when one of them is not a digit of it. -/
def digitsValue? (base : Nat) (digits : List Char) : Option Nat :=
  digits.foldl (fun so_far c => do
    let n ← so_far
    let d ← hexValue? c
    if d < base then some (n * base + d) else none) (some 0)

/-- The decimal number digits spell. -/
def decimalValue (digits : List Char) : Nat := (digitsValue? 10 digits).getD 0

/--
What a decimal literal reads to: the digits before the point, the digits after it, and the exponent with its sign.
-/
structure Decimal where
  whole : List Char
  fraction : List Char
  exponentNegative : Bool
  exponent : List Char

/-- The double a decimal literal names. An exponent beyond any double's is held to one that already overflows. -/
def Decimal.toFloat (negative : Bool) (d : Decimal) : Float :=
  let e : Int := min (decimalValue d.exponent) 100000
  let e := if d.exponentNegative then -e else e
  decToFloat negative (decimalValue (d.whole ++ d.fraction)) (e - d.fraction.length)

/--
The longest decimal literal a text starts with, and the text after it: `(\d+\.?\d*|\.\d+)(e[+-]?\d+)?` without
case. `none` when the text starts with none.
-/
def scanDecimal (text : List Char) : Option (Decimal × List Char) :=
  let (whole, rest) := text.span isDigit
  let mantissa : Option (List Char × List Char × List Char) :=
    match rest with
    | '.' :: after =>
      let (fraction, rest') := after.span isDigit
      if whole.isEmpty && fraction.isEmpty then none else some (whole, fraction, rest')
    | _ => if whole.isEmpty then none else some (whole, [], rest)
  mantissa.map fun (whole, fraction, rest) =>
    let plain := ({ whole, fraction, exponentNegative := false, exponent := [] }, rest)
    match rest with
    | e :: after =>
      if e == 'e' || e == 'E' then
        let (negative, digitsAt) := match after with
          | '+' :: more => (false, more)
          | '-' :: more => (true, more)
          | _ => (false, after)
        let (exponent, rest') := digitsAt.span isDigit
        if exponent.isEmpty then plain
        else ({ whole, fraction, exponentNegative := negative, exponent }, rest')
      else plain
    | [] => plain

end InventorySpec

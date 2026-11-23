/-
Reference specification of `packages/ci/src/report/Format.vibe`: the numbers a replay report prints.

A JavaScript string is a sequence of UTF-16 code units, and every length, slice and comparison the
implementation makes is in those units. The specification therefore models a string as `Str`, the list of
its code units, so a lone surrogate or a character outside the BMP means here what it means there.
-/

namespace ReportReplaySpec

/-- A JavaScript string: its UTF-16 code units. -/
abbrev Str := List Nat

open Lean in
/-- `u!"text"` is the code units of a literal as a list of numerals. Only for characters of the BMP. -/
macro:max "u!" s:str : term => do
  let units : Array Term := s.getString.toList.toArray.map fun c => quote c.toNat
  `(([$units,*] : List Nat))

/-- The decimal digits of a natural number, as JavaScript prints an integer below 10²¹. -/
def digits (n : Nat) : Str := (Nat.toDigits 10 n).map Char.toNat

/-- What `\s` matches and `trim` removes: ECMAScript white space and line terminators. -/
def isSpace (c : Nat) : Bool :=
  (9 ≤ c && c ≤ 13) || c == 32 || c == 0xA0 || c == 0x1680 || (0x2000 ≤ c && c ≤ 0x200A) ||
    c == 0x2028 || c == 0x2029 || c == 0x202F || c == 0x205F || c == 0x3000 || c == 0xFEFF

/-- `String.prototype.trim`. -/
def trim (s : Str) : Str := ((s.dropWhile isSpace).reverse.dropWhile isSpace).reverse

/-- `String(value).padStart(2, "0")` of a natural number. -/
def pad (value : Nat) : Str := if value < 10 then 48 :: digits value else digits value

/--
`Format.duration` of a whole, non-negative number of milliseconds: `850ms`, `12.3s`, `7m 20s`, `1h 05m`.

`Math.round` rounds a half up, and a quotient of two integers that ends in `.5` is exact as a double, so each
rounding here is the integer one.
-/
def duration (ms : Nat) : Str :=
  if ms < 950 then digits ms ++ u!"ms"
  else if ms < 59950 then
    let tenths := (ms + 50) / 100
    digits (tenths / 10) ++ u!"." ++ digits (tenths % 10) ++ u!"s"
  else
    let seconds := (ms + 500) / 1000
    if seconds < 3600 then digits (seconds / 60) ++ u!"m " ++ pad (seconds % 60) ++ u!"s"
    else
      let minutes := (seconds + 30) / 60
      digits (minutes / 60) ++ u!"h " ++ pad (minutes % 60) ++ u!"m"

/-- A positive double, as the exact rational `num / den` it stands for. -/
structure Ratio where
  num : Nat
  den : Nat

/--
IEEE 754 division of two positive integers below 2⁵³: the double nearest `a / b`, ties to even. The quotient
is scaled to 53 significant bits and rounded once, which is what the machine does.
-/
def fdiv (a b : Nat) : Ratio :=
  let scaled (k : Int) : Nat × Nat := if k ≥ 0 then (a * 2 ^ k.toNat, b) else (a, b * 2 ^ (-k).toNat)
  -- a·2^k₀ / b lies strictly between 2⁵² and 2⁵⁴.
  let k₀ : Int := 53 + (b.log2 : Int) - (a.log2 : Int)
  let k : Int := if (scaled k₀).1 / (scaled k₀).2 ≥ 2 ^ 53 then k₀ - 1 else k₀
  let n := (scaled k).1
  let d := (scaled k).2
  let q := n / d
  let r := n % d
  let rounded := if 2 * r > d || (2 * r == d && q % 2 == 1) then q + 1 else q
  if k ≥ 0 then ⟨rounded, 2 ^ k.toNat⟩ else ⟨rounded * 2 ^ (-k).toNat, 1⟩

/-- The double `1 / x`. -/
def Ratio.inverse (x : Ratio) : Ratio := fdiv x.den x.num

/-- `x.toFixed(1)`: the nearest tenth of the exact value, a half up. -/
def toFixed1 (x : Ratio) : Str :=
  let n := (2 * x.num * 10 + x.den) / (2 * x.den)
  digits (n / 10) ++ u!"." ++ digits (n % 10)

/-- The least `j ≥ 1` with `x · 10ʲ ≥ 1`, for `0 < x < 1`: minus the decimal exponent of `x`. -/
def decimalShift (x : Ratio) : Nat := go 400 1
where
  go : Nat → Nat → Nat
    | 0, j => j
    | fuel + 1, j => if x.num * 10 ^ j ≥ x.den then j else go fuel (j + 1)

/--
`String(Number(x.toPrecision(2)))` for `0 < x < 1`: two significant digits, a half up, without a trailing
zero, in exponent form below 10⁻⁶ as `Number::toString` writes it.
-/
def toPrecision2 (x : Ratio) : Str :=
  let j₀ := decimalShift x
  let n₀ := (2 * x.num * 10 ^ (j₀ + 1) + x.den) / (2 * x.den)
  -- 99.5 and above rounds to 100: one decimal place up.
  let (n, j) := if n₀ ≥ 100 then (10, j₀ - 1) else (n₀, j₀)
  let significant := if n % 10 == 0 then digits (n / 10) else digits n
  if j = 0 then u!"1"
  else if j ≤ 6 then u!"0." ++ List.replicate (j - 1) 48 ++ significant
  else
    match significant with
    | [d] => [d] ++ u!"e-" ++ digits j
    | d :: rest => [d] ++ u!"." ++ rest ++ u!"e-" ++ digits j
    | [] => []

/--
`Format.times` of a positive double: one decimal below 100, whole above, two significant digits below a
tenth.
-/
def timesOf (x : Ratio) : Str :=
  let tenth := fdiv 95 1000
  if x.num * tenth.den < tenth.num * x.den then toPrecision2 x ++ u!"×"
  else if x.num < 100 * x.den then toFixed1 x ++ u!"×"
  else digits ((2 * x.num + x.den) / (2 * x.den)) ++ u!"×"

/-- `Format.times(baseline / mode)` for whole times, `mode > 0`. -/
def times (baseline mode : Nat) : Str :=
  if baseline = 0 then u!"0.0×" else timesOf (fdiv baseline mode)

/-- `Format.speedup(baseline / mode)`: `6.0× faster`, or `1.3× slower` when the ratio is below one. -/
def speedup (baseline mode : Nat) : Str :=
  if baseline = 0 then u!"0.0× faster"
  else
    let x := fdiv baseline mode
    if x.num < x.den then timesOf x.inverse ++ u!" slower" else timesOf x ++ u!" faster"

/-- `Format.beside`: how a mode's CPU time compares with the baseline's, or nothing when either used none. -/
def beside (baseline mode : Nat) : Str :=
  if mode = 0 ∨ baseline = 0 then []
  else
    let less := fdiv baseline mode
    if less.num ≥ less.den then u!" (" ++ timesOf less ++ u!" less)"
    else u!" (" ++ timesOf less.inverse ++ u!" more)"

/-- `Format.cpuTime` of a report that has the baseline's and normal mode's CPU time. -/
def cpuTime (baseline normal : Nat) (fast : Option Nat) : Str :=
  let normalPart := duration normal ++ u!" in normal mode" ++ beside baseline normal
  u!"the steps used " ++ duration baseline ++ u!" of CPU time as the baseline" ++
    match fast with
    | none => u!" and " ++ normalPart
    | some f => u!", " ++ normalPart ++ u!" and " ++ duration f ++ u!" in fast mode" ++ beside baseline f

/-- The way a commit ran: `RunRecord.Mode`. -/
inductive Mode where
  | normal
  | fast
  deriving DecidableEq, Repr

/-- `ReplayReport.Mismatch`, as far as the speedup reads it. `cause` says why when `apply` explains it. -/
structure Mismatch where
  mode : Mode
  cause : Option Str

/-- `ReplayReport.ReplayCommit`, as far as the speedup reads it. -/
structure Commit where
  mismatches : List Mismatch

/-- `ReplayReport`, as far as the speedup reads it. `declared` is its `speedupCommits` field. -/
structure Report where
  commits : List Commit
  declared : Option Nat

/-- A mismatch of normal mode that nothing explains. -/
def Mismatch.unattributed (m : Mismatch) : Bool := m.mode == .normal && m.cause.isNone

/-- `Format.normalDiffers`: normal mode's result differs from the CI's at a commit of the report. -/
def normalDiffers (report : Report) : Bool :=
  report.commits.any fun commit => commit.mismatches.any Mismatch.unattributed

/--
`Format.speedupCommits`: how many commits the speedup covers. A report where normal mode differs covers none,
whatever it says.
-/
def speedupCommits (report : Report) : Nat :=
  if normalDiffers report then 0 else report.declared.getD report.commits.length

end ReportReplaySpec

/-
Reference specification of `sift` of `packages/ci/scripts/box-replay.mjs`: of the `tar -tvzf` listing of an
artifact a box returned, which members are taken. The box ran an untrusted repository, so the artifact and
its listing are the attacker's.

GNU tar prints a member as `-rw-r--r-- owner/group 123 2026-11-22 10:00 out/replay.json`, and BSD tar as
`-rw-r--r--  0 owner group 123 Nov 22 10:00 out/replay.json`.
-/
import ReportReplaySpec.Format

namespace ReportReplaySpec

/-- The result files a box may return, the only ones taken from it. -/
def kept : List Str :=
  [u!"box.txt", u!"setup.log", u!"install.log", u!"clone.log", u!"replay.json", u!"replay.log", u!"report.html",
    u!"exit", u!"wall-seconds", u!"NOT-REPRODUCED.txt"]

/-- The most bytes one result file may hold: 1 GiB. -/
def largest : Nat := 1073741824

/-- A member that is taken: the path the listing gives, the result it is, and its size. -/
structure SiftEntry where
  path : Str
  name : Str
  bytes : Nat
  deriving DecidableEq, Repr

/-- Why a member is left in the artifact. -/
inductive Why where
  | notPlain
  | notNamed
  | tooLarge
  | twice
  deriving DecidableEq, Repr

/-- A member that is left in the artifact, and why. -/
structure Dropped where
  path : Str
  why : Why
  deriving DecidableEq, Repr

/-- What one line of a listing comes to. -/
inductive Verdict where
  | skip
  | drop (dropped : Dropped)
  | listed (entry : SiftEntry)
  deriving DecidableEq, Repr

/-- The entry of a line that names a result. -/
def Verdict.entry? : Verdict → Option SiftEntry
  | .listed entry => some entry
  | _ => none

/-- The member a line leaves in the artifact. -/
def Verdict.dropped? : Verdict → Option Dropped
  | .drop dropped => some dropped
  | _ => none

/-- `text.split("\n")`. -/
def splitLines : Str → List Str
  | [] => [[]]
  | c :: rest =>
    match splitLines rest with
    | line :: more => if c = 10 then [] :: line :: more else (c :: line) :: more
    | [] => [[]]

/-- `text.trim().split(/\s+/)` of a text that is not blank: its runs of code units that are not white space. -/
def fieldsOf (text : Str) : List Str := go [] text
where
  go (word : Str) : Str → List Str
    | [] => if word.isEmpty then [] else [word.reverse]
    | c :: rest =>
      if isSpace c then (if word.isEmpty then go [] rest else word.reverse :: go [] rest)
      else go (c :: word) rest

/-- A decimal digit. -/
def isDigit (c : Nat) : Bool := 48 ≤ c && c ≤ 57

/-- `/^\d+$/`. -/
def allDigits (text : Str) : Bool := !text.isEmpty && text.all isDigit

/-- The number a text of digits writes. -/
def natOf (text : Str) : Nat := text.foldl (fun value d => value * 10 + (d - 48)) 0

/-- `/^[A-Z][a-z]{2}$/`: a month as BSD tar prints it. -/
def monthLike : Str → Bool
  | [a, b, c] => (65 ≤ a && a ≤ 90) && (97 ≤ b && b ≤ 122) && (97 ≤ c && c ≤ 122)
  | _ => false

/-- `text.replace(/^prefix/, "")` for a literal prefix. -/
def stripPrefix (pre text : Str) : Str := if pre.isPrefixOf text then text.drop pre.length else text

/-- The result a path names: the path without a leading `./` and then a leading `out/`. -/
def nameOf (path : Str) : Str := stripPrefix u!"out/" (stripPrefix u!"./" path)

/-- The path and the size field of a line, read as BSD tar's when its second field is a link count and its sixth a month. -/
def pathAndSize (line : Str) : Str × Str :=
  let fields := fieldsOf line
  let bsd := allDigits (fields.getD 1 []) && monthLike (fields.getD 5 [])
  (List.intercalate [32] (fields.drop (if bsd then 8 else 5)), fields.getD (if bsd then 4 else 2) [])

/--
What a line with this path and size field comes to. The directory `out` itself is passed over. Any other
member is taken only when its line starts with `-`, the mark of a plain file, its name is a result's, and its
size is a number of at most `largest`.
-/
def judge (line path size : Str) : Verdict :=
  if nameOf path = [] ∨ nameOf path = u!"out" ∨ nameOf path = u!"out/" then .skip
  else if line.head? ≠ some 45 then .drop ⟨path, .notPlain⟩
  else if ¬ nameOf path ∈ kept then .drop ⟨path, .notNamed⟩
  else if ¬ (allDigits size = true ∧ natOf size ≤ largest) then .drop ⟨path, .tooLarge⟩
  else .listed ⟨path, nameOf path, natOf size⟩

/-- What one line of a listing comes to. -/
def classify (line : Str) : Verdict := judge line (pathAndSize line).1 (pathAndSize line).2

/-- The lines of a listing that are not blank. -/
def linesOf (listing : Str) : List Str := (splitLines listing).filter fun line => !line.all isSpace

/-- The lines of a listing that name a result as a plain file of a sane size. -/
def listedOf (listing : Str) : List SiftEntry := ((linesOf listing).map classify).filterMap Verdict.entry?

/-- Whether exactly one listed entry has this entry's name. -/
def once (listed : List SiftEntry) (entry : SiftEntry) : Bool :=
  (listed.filter (·.name == entry.name)).length == 1

/-- What `sift` gives: the members taken, and the members left with why. -/
structure Sifted where
  keep : List SiftEntry
  drop : List Dropped

/--
`sift`: of a listing, what is taken. A result listed twice is dropped both times: the box wrote each once, so
an artifact with two was made to put one file in another's place.
-/
def sift (listing : Str) : Sifted :=
  let listed := listedOf listing
  { keep := listed.filter (once listed)
    drop := ((linesOf listing).map classify).filterMap Verdict.dropped? ++
      (listed.filter fun entry => !once listed entry).map fun entry => ⟨entry.path, .twice⟩ }

/-- The four ways an artifact spells the path of a result. -/
def spellings (name : Str) : List Str := [name, u!"./" ++ name, u!"out/" ++ name, u!"./out/" ++ name]

/-- Every path a taken member can have: forty in all. -/
def takenPaths : List Str := kept.flatMap spellings

/-- The text holds `..`. -/
def dotDot : Str → Bool
  | [] => false
  | c :: rest => (c == 46 && rest.head? == some 46) || dotDot rest

end ReportReplaySpec

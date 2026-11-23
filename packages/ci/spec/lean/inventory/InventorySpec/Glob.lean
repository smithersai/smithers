/-
The patterns `hashFiles` takes, for a cache key.

The reference for `packages/ci/src/inventory/Glob.vibe`. A pattern is read into pieces, the pieces are written as
an extended regular expression over a file's path from the repository root, and the same pieces say directly
which paths the pattern names. Everything here is over UTF-16 code units, as the implementation and the regular
expressions it writes are.
-/
import InventorySpec.Unicode

namespace InventorySpec

/-- One member of a character set: a code unit, or every code unit from one to another. -/
inductive ClassItem where
  | single (unit : Nat)
  | range (low high : Nat)

/-- One piece of a pattern. -/
inductive GlobToken where
  /-- One code unit, as written. -/
  | literal (unit : Nat)
  /-- `*`: any run of code units within one name. -/
  | anyName
  /-- `?`: one code unit within a name. -/
  | oneUnit
  /-- `**`: anything, across directories. -/
  | anyPath
  /-- `**/`: nothing, or any directories. -/
  | anyDirs
  /-- `[abc]` and `[!abc]`. -/
  | set (negated : Bool) (items : List ClassItem)

/-- The code unit of `/`. -/
def slash : Nat := 47

/-- What a character set's body reads to. -/
inductive ClassScan where
  /-- A set. -/
  | set (negated : Bool) (items : List ClassItem)
  /-- A set that names `/`, which no pattern may. -/
  | slash
  /-- No set: the bracket is read as itself. -/
  | invalid

/-- Whether a set's body stops being one here: at a POSIX class (`[:alpha:]`), or a `-` hung on a range (`a-c-e`). -/
def breaksClass (afterRange : Bool) (unit : Nat) (rest : List Nat) : Bool :=
  (unit == 91 && (rest.head? == some 58 || rest.head? == some 46 || rest.head? == some 61))
    || (unit == 45 && afterRange && !rest.isEmpty)

/--
The members of a set's body. A range that runs backwards, a second range hung on a first (`a-c-e`), and a POSIX
class (`[:alpha:]`) make no set. A set that is not negated may not name `/`.
-/
def scanClass (negated : Bool) : Bool → List Nat → List ClassItem → ClassScan
  | _, [], items => .set negated items.reverse
  | afterRange, unit :: rest@(dash :: high :: more), items =>
    if breaksClass afterRange unit rest then .invalid
    else if dash == 45 then
      if unit > high then .invalid
      else if !negated && unit ≤ slash && high ≥ slash then .slash
      else scanClass negated true more (.range unit high :: items)
    else if !negated && unit == slash then .slash
    else scanClass negated false rest (.single unit :: items)
  | afterRange, unit :: rest, items =>
    if breaksClass afterRange unit rest then .invalid
    else if !negated && unit == slash then .slash
    else scanClass negated false rest (.single unit :: items)

/--
A negated set with `/` added, since no set may match a directory separator. The `/` goes last, or before a
last `-` that stands for itself, so that the `-` stays where it reads as itself.
-/
def withSlash (items : List ClassItem) : List ClassItem :=
  match items.reverse with
  | .single 45 :: earlier => earlier.reverse ++ [.single slash, .single 45]
  | _ => items ++ [.single slash]

/-- A set as it is used: a negated one with `/` added. -/
def addSlash : ClassScan → ClassScan
  | .set true items => .set true (withSlash items)
  | other => other

/-- The set the members after any `!` or `^` make. A set with no members is none. -/
def classOfRest (negated : Bool) (rest : List Nat) : ClassScan :=
  if rest.isEmpty then .invalid else addSlash (scanClass negated false rest [])

/-- The set a body between `[` and `]` is. A leading `!` or `^` negates it. -/
def classOf (body : List Nat) : ClassScan :=
  let negated := body.head? == some 33 || body.head? == some 94
  classOfRest negated (if negated then body.drop 1 else body)

/-- The body of a set from after its `[`: the code units before the first `]`. -/
def classBody : List Nat → Option (List Nat)
  | [] => none
  | unit :: rest => if unit == 93 then some [] else (classBody rest).map (unit :: ·)

/--
The pieces of a path. `skip` code units are passed over first: those of a set already read. A run of three or
more stars reads as two. `none` when a set names `/`.
-/
def scanGlob : Nat → List Nat → Option (List GlobToken)
  | _, [] => some []
  | skip + 1, _ :: rest => scanGlob skip rest
  | 0, 42 :: tail@(42 :: 42 :: _) => scanGlob 0 tail
  | 0, 42 :: 42 :: 47 :: rest => (scanGlob 0 rest).map (.anyDirs :: ·)
  | 0, 42 :: 42 :: rest => (scanGlob 0 rest).map (.anyPath :: ·)
  | 0, 42 :: rest => (scanGlob 0 rest).map (.anyName :: ·)
  | 0, 63 :: rest => (scanGlob 0 rest).map (.oneUnit :: ·)
  | 0, 91 :: rest =>
    match (classBody rest).map fun body => (body, classOf body) with
    | some (_, .slash) => none
    | some (body, .set negated items) => (scanGlob (body.length + 1) rest).map (.set negated items :: ·)
    | _ => (scanGlob 0 rest).map (.literal 91 :: ·)
  | 0, unit :: rest => (scanGlob 0 rest).map (.literal unit :: ·)

/-- A path without the `./` it starts with, however many. -/
def stripLeading : List Nat → List Nat
  | 46 :: 47 :: rest => stripLeading rest
  | path => path

/-- A path without the `/` it ends with, however many. -/
def stripTrailing : List Nat → List Nat
  | [] => []
  | unit :: rest =>
    match stripTrailing rest with
    | [] => if unit == slash then [] else [unit]
    | kept => unit :: kept

/-- The path a pattern names, from the repository root. -/
def normalize (pattern : List Nat) : List Nat := stripTrailing (stripLeading pattern)

/-- Whether a path names nothing inside the repository: nothing at all, an absolute path, `~`, or a path through `..`. -/
def leaves (path : List Nat) : Bool :=
  path.isEmpty || path.head? == some slash || path.head? == some 126 || (splitOn slash path).contains [46, 46]

/-- The pieces of a pattern, or `none` for a pattern that names nothing inside the repository. -/
def globOf (pattern : List Nat) : Option (List GlobToken) :=
  if leaves (normalize pattern) then none else scanGlob 0 (normalize pattern)

/-- Whether a code unit means something in a regular expression outside a set. -/
def isSpecial (unit : Nat) : Bool :=
  [46, 43, 94, 36, 40, 41, 123, 125, 124, 92, 91, 93].contains unit

/-- A code unit inside a set, where only a backslash is escaped. -/
def renderClassUnit (unit : Nat) : List Nat := if unit == 92 then [92, 92] else [unit]

/-- One member of a set as a regular expression writes it. -/
def renderItem : ClassItem → List Nat
  | .single unit => renderClassUnit unit
  | .range low high => renderClassUnit low ++ 45 :: renderClassUnit high

/-- One piece as a regular expression. -/
def renderToken : GlobToken → List Nat
  | .literal unit => if isSpecial unit then [92, unit] else [unit]
  | .anyName => utf16 "[^/]*".toList
  | .oneUnit => utf16 "[^/]".toList
  | .anyPath => utf16 ".*".toList
  | .anyDirs => utf16 "(.*/)?".toList
  | .set negated items => 91 :: (if negated then [94] else []) ++ items.flatMap renderItem ++ [93]

/-- The regular expression of a pattern's pieces. A directory names every file under it. -/
def renderGlob (tokens : List GlobToken) : List Nat :=
  94 :: tokens.flatMap renderToken ++ utf16 "(/.*)?$".toList

/-- The regular expression of one pattern over code units. -/
def regexUnits (pattern : List Nat) : Option (List Nat) := (globOf pattern).map renderGlob

/--
The regular expression of one pattern, or `none` for a pattern that names nothing inside the repository: an
absolute path, `~`, or a path through `..`. Sets that could match a directory separator are also refused.
-/
def regexOf (pattern : String) : Option String :=
  (regexUnits (utf16 pattern.toList)).map fun units => String.ofList (ofUtf16 units)

/-- Whether a set's member covers a code unit. -/
def ClassItem.covers (unit : Nat) : ClassItem → Bool
  | .single member => member == unit
  | .range low high => low ≤ unit && unit ≤ high

/-- Whether a set matches a code unit. -/
def setMatches (negated : Bool) (items : List ClassItem) (unit : Nat) : Bool :=
  negated != items.any (ClassItem.covers unit)

/-- What `.` matches in the regular expression: any code unit but a line end. -/
def isDot (unit : Nat) : Bool := !(unit == 10 || unit == 13 || unit == 0x2028 || unit == 0x2029)

/-- A path and what is left of it after each run of leading code units that all pass a test. -/
def suffixesWhile (test : Nat → Bool) : List Nat → List (List Nat)
  | [] => [[]]
  | unit :: rest => (unit :: rest) :: (if test unit then suffixesWhile test rest else [])

/-- Whether pieces name a path, a directory naming every file under it. -/
def matchTokens : List GlobToken → List Nat → Bool
  | [], path => path.isEmpty || (path.head? == some slash && (path.drop 1).all isDot)
  | .literal unit :: more, path =>
    match path with
    | first :: rest => first == unit && matchTokens more rest
    | [] => false
  | .oneUnit :: more, path =>
    match path with
    | first :: rest => first != slash && matchTokens more rest
    | [] => false
  | .set negated items :: more, path =>
    match path with
    | first :: rest => setMatches negated items first && matchTokens more rest
    | [] => false
  | .anyName :: more, path => (suffixesWhile (· != slash) path).any (matchTokens more)
  | .anyPath :: more, path => (suffixesWhile isDot path).any (matchTokens more)
  | .anyDirs :: more, path =>
    matchTokens more path || (suffixesWhile isDot path).any fun left =>
      match left with
      | first :: rest => first == slash && matchTokens more rest
      | [] => false

/-- Whether a pattern names a path, or `none` for a pattern that names nothing inside the repository. -/
def globMatches (pattern path : String) : Option Bool :=
  (globOf (utf16 pattern.toList)).map fun tokens => matchTokens tokens (utf16 path.toList)

/-- The files to hash: those a path of which matches one of `take` and none of `leave`. -/
structure Files (α : Type) where
  take : List α
  leave : List α

/-- The lines of a list of patterns, each of which may hold several, without the space around them. -/
def patternLines (patterns : List String) : List (List Char) :=
  (patterns.flatMap fun pattern => splitOn '\n' pattern.toList).map trim

/-- The patterns of lines, as pieces. Empty lines and comments are passed over; a leading `!` leaves files out. -/
def readLines : List (List Char) → Files (List GlobToken) → Option (Files (List GlobToken))
  | [], files => some { take := files.take.reverse, leave := files.leave.reverse }
  | line :: rest, files =>
    if line.isEmpty || line.head? == some '#' then readLines rest files
    else
      let left := line.head? == some '!'
      match globOf (utf16 (if left then line.drop 1 else line)) with
      | none => none
      | some tokens =>
        readLines rest (if left then { files with leave := tokens :: files.leave }
          else { files with take := tokens :: files.take })

/-- The files a list of patterns names, as pieces. -/
def filesTokens (patterns : List String) : Option (Files (List GlobToken)) :=
  match readLines (patternLines patterns) { take := [], leave := [] } with
  | some files => if files.take.isEmpty then none else some files
  | none => none

/--
The files a list of patterns names, or `none` when one of them names nothing inside the repository, or none of
them takes a file.
-/
def filesOf (patterns : List String) : Option (Files String) :=
  (filesTokens patterns).map fun files =>
    let regex (tokens : List GlobToken) : String := String.ofList (ofUtf16 (renderGlob tokens))
    { take := files.take.map regex, leave := files.leave.map regex }

/-- Whether a list of patterns names a path: one of `take` does and none of `leave`. -/
def filesMatch (patterns : List String) (path : String) : Option Bool :=
  (filesTokens patterns).map fun files =>
    let units := utf16 path.toList
    files.take.any (matchTokens · units) && !files.leave.any (matchTokens · units)

end InventorySpec

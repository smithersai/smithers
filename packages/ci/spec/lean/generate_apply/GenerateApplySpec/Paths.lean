import GenerateApplySpec.Units

/-!
# Generated paths: `src/apply/Check.vibe`

`apply` writes each generated file at a repository-relative name. Before any is written, `placeOf` checks the whole
name, then looks at the name and every directory above it, outermost first, and refuses a name whose real location
is outside the repository. It refuses a name that is a link, or is under one, wherever the link leads: a link that
stays inside the repository is followed by a write too, as `.smithers` linked to `.git/hooks` is.

The file system is the one part that is not a function of the name. It is a parameter here (`Disk`): what
`realPath`, `readLink` and `stat` answer for each prefix of the name.
-/

namespace GenerateApplySpec.Paths

open GenerateApplySpec

/-- A segment no portable name holds: the empty one, `.` and `..`. -/
def badSegment (s : Str) : Bool := s == [] || s == [46] || s == [46, 46]

/-- `^[A-Za-z]:`, the drive of a Windows path. -/
def drivePrefix : Str → Bool
  | c :: 58 :: _ => isAlpha c
  | _ => false

/--
True for a portable repository-relative file name: the names
`/[\\\0]|^[A-Za-z]:|(?:^|\/)\.{0,2}(?:\/|$)/` does not match.
-/
def portable (p : Str) : Bool :=
  !(p.contains 92 || p.contains 0 || drivePrefix p || (splitOn 47 p).any badSegment)

/-- The nonempty initial parts of a list, shortest first. -/
def inits {α : Type} : List α → List (List α)
  | [] => []
  | a :: as => [a] :: (inits as).map (a :: ·)

/-- `prefixesOf`: a path and each directory above it, outermost first. -/
def prefixesOf (p : Str) : List Str := (inits (splitOn 47 p)).map (joinWith [47])

/-- The repository's real location with the separator after it. The volume root already ends with one. -/
def belowRoot (realRoot : Str) : Str := if endsWith realRoot [47] then realRoot else realRoot ++ [47]

/-- True when the real location `real` is the repository at `realRoot` or inside it. -/
def withinRoot (realRoot real : Str) : Bool := real == realRoot || startsWith real (belowRoot realRoot)

/-- What a file system call answers: a value, or the reason it failed (`NotFound`, `PermissionDenied`, ...). -/
inductive Answer where
  | ok (value : Str)
  | failed (reason : Str)

/-- What `stat` says is at a path. `other` is anything else, and a `stat` that failed. -/
inductive Kind where
  | file
  | directory
  | other
  deriving DecidableEq

/-- What the file system answers for one prefix of a path. -/
structure Node where
  real : Answer
  link : Answer
  kind : Kind

/-- The file system `placeOf` reads, by repository-relative prefix. -/
abbrev Disk := Str → Node

/-- What is at a path `apply` would write: nothing, a file, or something that stops the write. -/
inductive Place where
  | absent
  | present
  | refused (why : Str)

/-- The reason of a call that found nothing. -/
def notFound : Str := lit "NotFound"

/-- What one prefix decides: `none` when the walk goes on to the next prefix. -/
def inspect (realRoot path pre : Str) (node : Node) : Option Place :=
  match node.real with
  | .failed reason =>
    if reason ≠ notFound then some (.refused (pre ++ lit " could not be resolved (" ++ reason ++ lit ")"))
    else
      match node.link with
      | .ok target => some (.refused (pre ++ lit " is a link to " ++ target ++ lit ", which does not exist"))
      | .failed why =>
        if why = notFound then some .absent
        else some (.refused (pre ++ lit " could not be inspected (" ++ why ++ lit ")"))
  | .ok real =>
    if withinRoot realRoot real = false then
      some (.refused (pre ++ lit " is a link to " ++ real ++ lit ", outside the repository"))
    else
      match node.link with
      | .ok target =>
        some (.refused (pre ++ lit " is a link to " ++ target ++ lit ", and no generated file is written through a link"))
      | .failed _ =>
        if pre ≠ path ∧ node.kind ≠ .directory then
          some (.refused (pre ++ lit " is not a directory, so " ++ path ++ lit " cannot be written"))
        else if pre = path ∧ node.kind ≠ .file then some (.refused (path ++ lit " is not a file"))
        else none

/-- The walk over the prefixes of `path`, outermost first. -/
def walk (disk : Disk) (realRoot path : Str) : List Str → Place
  | [] => .present
  | pre :: rest =>
    match inspect realRoot path pre (disk pre) with
    | some place => place
    | none => walk disk realRoot path rest

/-- `placeOf`: the whole name is checked before the first prefix is looked at. -/
def placeOf (disk : Disk) (realRoot path : Str) : Place :=
  if portable path then walk disk realRoot path (prefixesOf path)
  else .refused (jsonQuote path ++ lit " is outside the repository (not a repository-relative file path)")

end GenerateApplySpec.Paths

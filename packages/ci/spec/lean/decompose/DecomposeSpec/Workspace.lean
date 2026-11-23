/-
Reference specification of the pure core of `packages/ci/src/decompose/Workspace.vibe`: the wildcard matcher of
workspace patterns, the path join, and what a package's task reaches inside other packages.
-/
import DecomposeSpec.Shell

namespace DecomposeSpec
namespace Workspace

open Text

/-! ## Wildcards -/

/-- True when a pattern matches all of a subject. A token `isStar` holds of matches any run of the subject's
items, an empty run too; any other token matches one item, when `matches` says so.

This is the meaning of a pattern, written as its definition: a star either matches nothing or takes one more item.
The implementation computes the same answer in one pass with one place to go back to, the last star. -/
def wild (isStar : α → Bool) (matchesItem : α → β → Bool) : List α → List β → Bool
  | [], [] => true
  | [], _ :: _ => false
  | token :: pattern, [] => isStar token && wild isStar matchesItem pattern []
  | token :: pattern, item :: subject =>
    if isStar token then
      wild isStar matchesItem pattern (item :: subject) || wild isStar matchesItem (token :: pattern) subject
    else matchesItem token item && wild isStar matchesItem pattern subject
termination_by pattern subject => pattern.length + subject.length

/-- `*` in one name of a path matches any run of characters. -/
def wildName (segment name : Str) : Bool := wild (· = '*') (fun left right => left = right) segment name

/-- The segments of one workspace pattern, or `none` when it uses glob syntax this reader does not implement:
a brace, a bracket, `?`, a backslash, or a `..` segment. Empty and `.` segments say nothing. -/
def patternSegments (pattern : Str) : Option (List Str) :=
  if pattern.any (fun c => c = '{' || c = '}' || c = '[' || c = ']' || c = '?' || c = '\\') then none
  else
    let segments := (splitOn '/' pattern).filter fun segment => segment ≠ [] && segment ≠ ['.']
    if segments.contains ['.', '.'] then none else some segments

/-- True when a pattern's segments match a directory: `*` matches any run of characters in one name, and a `**`
segment any run of directories. -/
def matchesDirectory (segments : List Str) (directory : Str) : Bool :=
  wild (· = ['*', '*']) wildName segments (splitOn '/' directory)

def packageFile : Str := "/package.json".toList
def modulesDirectory : Str := "node_modules/".toList

/-- The directories that are workspace packages: those holding a `package.json` that a pattern includes and none
excludes (`!pattern`), sorted. `none` when a pattern cannot be read. -/
def packageDirectories (patterns files : List Str) : Option (List Str) :=
  let read : Str → Option (Bool × List Str) := fun pattern =>
    match pattern with
    | '!' :: rest => (patternSegments rest).map (true, ·)
    | _ => (patternSegments pattern).map (false, ·)
  match patterns.mapM read with
  | none => none
  | some tests =>
    let includes := (tests.filter (!·.1)).map (·.2)
    let excludes := (tests.filter (·.1)).map (·.2)
    let directories := files.filterMap fun file =>
      if packageFile.isSuffixOf file && !contains modulesDirectory file then
        some (file.take (file.length - packageFile.length))
      else none
    some (jsSort (distinct (directories.filter fun directory =>
      includes.any (matchesDirectory · directory) && !excludes.any (matchesDirectory · directory))))

/-! ## Paths -/

/-- Walks the segments of a relative path from a directory held deepest name first. -/
def joinSegments : List Str → List Str → Option (List Str)
  | [], parts => some parts
  | segment :: rest, parts =>
    if segment = [] || segment = ['.'] then joinSegments rest parts
    else if segment ≠ ['.', '.'] then joinSegments rest (segment :: parts)
    else match parts with
      | [] => none
      | _ :: above => joinSegments rest above

/-- Joins a relative path to a directory, both from the repository root. `none` when the result leaves the
repository. -/
def join (directory relative : Str) : Option Str :=
  let parts := if directory = [] then [] else splitOn '/' directory
  (joinSegments (splitOn '/' relative) parts.reverse).map fun joined => joinWith ['/'] joined.reverse

def extensions : List Str :=
  ["", ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"].map String.toList

def swaps : List (Str × List Str) :=
  [(".js", [".ts", ".tsx"]), (".jsx", [".tsx"]), (".mjs", [".mts"]), (".cjs", [".cts"])].map
    fun (source, targets) => (source.toList, targets.map String.toList)

/-- The file a path written in source names: itself, or with an extension or `index` a JavaScript resolver would
try. -/
def resolveFile (path : Str) (files : List Str) : Option Str :=
  let candidates :=
    extensions.map (path ++ ·) ++
    swaps.flatMap (fun (source, targets) =>
      if source.isSuffixOf path then targets.map (path.take (path.length - source.length) ++ ·) else []) ++
    (extensions.drop 1).map (path ++ "/index".toList ++ ·)
  candidates.find? (files.contains ·)

/-- A path cut before each of its slashes but one at its start, longest first. -/
def slashPrefixes (path : Str) : List Str :=
  ((List.range path.length).filter fun index => index > 0 && path[index]? = some '/').reverse.map (path.take ·)

/-! ## Closure -/

/-- How many items of a finite domain are not yet seen: what a search has left to do. -/
def unseenCount [DecidableEq α] : List α → List α → Nat
  | [], _ => 0
  | head :: tail, seen => (if head ∈ seen then 0 else 1) + unseenCount tail seen

theorem unseenCount_le [DecidableEq α] (domain seen : List α) (item : α) :
    unseenCount domain (item :: seen) ≤ unseenCount domain seen := by
  induction domain with
  | nil => simp [unseenCount]
  | cons head tail ih =>
    simp only [unseenCount]
    by_cases known : head ∈ seen
    · rw [if_pos known, if_pos (List.mem_cons_of_mem _ known)]
      omega
    · rw [if_neg known]
      split <;> omega

/-- Seeing one more item of the domain leaves strictly less to do: why every search here ends. -/
theorem unseenCount_lt [DecidableEq α] (domain seen : List α) (item : α)
    (inDomain : item ∈ domain) (unseen : item ∉ seen) :
    unseenCount domain (item :: seen) < unseenCount domain seen := by
  induction domain with
  | nil => cases inDomain
  | cons head tail ih =>
    have le := unseenCount_le tail seen item
    simp only [unseenCount]
    by_cases same : head = item
    · subst same
      rw [if_neg unseen, if_pos List.mem_cons_self]
      omega
    · have inTail : item ∈ tail := by
        cases inDomain with
        | head => exact absurd rfl same
        | tail _ h => exact h
      have step := ih inTail
      by_cases known : head ∈ seen
      · rw [if_pos known, if_pos (List.mem_cons_of_mem _ known)]
        omega
      · have fresh : head ∉ item :: seen := by
          intro h
          cases h with
          | head => exact same rfl
          | tail _ h => exact known h
        rw [if_neg known, if_neg fresh]
        omega

/-- A search of a finite graph with a stack, as the implementation writes it: the items reached from the stack,
in the order they are first taken from it. `edges` lists what one item leads to, pushed in order so that the last
is taken first. An item outside the domain is never followed. -/
def search [DecidableEq α] (domain : List α) (edges : α → List α) (stack seen : List α) : List α :=
  match stack with
  | [] => seen.reverse
  | item :: rest =>
    if item ∈ seen then search domain edges rest seen
    else if _ : item ∈ domain then search domain edges ((edges item).reverse ++ rest) (item :: seen)
    else search domain edges rest seen
termination_by (unseenCount domain seen, stack.length)
decreasing_by
  · exact Prod.Lex.right _ (by simp)
  · exact Prod.Lex.left _ _ (unseenCount_lt domain seen item (by assumption) (by assumption))
  · exact Prod.Lex.right _ (by simp)

/-! ## Reach -/

/-- One workspace package, by what the reach is computed from. -/
structure Package where
  name : Str
  directory : Str
  dependencies : List Str
  /-- The names of its scripts. -/
  scripts : List Str
  deriving DecidableEq, Repr

/-- What one file's text mentions: workspace packages by name, relative paths, and paths from the root. -/
structure Mentions where
  names : List Str := []
  relative : List Str := []
  rooted : List Str := []
  deriving DecidableEq, Repr

/-- A workspace: its packages, the repository's files, and what each file mentions. -/
structure Facts where
  packages : List Package
  files : List Str
  mentions : List (Str × Mentions)

/-- What a search of the workspace goes through: a package reached whole, or one file of a package. -/
inductive Node where
  | package (name : Str)
  | file (path : Str)
  deriving DecidableEq, Repr

/-- What a package's task reads inside packages: whole package directories, and single files of other packages. -/
structure Reach where
  packages : List Str
  files : List Str
  deriving DecidableEq, Repr

namespace Facts

/-- The package with a name. A later package of the same name stands for it, as in a `Map`. -/
def named (facts : Facts) (name : Str) : Option Package := facts.packages.reverse.find? (·.name = name)

def inDirectory (facts : Facts) (directory : Str) : Option Package :=
  facts.packages.reverse.find? (·.directory = directory)

/-- The deepest package whose directory holds a path. -/
def ownerOf (facts : Facts) (path : Str) : Option Package :=
  if path = [] then none else (path :: slashPrefixes path).findSome? facts.inDirectory

def mentioned (facts : Facts) (file : Str) : Mentions := (facts.mentions.lookup file).getD {}

/-- True when a path names a directory that holds a file, or a file a resolver finds. -/
def pathExists (facts : Facts) (path : Str) : Bool :=
  facts.files.any (fun file => (slashPrefixes file).contains path) || (resolveFile path facts.files).isSome

/-- The directory of a file inside a package, which always has one. -/
def directoryOf (file : Str) : Str :=
  match ((List.range file.length).filter fun index => file[index]? = some '/').getLast? with
  | some index => file.take index
  | none => file.dropLast

/-- What one file adds. `whole` is true when the file's own package is already reached whole, so paths that stay
inside it add nothing. A relative path is read from the file's own directory; when it names nothing there, it is
also read from the package's directory, where a program runs. A rooted path is read from the repository root. A
path that names a file adds that file; one that names anything else in a package adds that package whole. -/
def edgesOfFile (facts : Facts) (file : Str) (owner : Package) (whole : Bool) : List Node :=
  let found := facts.mentioned file
  let byName := (found.names.filterMap facts.named).map fun package => Node.package package.name
  let targets : List (Option Str) :=
    found.rooted.map (join []) ++
    found.relative.flatMap fun path =>
      let beside := join (directoryOf file) path
      let elsewhere := match beside with
        | none => true
        | some target => !facts.pathExists target
      beside :: (if elsewhere then [join owner.directory path] else [])
  byName ++ targets.filterMap fun target =>
    match target with
    | none => none
    | some target =>
      match facts.ownerOf target with
      | none => none
      | some targetOwner =>
        if whole && targetOwner = owner then none
        else
          match resolveFile target facts.files with
          | some resolved =>
            if facts.ownerOf resolved = some targetOwner then some (Node.file resolved)
            else some (Node.package targetOwner.name)
          | none => some (Node.package targetOwner.name)

/-- What a package reaches in one step: the packages it declares, and what each of its files adds. -/
def edgesOfPackage (facts : Facts) (start : Package) : List Node :=
  (start.dependencies.filterMap facts.named).map (fun package => Node.package package.name) ++
    (facts.files.filter fun file => facts.ownerOf file = some start).flatMap fun file =>
      facts.edgesOfFile file start true

def edges (facts : Facts) : Node → List Node
  | .package name =>
    match facts.named name with
    | some package => facts.edgesOfPackage package
    | none => []
  | .file path =>
    match facts.ownerOf path with
    | some owner => facts.edgesOfFile path owner false
    | none => []

/-- Every node a search can go through. -/
def domain (facts : Facts) (start : Node) : List Node :=
  start :: (facts.packages.map (Node.package ·.name) ++ facts.files.map Node.file)

/-- Every node a package, or one file of a package, reaches, itself included. -/
def reached (facts : Facts) (start : Node) : List Node :=
  search (facts.domain start) facts.edges [start] []

/-- Everything a package, or one file of a package, reaches: the directories of the packages reached whole, and
each single file whose package is not. -/
def reachOf (facts : Facts) (start : Node) : Reach :=
  let nodes := facts.reached start
  let packages := nodes.filterMap fun node =>
    match node with
    | .package name => facts.named name
    | .file _ => none
  let files := nodes.filterMap fun node =>
    match node with
    | .file path =>
      match facts.ownerOf path with
      | some owner => if packages.contains owner then none else some path
      | none => some path
    | .package _ => none
  { packages := jsSort (distinct (packages.map (·.directory))), files := jsSort (distinct files) }

end Facts

end Workspace
end DecomposeSpec

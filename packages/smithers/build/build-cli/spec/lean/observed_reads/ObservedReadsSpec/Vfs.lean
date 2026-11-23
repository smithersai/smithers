import ObservedReadsSpec.Text

/-!
# A file system, and what `measure`, `listing` and `dirLinks` say of it

`ObservedReads.ts` looks at the host through five calls (`Io`): `lstat`, `readlink`, `readdir`, `readFile` and
`head`. This module gives those calls a meaning over a tree of files, directories and symbolic links, as a
POSIX kernel resolves a path: name by name from the root, through at most `maximumLinks` symbolic links.

The walk is a total function. Lean accepts it only with a proof that it ends, and that proof holds for every
tree: a link that leads back to itself is followed 40 times and answers `ELOOP`.
-/
namespace ObservedReadsSpec

/-- What is at a name: a regular file, a directory or a symbolic link. -/
inductive Node where
  | regular (content : String) (exec : Bool)
  | dir (entries : List (String × Node))
  | symlink (target : String)
  deriving Inhabited

/-- Symbolic links one path may pass through before resolving it fails (`MAXSYMLINKS`). -/
def maximumLinks : Nat := 40

/-- Why a path does not resolve. -/
inductive Errno where
  | ENOENT
  | ENOTDIR
  | ELOOP
  | EINVAL
  | EISDIR
  deriving DecidableEq, Repr

def Errno.code : Errno → String
  | .ENOENT => "ENOENT"
  | .ENOTDIR => "ENOTDIR"
  | .ELOOP => "ELOOP"
  | .EINVAL => "EINVAL"
  | .EISDIR => "EISDIR"

/-- The entry of a directory under a name; nothing has an entry in a file or a link. -/
def Node.child? : Node → String → Option Node
  | .dir entries, name => entries.lookup name
  | _, _ => none

def Node.isDir : Node → Bool
  | .dir _ => true
  | _ => false

/-- The node a list of names leads to from a root, following no link. -/
def nodeAt (root : Node) : List String → Option Node
  | [] => some root
  | name :: rest => (root.child? name).bind (nodeAt · rest)

/-- The names of a path: what lies between its slashes, without the empty names and `.`. -/
def parts (path : String) : List String :=
  (path.splitOn "/").filter (fun part => part != "" && part != ".")

/-- Where a walk ended: the names from the root of where it stands, what is there, and the links it followed. -/
structure Found where
  place : List String
  node : Node
  hops : Nat

/--
Walks `queue` from the directory at `place`. A symbolic link is followed when a name comes after it, or when
`follow` is set: its target's names go to the front of the queue, from the root when the target is absolute.
The walk fails with `ELOOP` at the link after the fortieth.

Termination: each step either follows a link, and the links left to follow go down by one, or takes a name off
the queue with the links unchanged. No tree makes it run on: a cycle of links runs out of links.
-/
def walk (root : Node) (follow : Bool) (hops : Nat) (place : List String) (queue : List String) :
    Except Errno Found :=
  match nodeAt root place with
  | none => .error .ENOENT
  | some here =>
    match queue with
    | [] => .ok ⟨place, here, hops⟩
    | part :: rest =>
      match here with
      | .dir entries =>
        if part = ".." then walk root follow hops place.dropLast rest
        else
          match entries.lookup part with
          | none => .error .ENOENT
          | some (.symlink target) =>
            if rest.isEmpty && !follow then .ok ⟨place ++ [part], .symlink target, hops⟩
            else if maximumLinks ≤ hops then .error .ELOOP
            else if target = "" then .error .ENOENT
            else
              walk root follow (hops + 1) (if target.startsWith "/" then [] else place) (parts target ++ rest)
          | some _ => walk root follow hops (place ++ [part]) rest
      | _ => .error .ENOTDIR
termination_by (maximumLinks - hops, queue.length)
decreasing_by
  all_goals simp_wf
  · exact Prod.Lex.right _ (by simp)
  · exact Prod.Lex.left _ _ (by omega)
  · exact Prod.Lex.right _ (by simp)

/-- Whether a path asks for a directory at its end: it closes with a slash or with `.`. -/
def endsAsDirectory (path : String) : Bool :=
  match (path.splitOn "/").getLast? with
  | some last => (last == "" || last == ".") && (path.splitOn "/").length > 1
  | none => false

/-- Resolves a path from the root. `follow` says whether a link at its end is followed. -/
def resolve (fs : Node) (follow : Bool) (path : String) : Except Errno Found :=
  if path = "" then .error .ENOENT
  else
    let directory := endsAsDirectory path
    match walk fs (follow || directory) 0 [] (parts path) with
    | .error code => .error code
    | .ok found => if directory && !found.node.isDir then .error .ENOTDIR else .ok found

/-- `lstat`: what a path names, a link at its end not followed. -/
def lstat (fs : Node) (path : String) : Except Errno Node := (resolve fs false path).map (·.node)

/-- `stat`: what a path leads to. -/
def stat (fs : Node) (path : String) : Except Errno Node := (resolve fs true path).map (·.node)

/-- Whether anything is at a path (`present`). -/
def present (fs : Node) (path : String) : Bool := (lstat fs path).isOk

/-- The names in a directory, each once. -/
def Node.names : Node → List String
  | .dir entries => (entries.map (·.1)).eraseDups
  | _ => []

/-- `readdir`: the names in the directory a path leads to. -/
def readdir (fs : Node) (path : String) : Except Errno (List String) :=
  match stat fs path with
  | .error code => .error code
  | .ok node => if node.isDir then .ok node.names else .error .ENOTDIR

/-- The size of a file in bytes, and 0 for anything else: what `cheapestFirst` orders reads by. -/
def sizeOf (fs : Node) (path : String) : Nat :=
  match lstat fs path with
  | .ok (.regular content _) => content.toUTF8.size
  | _ => 0

/-! ## `measure` -/

/-- What is at a path, before it is written as one text. -/
inductive State where
  | absent
  | dir
  | link (target : String)
  | file (digest : String) (exec : Bool)
  | failed (code : String)
  deriving DecidableEq

/-- The five things `measure` tells apart, and a failure. -/
inductive Kind where
  | absent
  | dir
  | link
  | file
  | exec
  | failed
  deriving DecidableEq, Repr

def State.kind : State → Kind
  | .absent => .absent
  | .dir => .dir
  | .link _ => .link
  | .file _ false => .file
  | .file _ true => .exec
  | .failed _ => .failed

/--
A state as one comparable text: `-` when nothing is there, `d` for a directory, `l:<target>` for a symbolic
link, `f:<digest>` for a file with `:x` when it can be executed, and `!<code>` when it cannot be read.
-/
def State.render : State → String
  | .absent => String.ofList ['-']
  | .dir => String.ofList ['d']
  | .link target => String.ofList ('l' :: ':' :: target.toList)
  | .file digest exec => String.ofList ('f' :: ':' :: digest.toList ++ if exec then [':', 'x'] else [])
  | .failed code => String.ofList ('!' :: code.toList)

/-- `measure`, before it is written as text. -/
def measureState (fs : Node) (path : String) : State :=
  match lstat fs path with
  | .error .ENOENT => .absent
  | .error .ENOTDIR => .absent
  | .error code => .failed code.code
  | .ok (.symlink target) => .link target
  | .ok (.dir _) => .dir
  | .ok (.regular content exec) => .file (sha256Hex content) exec

/-- `measure(path, io)`: what is at a path, as one comparable text. -/
def measure (fs : Node) (path : String) : String := (measureState fs path).render

/-- The state of a path nothing is at. -/
def absent : String := State.absent.render

/-! ## `listing` and `dirLinks` -/

/-- `listing(path, own, io)`: a digest of the names in a directory apart from `own`; none when it cannot be listed. -/
def listing (fs : Node) (path : String) (own : List String) : Option String :=
  match readdir fs path with
  | .error _ => none
  | .ok names => some (sha256Hex (jsonStrings (sortByCodeUnit (names.filter (fun name => !own.contains name)))))

/-- The link count of a directory: itself, its `.`, and the `..` of each directory in it. -/
def linkCount (node : Node) : Nat :=
  2 + (node.names.filter (fun name => ((node.child? name).map Node.isDir).getD false)).length

/-- Joins a directory and a name as `dirLinks` and `changed` do. -/
def joinPath (directory name : String) : String :=
  if directory = "/" then "/" ++ name else directory ++ "/" ++ name

/--
`dirLinks(path, own, io)`: the link count of a directory less the directories among `own` in it; none when the
path is not a directory. A directory gains a link with each directory made in it, and with nothing else.
-/
def dirLinks (fs : Node) (path : String) (own : List String) : Option Int :=
  match lstat fs path with
  | .ok (.dir entries) =>
    let extra := (own.eraseDups.filter (fun name =>
      match lstat fs (joinPath path name) with
      | .ok node => node.isDir
      | .error _ => false)).length
    some ((linkCount (.dir entries) : Int) - extra)
  | _ => none

/-! ## Theorems -/

/-- A walk never follows more than `maximumLinks` links, whatever the tree: cycles included. -/
theorem walk_hops_le (root : Node) (follow : Bool) (hops : Nat) (place queue : List String) (found : Found) :
    hops ≤ maximumLinks → walk root follow hops place queue = .ok found → found.hops ≤ maximumLinks := by
  fun_induction walk root follow hops place queue <;> intro bound ended <;>
    first
    | (cases ended; exact bound)
    | cases ended
    | (apply_assumption <;> first | assumption | omega)

/-- Resolving a path follows at most `maximumLinks` links. -/
theorem resolve_hops_le (fs : Node) (follow : Bool) (path : String) (found : Found)
    (ended : resolve fs follow path = .ok found) : found.hops ≤ maximumLinks := by
  by_cases empty : path = ""
  · simp [resolve, empty] at ended
  · cases walked : walk fs (follow || endsAsDirectory path) 0 [] (parts path) with
    | error code => simp [resolve, empty, walked] at ended
    | ok result =>
      simp only [resolve, empty, ↓reduceIte, walked] at ended
      split at ended
      · cases ended
      · cases ended
        exact walk_hops_le fs _ 0 [] _ _ (Nat.zero_le _) walked

/--
Resolution ends for every tree and every path, with an answer or an error: `resolve` is a total function,
which Lean accepts only with the proof of termination given with `walk`.
-/
theorem resolve_terminates (fs : Node) (follow : Bool) (path : String) :
    (∃ found, resolve fs follow path = .ok found) ∨ (∃ code, resolve fs follow path = .error code) := by
  cases resolve fs follow path with
  | ok found => exact .inl ⟨found, rfl⟩
  | error code => exact .inr ⟨code, rfl⟩

/--
A link that leads to itself: wherever the count of links stands, following it ends in `ELOOP`. The same holds
for a link at the end of any cycle; this is the shortest one.
-/
theorem walk_selfLoop (name target : String) (names : parts target = [name]) (relative : target.startsWith "/" = false)
    (named : name ≠ "..") (nonempty : target ≠ "") (hops : Nat) (bound : hops ≤ maximumLinks) :
    walk (.dir [(name, .symlink target)]) true hops [] [name] = .error .ELOOP := by
  generalize gap : maximumLinks - hops = left
  induction left generalizing hops with
  | zero =>
    have : maximumLinks ≤ hops := by omega
    rw [walk]
    simp [nodeAt, named, List.lookup, this]
  | succ left step =>
    have under : ¬maximumLinks ≤ hops := by omega
    rw [walk]
    simp [nodeAt, named, List.lookup, under, nonempty, relative, names]
    exact step (hops + 1) (by omega) (by omega)

/-- `measure` is a function of the tree and the path: the same tree and path measure the same. -/
theorem measure_deterministic {fs fs' : Node} {path path' : String} (sameTree : fs = fs') (samePath : path = path') :
    measure fs path = measure fs' path' := by
  subst sameTree samePath
  rfl

/-- The digest in a file's state is 64 characters long. -/
theorem measureState_digest_length {fs : Node} {path digest : String} {exec : Bool}
    (measured : measureState fs path = .file digest exec) : digest.toList.length = 64 := by
  unfold measureState at measured
  split at measured <;> first | cases measured | skip
  exact sha256Hex_length _

/--
`measure` tells apart a missing path, a directory, a symbolic link, a file that cannot be executed and one that
can: states of two different kinds are never written as the same text.
-/
theorem measure_distinguishes {fs fs' : Node} {path path' : String}
    (differ : (measureState fs path).kind ≠ (measureState fs' path').kind) :
    measure fs path ≠ measure fs' path' := by
  unfold measure
  intro same
  have chars := congrArg String.toList same
  generalize first : measureState fs path = s at *
  generalize second : measureState fs' path' = t at *
  have firstLength := fun digest exec (h : s = .file digest exec) => measureState_digest_length (first.trans h)
  have secondLength := fun digest exec (h : t = .file digest exec) => measureState_digest_length (second.trans h)
  cases s <;> cases t <;> simp [State.render, State.kind] at chars differ
  rename_i digest exec digest' exec'
  have one := firstLength digest exec rfl
  have two := secondLength digest' exec' rfl
  have lengths := congrArg List.length chars
  cases exec <;> cases exec' <;> simp at differ <;> simp at lengths <;> omega

/-- A state names its kind: equal texts come from states of one kind. -/
theorem measure_kind_eq {fs fs' : Node} {path path' : String} (same : measure fs path = measure fs' path') :
    (measureState fs path).kind = (measureState fs' path').kind :=
  Classical.byContradiction fun differ => measure_distinguishes differ same

/-- Only a directory has a link count. -/
theorem dirLinks_some_isDir {fs : Node} {path : String} {own : List String} {count : Int}
    (counted : dirLinks fs path own = some count) : ∃ entries, lstat fs path = .ok (.dir entries) := by
  unfold dirLinks at counted
  split at counted
  · exact ⟨_, by assumption⟩
  · cases counted

end ObservedReadsSpec

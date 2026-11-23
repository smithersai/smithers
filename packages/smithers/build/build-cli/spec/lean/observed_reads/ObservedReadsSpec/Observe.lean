import ObservedReadsSpec.Soundness

/-!
# From a trace to a record: `observe`

`observe` turns what a run's trace says it found, found missing, listed, made and changed into the record of
what the run read. This module specifies the part of it that decides what a record holds:

* `gather` resolves each path of the trace as the run's kernel did, noting every symbolic link on the way as
  something the run read, and refuses a path through more than `maximumLinks` links; it then asks the commit
  about each name the run wrote without first looking at it (`blind`), and notes what the run removed (`goneOf`);
* `recordOf` measures each path the run did not make and writes its row: none for a path that cannot be read
  (`readRow`), and the state the run found for a path it then changed, removed or replaced (`priorOf`).

`no_false_miss` (**Theorem 1**) then says the record holds on the file system it was made on.

What `observe` does besides is left to the implementation and its own tests: steps before the run
(`producers`, `from`, `given`), `openat2` walks, links of a process under `/proc`, mounted directories, paths
left out (`ignore`), the files a run leaves to keep (`kept`), the search of files for a variable's name or
value, and the refusals that compare a file's change time with the run's start. The paths of a trace here are
absolute and in one spelling, as `read` leaves them.
-/
namespace ObservedReadsSpec

/-- How the run first met a path. -/
inductive First where
  | found
  | missing
  | made
  deriving DecidableEq, Repr

/-- What the run did with one path. -/
structure Entry where
  path : String
  first : First
  made : Bool
  changed : Bool
  listed : Bool
  deriving Repr, DecidableEq

/-- What `read` makes of a trace: each path with the line that first said so. -/
structure Trace where
  found : List (String × Nat) := []
  missing : List (String × Nat) := []
  listed : List (String × Nat) := []
  made : List (String × Nat) := []
  emptied : List (String × Nat) := []
  changed : List String := []
  /-- The names the run removed or moved away. -/
  removed : List String := []
  /-- The names the run took away with `unlink`, having neither looked at them nor written them before. -/
  unlinked : List String := []

/-- A path from its names. -/
def renderPath (names : List String) : String := "/" ++ "/".intercalate names

/-- `posix.normalize` of an absolute path: each `..` takes away the name before it. -/
def normalizeNames (seen : List String) : List String → List String
  | [] => seen
  | name :: rest => normalizeNames (if name = ".." then seen.dropLast else seen ++ [name]) rest

/-- Where a path led, and the symbolic links it passed. -/
structure Trail where
  links : List String
  /-- The real path; none when the path passes through too many links. -/
  ended : Option String

/--
Walks a path as `observe` does: by the names in `queue` from the real directory `shown`. A name nothing is at
ends the walk, with the rest of the path put in one spelling. A link is noted and its target's names are
walked next. The walk gives up after `maximumLinks` links, so it ends on every tree.
-/
def trail (fs : Node) (hops : Nat) (shown : List String) (queue : List String) : Trail :=
  match queue with
  | [] => ⟨[], some (renderPath shown)⟩
  | part :: rest =>
    if part = ".." then trail fs hops shown.dropLast rest
    else
      match lstat fs (renderPath (shown ++ [part])) with
      | .error _ => ⟨[], some (renderPath (normalizeNames (shown ++ [part]) rest))⟩
      | .ok (.symlink target) =>
        if maximumLinks ≤ hops then ⟨[], none⟩
        else
          let next := trail fs (hops + 1) (if target.startsWith "/" then [] else shown) (parts target ++ rest)
          ⟨renderPath (shown ++ [part]) :: next.links, next.ended⟩
      | .ok _ => trail fs hops (shown ++ [part]) rest
termination_by (maximumLinks - hops, queue.length)
decreasing_by
  all_goals simp_wf
  · exact Prod.Lex.right _ (by simp)
  · exact Prod.Lex.left _ _ (by omega)
  · exact Prod.Lex.right _ (by simp)

/-- A walk notes at most `maximumLinks` links, whatever the tree. -/
theorem trail_links_le (fs : Node) (hops : Nat) (shown queue : List String) :
    hops ≤ maximumLinks → (trail fs hops shown queue).links.length + hops ≤ maximumLinks := by
  fun_induction trail fs hops shown queue <;> intro bound <;>
    first
    | (simp; omega)
    | (apply_assumption; omega)
    | (rename_i step; have := step (by omega); simp +zetaDelta at *; omega)

/-- `resolve`: the real path of a path, every link followed. -/
def realPath (fs : Node) (path : String) : Trail := trail fs 0 [] (parts path)

/-- A path's directory and its last name. -/
def splitLast (path : String) : String × String :=
  let reversed := path.toList.reverse
  let name := (reversed.takeWhile (· != '/')).reverse
  let before := (reversed.dropWhile (· != '/')).drop 1 |>.reverse
  (if before.isEmpty then "/" else String.ofList before, String.ofList name)

/-- `named`: the real path of a name: only what leads to the name is followed. -/
def namedPath (fs : Node) (path : String) : Trail :=
  let (parent, name) := splitLast path
  let walked := realPath fs parent
  ⟨walked.links, walked.ended.map fun real => if real = "/" then "/" ++ name else real ++ "/" ++ name⟩

/-- The directory a walk that gave up was asked for. -/
def refusedPath (named : Bool) (path : String) : String := if named then (splitLast path).1 else path

/-- A path the kernel makes up, which no record holds. -/
def pseudo (path : String) : Bool :=
  ["/proc", "/sys", "/dev"].any fun top => path = top || path.startsWith (top ++ "/")

/-- What `observe` is told besides the trace. -/
structure Options where
  root : String
  /-- Paths measured just before the run began, each with what was there. -/
  found : List (String × String) := []
  /-- The host's variables. -/
  values : String → Option String := fun _ => none
  /-- The variables the run could have used. -/
  shown : List String := []
  /-- Whether the commit the run ran at holds a name; none where git cannot say. -/
  held : Option (String → Bool) := none

/-- `under(path, directory)`: the directory itself or a path below it. -/
def under (path directory : String) : Bool :=
  path = directory || (directory.toList ++ ['/']).isPrefixOf path.toList

/-- A path as a record writes it: from the root inside the workspace, itself outside it. -/
def inside (root path : String) : String :=
  if path = root then String.ofList ['.']
  else if (root.toList ++ ['/']).isPrefixOf path.toList then String.ofList (path.toList.drop (root.toList.length + 1))
  else path

/-- What `gather` knows so far. -/
structure Gathered where
  entries : List Entry := []
  /-- The names the run wrote, each with the directory it is in. -/
  own : List (String × String) := []
  /-- The paths the run wrote. -/
  touched : List String := []
  /-- The names the run made. -/
  made : List String := []
  /-- The paths of the workspace the run found, removed and left removed. -/
  gone : List String := []
  /-- The names the run removed or moved away, and those it took away unseen. -/
  removed : List String := []
  unlinked : List String := []
  refusal : Option String := none

/-- Notes that the run met a path. The first meeting stays the first; making a path later is still noted. -/
def touch (entries : List Entry) (path : String) (first : First) : List Entry :=
  if entries.any (·.path = path) then
    entries.map fun entry => if entry.path = path ∧ first = .made then { entry with made := true } else entry
  else entries ++ [⟨path, first, first = .made, false, false⟩]

def mark (entries : List Entry) (path : String) (update : Entry → Entry) : List Entry :=
  entries.map fun entry => if entry.path = path then update entry else entry

/-- Notes the links a walk passed, each as found, and the walk's refusal when it gave up. -/
def follow (state : Gathered) (asked : String) (walked : Trail) : Gathered :=
  { state with
    entries := walked.links.foldl (fun entries link => if pseudo link then entries else touch entries link .found)
      state.entries
    refusal := state.refusal.or
      (if walked.ended.isNone then some (asked ++ " passes through too many symbolic links") else none) }

/-- What the trace says of one path at one line. -/
inductive Event where
  | found
  | missing
  | made
  | emptied
  | listed
  deriving DecidableEq

/-- One event of the trace, in the order of its lines. -/
def step (fs : Node) (state : Gathered) (event : Event × String) : Gathered :=
  let (kind, raw) := event
  if pseudo raw then state
  else
    let named := kind = .made ∨ kind = .missing
    let walked := if named then namedPath fs raw else realPath fs raw
    let state := follow state (refusedPath named raw) walked
    match walked.ended with
    | none => state
    | some path =>
      if pseudo path then state
      else if kind = .listed then
        let entries := touch state.entries path .found
        { state with
          entries := mark entries path (fun entry => if entry.made then entry else { entry with listed := true }) }
      else
        let how : First :=
          match kind with
          | .missing => .missing
          | .made => .made
          | .emptied => .made
          | _ => .found
        { state with entries := touch state.entries path how }

/-- A path the run wrote: the name, and the file a link under that name leads to. -/
def written (u3 : Bool) (fs : Node) (trace : Trace) (state : Gathered) (raw : String) : Gathered :=
  if pseudo raw then state
  else
    let name := namedPath fs raw
    let state := follow state (refusedPath true raw) name
    match name.ended with
    | none => state
    | some path =>
      let whole := realPath fs raw
      let state := follow state raw whole
      let real := whole.ended.getD path
      let wrote (state : Gathered) (at_ : String) : Gathered :=
        { state with
          entries := mark state.entries at_ (fun entry => { entry with changed := true })
          touched := if pseudo at_ || at_ ∈ state.touched then state.touched else state.touched ++ [at_] }
      let state := wrote state path
      let state :=
        if real = path then state
        else if (trace.made.lookup raw).isNone then wrote state real
        else { state with entries := mark state.entries real (fun entry => { entry with changed := true }) }
      let (parent, last) := splitLast path
      let counted := state.entries.any fun entry =>
        entry.path = parent ∧ (entry.listed ∨ (u3 ∧ ((lstat fs parent).map Node.isDir).toOption = some true))
      if counted then { state with own := state.own ++ [(parent, last)] } else state

/-- The events of a trace in the order of their lines; at one line, in the order `observe` gathers them. -/
def eventsOf (trace : Trace) : List (Event × String) :=
  let all : List (Nat × Event × String) :=
    trace.found.map (fun (path, line) => (line, .found, path)) ++
    trace.missing.map (fun (path, line) => (line, .missing, path)) ++
    trace.made.map (fun (path, line) => (line, .made, path)) ++
    (trace.emptied.filter fun (path, line) =>
      match trace.made.lookup path with
      | none => true
      | some madeAt => madeAt > line).map (fun (path, line) => (line, .emptied, path)) ++
    trace.listed.map (fun (path, line) => (line, .listed, path))
  (all.mergeSort fun left right => left.1 ≤ right.1).map (·.2)

/--
A name the run wrote without first looking at it, where no call says nothing was there: whether something was
there is not in the trace. Where the commit holds the name, something was.

* A path with no entry was written so without being emptied (opened to append, or to write part of it): it
  keeps bytes the run did not write, so it is an input, found and then changed, held as the run found it.
* A name whose entry says the run made it, though no call made it where nothing was, was emptied so: its bytes
  are the run's own, but the name was there for whatever listed its directory. It is taken out of the names the
  run wrote there, so it counts in that directory's listing again, and a commit that takes it away is a change.
-/
def blind (fs : Node) (trace : Trace) (root : String) (committed : String → Bool) (made : List String)
    (state : Gathered) (raw : String) : Gathered :=
  if pseudo raw then state
  else
    match (namedPath fs raw).ended with
    | none => state
    | some path =>
      let real := (realPath fs raw).ended.getD path
      let candidates := if real ≠ path ∧ (trace.made.lookup raw).isNone then [path, real] else [path]
      candidates.foldl (fun state candidate =>
        if candidate = root ∨ !under candidate root ∨ candidate ∈ made ∨ !committed (inside root candidate) then state
        else
          match state.entries.find? (·.path = candidate) with
          | none => { state with entries := state.entries ++ [⟨candidate, .found, false, true, false⟩] }
          | some entry =>
            if entry.first = .made ∧ candidate = path then
              { state with own := state.own.filter fun name => name ≠ splitLast path }
            else state) state

/--
The paths of the workspace the run found and then removed, and left removed: a later run answered from the
record has to find them gone, so they are part of what the run left, also where it left nothing else. A path
the run made and removed again was never there for anyone else, and is none.
-/
def goneOf (fs : Node) (trace : Trace) (root : String) (entries : List Entry) : List String :=
  trace.removed.filterMap fun raw =>
    if pseudo raw then none
    else (namedPath fs raw).ended.filter fun path =>
      !pseudo path && !present fs path && under path root &&
        entries.any fun entry => entry.path = path ∧ entry.first = .found

/-- What the run did with each path of its trace, or why it stores nothing. -/
def gather (rules : Rules) (fs : Node) (trace : Trace) (options : Options) : Except String Gathered :=
  let state := (eventsOf trace).foldl (step fs) {}
  let state := trace.changed.foldl (written rules.u3 fs trace) state
  match state.refusal with
  | some refusal => .error refusal
  | none =>
    let made := trace.made.filterMap fun (raw, _) =>
      if pseudo raw then none else (namedPath fs raw).ended.filter (!pseudo ·)
    let state :=
      match options.held with
      | none => state
      | some committed => trace.changed.foldl (blind fs trace options.root committed made) state
    let namedAll (raws : List String) : List String :=
      raws.filterMap fun raw => if pseudo raw then none else (namedPath fs raw).ended
    .ok { state with
      made := made
      gone := goneOf fs trace options.root state.entries
      removed := namedAll trace.removed
      unlinked := namedAll trace.unlinked }

/-! ## The record -/

/--
A path the run met is written in a record as a name that leads back to it: `absolute` undoes `inside` for every
absolute path that is not the root followed by `/.` or by a second slash. `gather` makes only such paths: each
is a real path, or a real directory and one name.
-/
theorem absolute_inside (root path : String) (isAbsolute : path.toList.head? = some '/')
    (plain : ∀ rest, path.toList = root.toList ++ '/' :: rest → rest ≠ ['.'] ∧ rest.head? ≠ some '/') :
    absolute root (inside root path) = path := by
  unfold inside
  split
  · rename_i same
    simp [absolute, same]
  · split
    · rename_i isPrefix
      have joined : path.toList = root.toList ++ '/' :: path.toList.drop (root.toList.length + 1) := by
        have parts := List.prefix_iff_eq_append.mp (List.isPrefixOf_iff_prefix.mp isPrefix)
        simpa using parts.symm
      obtain ⟨notDot, notSlash⟩ := plain _ joined
      unfold absolute
      have differs : String.ofList (path.toList.drop (root.toList.length + 1)) ≠ String.ofList ['.'] := by
        intro same
        exact notDot (by simpa using congrArg String.toList same)
      simp only [differs, ↓reduceIte, String.toList_ofList, notSlash]
      apply String.toList_inj.mp
      simp [String.toList_append, joined.symm]
    · unfold absolute
      have differs : path ≠ String.ofList ['.'] := by
        intro same
        rw [same] at isAbsolute
        simp at isAbsolute
      simp [differs, isAbsolute]

/-- Each name once. -/
def dedup : List String → List String
  | [] => []
  | name :: rest => if name ∈ rest then dedup rest else name :: dedup rest

theorem mem_dedup {name : String} {names : List String} : name ∈ dedup names ↔ name ∈ names := by
  induction names with
  | nil => simp [dedup]
  | cons head rest step =>
    unfold dedup
    split
    · rename_i again
      constructor
      · intro held
        exact List.mem_cons_of_mem _ (step.mp held)
      · intro held
        rcases List.mem_cons.mp held with rfl | later
        · exact step.mpr again
        · exact step.mpr later
    · simp [step]

/--
`priorOf`: the state a row holds for a path the run found and then changed, from what was measured there before
the run (`before`) and what the run left (`state`). The `fallback` (`?` under `u2`, which nothing matches)
stands where the measurement cannot hold the path as the run found it: nothing was there, though the run found
something; it could not be read; it was a directory that is none now, whose names and count of directories `d`
does not say; or the run listed it and it is no directory now, so what it listed there cannot be measured again.
-/
def priorOf (fallback before state : String) (listed : Bool) : String :=
  if before = absent ∨ unread before = true ∨ (state ≠ directory ∧ (before = directory ∨ listed = true)) then fallback
  else before

/--
The row of one path the run did not make, or why the run stores nothing.

A path that cannot be read now stores nothing: its state would say only that, for every content it may hold.
A path the run found and then changed is held as the run found it, whatever it left there: a file it wrote
again, and as much a path it removed or put a directory at. A directory that is still one is held as the run
left it where it was one all along: the run listed it, or never took its name away nor made it. A name the run
took away unseen is held as any name that is no directory (`nameOnly`).
-/
def readRow (rules : Rules) (fs : Node) (options : Options) (gathered : Gathered) (entry : Entry) :
    Except String ReadRow :=
  let state := measure fs entry.path
  let name := inside options.root entry.path
  if unread state = true then
    .error (name ++ " cannot be read now (" ++ String.ofList (state.toList.drop 1) ++
      "), so what the run read there cannot be known")
  else if entry.first = .missing then
    .ok (if state ≠ absent ∧ entry.made = true then ⟨name, state, some absent⟩ else ⟨name, absent, none⟩)
  else if entry.changed = false ∧ state = absent then .error (name ++ " was removed while it ran")
  else if entry.changed = true ∧
      ¬(state = directory ∧ (entry.listed = true ∨ ¬(entry.made = true ∨ entry.path ∈ gathered.removed))) then
    let fallback := if rules.u2 then unmeasured else state
    let before :=
      if state = absent ∧ entry.path ∈ gathered.unlinked then nameOnly
      else (options.found.lookup entry.path).getD fallback
    .ok ⟨name, state, some (priorOf fallback before state entry.listed)⟩
  else .ok ⟨name, state, none⟩

/-- Maps a list with a function that may refuse; the first refusal is the answer. -/
def mapE {α β ε : Type} (f : α → Except ε β) : List α → Except ε (List β)
  | [] => .ok []
  | item :: rest =>
    match f item with
    | .error refusal => .error refusal
    | .ok value =>
      match mapE f rest with
      | .error refusal => .error refusal
      | .ok values => .ok (value :: values)

theorem mem_of_mapE {α β ε : Type} {f : α → Except ε β} {items : List α} {values : List β}
    (mapped : mapE f items = .ok values) {value : β} (held : value ∈ values) :
    ∃ item ∈ items, f item = .ok value := by
  induction items generalizing values with
  | nil =>
    cases mapped
    cases held
  | cons item rest step =>
    unfold mapE at mapped
    split at mapped
    · cases mapped
    · rename_i head one
      split at mapped
      · cases mapped
      · rename_i tail others
        cases mapped
        rcases List.mem_cons.mp held with rfl | later
        · exact ⟨item, List.mem_cons_self, one⟩
        · obtain ⟨found, inRest, ok⟩ := step others later
          exact ⟨found, List.mem_cons_of_mem _ inRest, ok⟩

/-- The names the run wrote in a directory, sorted. -/
def ownNames (gathered : Gathered) (path : String) : List String :=
  sortByCodeUnit (dedup ((gathered.own.filter (·.1 = path)).map (·.2)))

/-- The row of a directory the run listed. -/
def listRow (fs : Node) (options : Options) (gathered : Gathered) (entry : Entry) : Option ListRow :=
  if entry.first = .missing ∨ entry.listed = false then none
  else
    let names := ownNames gathered entry.path
    (listing fs entry.path names).map fun digest => ⟨inside options.root entry.path, digest, names, none⟩

/-- The row of a directory the run looked at and did not list (`u3`). -/
def linkRow (fs : Node) (options : Options) (gathered : Gathered) (entry : Entry) : Option LinkRow :=
  if entry.first = .missing ∨ entry.listed = true ∨ measure fs entry.path ≠ directory ∨ entry.path = "/" ∨
      ¬(under entry.path options.root ∨ !under options.root entry.path) then none
  else
    let names := ownNames gathered entry.path
    (dirLinks fs entry.path names).map fun count => ⟨inside options.root entry.path, count, names, none⟩

/-- The prefixes of a name that end before a slash, and the name: the names on its way from the root. -/
def waysOf (name : String) : List String :=
  let pieces := name.splitOn "/"
  (List.range pieces.length).map fun count => "/".intercalate (pieces.take (count + 1))

/--
`Record.made`: each name of the workspace the run wrote and did not find there, raised to the highest name on
its way that the commit holds nothing at. None where git cannot say.
-/
def madePlaces (options : Options) (gathered : Gathered) : Option (List String) :=
  options.held.map fun committed =>
    let names := (gathered.touched ++ gathered.made).filter fun path =>
      path ≠ options.root ∧ under path options.root ∧ !under path (options.root ++ "/.git") ∧
        (gathered.entries.all fun entry => entry.path ≠ path ∨ entry.first = .made)
    sortByCodeUnit (dedup (names.filterMap fun path =>
      (waysOf (inside options.root path)).find? fun way => !committed way))

/-- The variables the run could have used, each with what it held. -/
def variablesOf (options : Options) : List (String × String) :=
  (sortByCodeUnit (dedup options.shown)).map fun name => (name, heldAs (options.values name))

def nonempty {α : Type} (items : List α) : Option (List α) := if items.isEmpty then none else some items

/-- The paths the run did not make, in the order a record holds them. -/
def inputsOf (gathered : Gathered) : List Entry :=
  (gathered.entries.filter (·.first ≠ .made)).mergeSort fun left right => byCodeUnitLe left.path right.path

theorem mem_inputsOf {gathered : Gathered} {entry : Entry} (held : entry ∈ inputsOf gathered) :
    entry ∈ gathered.entries := (List.mem_filter.mp (List.mem_mergeSort.mp held)).1

/-- A record before it has its id. -/
def bodyOf (rules : Rules) (fs : Node) (options : Options) (gathered : Gathered) (reads : List ReadRow) : Record where
  id := ""
  reads := reads
  lists := (inputsOf gathered).filterMap (listRow fs options gathered)
  links := if rules.u3 then nonempty ((inputsOf gathered).filterMap (linkRow fs options gathered)) else none
  left := (gathered.touched.any fun path => path ≠ options.root ∧ present fs path) || !gathered.gone.isEmpty
  made := (madePlaces options gathered).bind nonempty
  variables := nonempty (variablesOf options)

/-- A record under its id: a digest of what it holds. -/
def withId (body : Record) : Record := { body with id := idOf body }

/-- The record of what the run read, from what `gather` made of its trace. -/
def recordOf (rules : Rules) (fs : Node) (options : Options) (gathered : Gathered) : Except String Record :=
  match mapE (readRow rules fs options gathered) (inputsOf gathered) with
  | .error refusal => .error refusal
  | .ok reads => .ok (withId (bodyOf rules fs options gathered reads))

/-- `observe`: the record of what a run read, or why the run stores nothing. -/
def observe (rules : Rules) (fs : Node) (trace : Trace) (options : Options) : Except String Record :=
  match gather rules fs trace options with
  | .error refusal => .error refusal
  | .ok gathered => recordOf rules fs options gathered

/-- The world a record is held against right after its run: the same file system, variables and commit. -/
def worldOf (fs : Node) (options : Options) (own : String → Bool) : World where
  fs := fs
  root := options.root
  values := options.values
  holds := fun names => options.held.map fun committed => names.filter committed
  own := own

/-! ## Theorem 1 -/

theorem getD_nonempty {α : Type} (items : List α) : (nonempty items).getD [] = items := by
  unfold nonempty
  cases items <;> simp

theorem unmeasured_ne_absent : unmeasured ≠ absent := by
  intro same
  have chars := congrArg String.toList same
  simp [unmeasured, absent, State.render] at chars

/--
Under `u2`, a row whose third state is the path's state, or is `-`, holds where the path is as the row says
and could be read.
-/
theorem readHolds_u2 (now before : String) (readable : unread now = false)
    (fixed : before ≠ absent → before = now) : readHolds true now now (some before) = true := by
  by_cases gone : before = absent
  · simp [readHolds, same, gone, readable]
  · have settled := fixed gone
    subst settled
    by_cases unseen : before = nameOnly
    · subst unseen
      have away : nameOnly ≠ directory := by
        intro equal
        have chars := congrArg String.toList equal
        simp [nameOnly, directory, State.render] at chars
      simp [readHolds, gone, namePresent, readable, away]
    · simp [readHolds, same, gone, unseen, readable]

/-- A record's made names are none of them the commit's when each was chosen as a name the commit does not hold. -/
theorem madeVerdict_none (world : World) (record : Record) (held : Option (String → Bool))
    (names : (String → Bool) → List String)
    (holds : world.holds = fun made => held.map fun committed => made.filter committed)
    (made : record.made = (held.map fun committed => sortByCodeUnit (dedup (names committed))).bind nonempty)
    (free : ∀ committed name, name ∈ names committed → committed name = false) :
    madeVerdict world record = none := by
  unfold madeVerdict
  rw [made, holds]
  cases held with
  | none => rfl
  | some committed =>
    simp only [Option.map_some, Option.bind_some]
    have clear : ∀ name ∈ sortByCodeUnit (dedup (names committed)), committed name = false := fun name inside =>
      free committed name (mem_dedup.mp (mem_sortByCodeUnit.mp inside))
    generalize sortByCodeUnit (dedup (names committed)) = sorted at clear
    cases sorted with
    | nil => rfl
    | cons head rest =>
      simp only [nonempty, List.isEmpty_cons, Bool.false_eq_true, ↓reduceIte, Option.getD_some,
        Option.map_eq_none_iff]
      apply List.find?_eq_none.mpr
      intro name inside
      simp [clear name inside]

/--
**Theorem 1 (no false miss on an unchanged state).** The record `recordOf` makes holds on the file system it
was made on, with the same variables and the same commit, given three things:

* `spelled`: each path the run met is written in the record as a name `absolute` leads back from;
* `quiet`: nothing appeared, while the run ran, at a path it found missing and did not make;
* `unchanged`: under `u2`, each file the run changed is as the run found it: its row's `before` is its state.
  A run that leaves a file other than it found it changes its own input, and is meant to run again.
-/
theorem recordOf_holds (rules : Rules) (fs : Node) (options : Options) (gathered : Gathered) (record : Record)
    (own : String → Bool) (recorded : recordOf rules fs options gathered = .ok record)
    (spelled : ∀ entry ∈ gathered.entries, absolute options.root (inside options.root entry.path) = entry.path)
    (quiet : ∀ entry ∈ gathered.entries, entry.first = .missing → entry.made = false → measure fs entry.path = absent)
    (unchanged : rules.u2 = true → ∀ row ∈ record.reads, ∀ before, row.other = some before → before ≠ absent →
      before = row.state) :
    changed rules (worldOf fs options own) record = none := by
  unfold recordOf at recorded
  cases mapped : mapE (readRow rules fs options gathered) (inputsOf gathered) with
  | error refusal => simp [mapped] at recorded
  | ok reads =>
    simp only [mapped] at recorded
    cases recorded
    have inputOf : ∀ entry, entry ∈ inputsOf gathered → entry ∈ gathered.entries := fun _ => mem_inputsOf
    simp only [withId, bodyOf] at unchanged ⊢
    apply first_eq_none.mpr
    intro verdict among
    simp only [List.mem_cons, List.not_mem_nil, or_false] at among
    rcases among with rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl
    · simp [servedVerdict]
    · apply List.findSome?_eq_none_iff.mpr
      intro row held
      rw [getD_nonempty] at held
      obtain ⟨name, _, rfl⟩ := List.mem_map.mp held
      simp [variableVerdict, worldOf]
    · apply List.findSome?_eq_none_iff.mpr
      intro row held
      have held := mem_cheapestFirst.mp held
      obtain ⟨entry, input, made⟩ := mem_of_mapE mapped held
      have back := spelled entry (inputOf entry input)
      simp only [readVerdict, worldOf]
      have holds : readHolds rules.u2 (measure fs (absolute options.root row.path)) row.state row.other = true := by
        unfold readRow at made
        simp only at made
        split at made
        · cases made
        · rename_i failed
          have readable : unread (measure fs entry.path) = false := by simpa using failed
          split at made
          · rename_i missing
            split at made
            · cases made
              simp only [back]
              cases rules.u2 <;> simp [readHolds, same, readable]
            · rename_i notMade
              cases made
              simp only [back]
              have gone : measure fs entry.path = absent := by
                by_cases there : measure fs entry.path = absent
                · exact there
                · have unmade : entry.made = false := by
                    cases flag : entry.made
                    · rfl
                    · exact absurd ⟨there, flag⟩ notMade
                  exact quiet entry (inputOf entry input) missing unmade
              cases rules.u2 <;> simp [readHolds, same, gone, unread_absent]
          · split at made
            · cases made
            · split at made
              · cases made
                rw [back]
                cases u2 : rules.u2
                · simp [readHolds, same, readable]
                · have fixed := unchanged u2 _ held _ rfl
                  rw [u2] at fixed
                  exact readHolds_u2 _ _ readable fixed
              · cases made
                simp only [back]
                cases rules.u2 <;> simp [readHolds, same, readable]
      simp [holds]
    · exact madeVerdict_none _ _ options.held _ rfl rfl (by
        intro committed name held
        obtain ⟨path, _, found⟩ := List.mem_filterMap.mp held
        simpa using List.find?_some found)
    · simp [fromVerdict]
    · simp [givenVerdict]
    · unfold linksVerdict
      split
      · rename_i u3
        apply List.findSome?_eq_none_iff.mpr
        intro row held
        simp only [getD_nonempty] at held
        obtain ⟨entry, input, made⟩ := List.mem_filterMap.mp held
        have back := spelled entry (inputOf entry input)
        unfold linkRow at made
        split at made
        · cases made
        · obtain ⟨count, counted, rfl⟩ := Option.map_eq_some_iff.mp made
          simp [linkVerdict, pending, worldOf, back, counted, addedVerdict]
      · rfl
    · apply List.findSome?_eq_none_iff.mpr
      intro row held
      obtain ⟨entry, input, made⟩ := List.mem_filterMap.mp held
      have back := spelled entry (inputOf entry input)
      unfold listRow at made
      split at made
      · cases made
      · obtain ⟨digest, listed, rfl⟩ := Option.map_eq_some_iff.mp made
        simp [listVerdict, pending, worldOf, back, listed, addedVerdict]

/-- Theorem 1 for `observe`: the hypotheses are asked of what `gather` made of the trace. -/
theorem no_false_miss (rules : Rules) (fs : Node) (trace : Trace) (options : Options) (record : Record)
    (own : String → Bool) (observed : observe rules fs trace options = .ok record)
    (spelled : ∀ gathered, gather rules fs trace options = .ok gathered → ∀ entry ∈ gathered.entries,
      absolute options.root (inside options.root entry.path) = entry.path)
    (quiet : ∀ gathered, gather rules fs trace options = .ok gathered → ∀ entry ∈ gathered.entries,
      entry.first = .missing → entry.made = false → measure fs entry.path = absent)
    (unchanged : rules.u2 = true → ∀ row ∈ record.reads, ∀ before, row.other = some before → before ≠ absent →
      before = row.state) :
    changed rules (worldOf fs options own) record = none := by
  unfold observe at observed
  split at observed
  · cases observed
  · rename_i gathered ok
    exact recordOf_holds rules fs options gathered record own observed (spelled gathered ok) (quiet gathered ok)
      unchanged

/-- `observe` refuses a path through a cycle of links: it never records one, and never runs on. -/
theorem trail_refuses_selfLoop (name target : String) (names : parts target = [name])
    (relative : target.startsWith "/" = false) (named : name ≠ "..")
    (isLink : ∀ fs : Node, fs = .dir [(name, .symlink target)] →
      lstat fs (renderPath [name]) = .ok (.symlink target))
    (hops : Nat) (bound : hops ≤ maximumLinks) :
    (trail (.dir [(name, .symlink target)]) hops [] [name]).ended = none := by
  generalize gap : maximumLinks - hops = left
  induction left generalizing hops with
  | zero =>
    have over : maximumLinks ≤ hops := by omega
    rw [trail]
    simp [named, isLink _ rfl, over]
  | succ left step =>
    have within : ¬maximumLinks ≤ hops := by omega
    rw [trail]
    simp [named, isLink _ rfl, within, relative, names]
    exact step (hops + 1) (by omega) (by omega)

end ObservedReadsSpec

import ObservedReadsSpec.Record

/-!
# When a record still holds: `changed`, and why its answer is sound

`changed` says what a record's run read that is no longer the same, or nothing when the record still holds and
the run's results may be used again. This module specifies it over the file system of `Vfs.lean` and proves
that a record does not hold once anything it names has changed:

* a path it read (`changed_of_read_mutated`),
* a path that could not be read when the record was made, whatever is there now (`changed_of_unread`),
* a path its run removed, where it is gone again and not as the run found it (`changed_of_removed_left`),
* a directory it listed (`changed_of_listing_mutated`),
* a variable it could have used (`changed_of_variable_mutated`),
* a file it changed, under the `u2` rule (`changed_of_modified_left`),
* a directory it looked at, under the `u3` rule (`changed_of_links_mutated`).

`Observe.lean` specifies the other direction: the record `observe` makes holds on the file system it was made on.
-/
namespace ObservedReadsSpec

/-- `heldAs`: a variable's value as a record holds it: a digest, or `-` when the variable is not set. -/
def heldAs : Option String → String
  | none => absent
  | some value => sha256Hex value

/-- The state of a directory. -/
def directory : String := State.dir.render

/-- What stands for a file's state before a run that changed it, where that state was not measured. -/
def unmeasured : String := String.ofList ['?']

/--
What stands for the state of a name the run took away without looking at it (`unlink`): a name that is no
directory, whatever it holds. That one was there is all the run learned of it.
-/
def nameOnly : String := String.ofList ['*']

/-- A resolved regular file whose preexisting bytes a truncation discarded. -/
def regularOnly : String := "f:*"

theorem measure_ne_unmeasured (fs : Node) (path : String) : measure fs path ≠ unmeasured := by
  intro equal
  have chars := congrArg String.toList equal
  unfold measure at chars
  cases h : measureState fs path <;> simp [h, State.render, unmeasured] at chars

/-- What a record is held against. -/
structure World where
  /-- The file system now. -/
  fs : Node
  /-- The workspace root. -/
  root : String
  mounts : Mounts := []
  /-- The host's variables now. -/
  values : String → Option String
  /-- For a step the run read files from: the ids of the records it is answered from, none once it ran. -/
  answered : String → Option (List String) := fun _ => none
  /-- The same for a step whose program answered the run. -/
  served : String → Option (List String) := fun _ => none
  /-- Which of some names the commit holds; none where git cannot say. -/
  holds : List String → Option (List String) := fun _ => none
  /-- Whether a path is one of the commit's own files, which are held first. -/
  own : String → Bool := fun _ => false

/-- A path of a record on the host: from the root inside the workspace, itself outside it. -/
def absolute (root path : String) : String :=
  if path = String.ofList ['.'] then root
  else if path.toList.head? = some '/' then path
  else root ++ String.ofList ['/'] ++ path

/-- The first verdict that says something. -/
def first {α : Type} : List (Option α) → Option α
  | [] => none
  | some verdict :: _ => some verdict
  | none :: rest => first rest

theorem first_eq_none {α : Type} {verdicts : List (Option α)} :
    first verdicts = none ↔ ∀ verdict ∈ verdicts, verdict = none := by
  induction verdicts with
  | nil => simp [first]
  | cons head rest step =>
    cases head with
    | none => simp [first, step]
    | some verdict => simp [first]

/-! ## Reads -/

/--
Whether a state says only that its path could not be read (`!<code>`). Such a state says nothing of what is at
the path: it is the same text for every content a file may hold.
-/
def unread (state : String) : Bool := state.toList.head? = some '!'

/--
`same`: whether a path that holds `now` is as a record held it. A state that says the path could not be read
matches nothing, itself included: the same failure at the next look says nothing of what is there then.
-/
def same (now held : String) : Bool := now = held && !unread held

theorem unread_absent : unread absent = false := by
  simp [unread, absent, State.render]

/-- Whether a path that holds `now` is a name that is no directory: what a row of `nameOnly` asks. -/
def namePresent (now : String) : Bool := now != absent && now != directory && !unread now

/--
Whether a path that holds `now` is as its row says.

Before `u2`, a row `[path, left, before]` of a file the run changed held with either state. Under `u2` it
holds only with `before`: a run that finds the file as the last run left it reads other bytes than that run
read. That is so of every path the run found and then changed: a file it wrote again, and a path it removed
or put something else at, whose row is `[path, -, before]`. A third state of `-` marks a path the run found
missing and made, which holds missing or as it was left. A third state of `*` marks a name the run took away
without looking at it, which holds while a name that is no directory is there.
-/
def readHolds (u2 : Bool) (now state : String) (other : Option String) : Bool :=
  if u2 then
    match other with
    | none => same now state
    | some before =>
      if before = absent then same now state || now = absent
      else if before = nameOnly then namePresent now
      else if before = regularOnly then now.startsWith "f:"
      else before != unmeasured && same now before
  else
    same now state ||
      match other with
      | none => false
      | some held => if held = nameOnly then namePresent now else same now held

/--
How `changed` says a read no longer holds. A row with a third state is of a path the run wrote: one it left
gone was there when the run found it, so what is there now is other, not new.
-/
def readMessage (path now state : String) (other : Option String) : String :=
  if now = absent then path ++ " is gone"
  else if state = absent ∧ other = none then path ++ " now exists"
  else path ++ " changed"

/-- Where the checkout supplies a relative name observed missing before the run wrote it. -/
def heldCreated (world : World) (record : Record) (path : String) : Option Bool :=
  if path.startsWith "/" then none else
    let created := (record.reads.filter fun row => row.other == some absent && !row.path.startsWith "/").map (·.path)
    (world.holds created).map (·.contains path)

/-- A leftover output can satisfy an absence only when the run left it and the checkout did not supply it. -/
def leftover (world : World) (record : Record) (path : String) : Bool :=
  record.left && (path.startsWith "/" || heldCreated world record path == some false)

/-- Applies the provenance condition only to an absence now occupied by a possible leftover. -/
def absenceHolds (rules : Rules) (world : World) (record : Record) (row : ReadRow) : Bool :=
  !rules.u2 || row.other != some absent || measure world.fs (absolute world.root row.path) == absent ||
    leftover world record row.path

theorem absenceHolds_of_provenance (rules : Rules) (world : World) (record : Record) (row : ReadRow)
    (provenance : rules.u2 = true → row.other = some absent →
      measure world.fs (absolute world.root row.path) ≠ absent → leftover world record row.path = true) :
    absenceHolds rules world record row = true := by
  by_cases current : rules.u2 = true
  · by_cases missing : row.other = some absent
    · by_cases gone : measure world.fs (absolute world.root row.path) = absent
      · simp [absenceHolds, gone]
      · simp [absenceHolds, provenance current missing gone]
    · simp [absenceHolds, missing]
  · simp [absenceHolds, Bool.eq_false_iff.mpr current]

def readVerdict (rules : Rules) (world : World) (record : Record) (row : ReadRow) : Option String :=
  let now := measure world.fs (absolute world.root row.path)
  if readHolds rules.u2 now row.state row.other && absenceHolds rules world record row then none
  else if now ≠ absent && row.other == some absent && (record.made.getD []).contains row.path &&
      heldCreated world record row.path == some true then
    some (row.path ++ ", which the run made, is in the commit now")
  else some (readMessage row.path now row.state row.other)

/-- The group a read is held in: the commit's own files, the rest of the workspace, what is outside it. -/
def tier (world : World) (row : ReadRow) : Nat :=
  if world.own row.path then 0 else if row.path.startsWith "/" then 2 else 1

/-- `cheapestFirst`: the reads in the order they are held against the host, each group by size. -/
def cheapestFirst (world : World) (reads : List ReadRow) : List ReadRow :=
  let sized (group : Nat) : List ReadRow :=
    (reads.filter (fun row => tier world row = group)).mergeSort
      (fun left right => sizeOf world.fs (absolute world.root left.path) ≤
        sizeOf world.fs (absolute world.root right.path))
  sized 0 ++ sized 1 ++ sized 2

theorem mem_cheapestFirst {world : World} {reads : List ReadRow} {row : ReadRow} :
    row ∈ cheapestFirst world reads ↔ row ∈ reads := by
  simp only [cheapestFirst, List.mem_append, List.mem_mergeSort, List.mem_filter, decide_eq_true_eq]
  constructor
  · rintro ((⟨held, _⟩ | ⟨held, _⟩) | ⟨held, _⟩) <;> exact held
  · intro held
    have : tier world row = 0 ∨ tier world row = 1 ∨ tier world row = 2 := by
      unfold tier
      split
      · exact .inl rfl
      · split
        · exact .inr (.inr rfl)
        · exact .inr (.inl rfl)
    rcases this with zero | one | two
    · exact .inl (.inl ⟨held, zero⟩)
    · exact .inl (.inr ⟨held, one⟩)
    · exact .inr ⟨held, two⟩

def readsVerdict (rules : Rules) (world : World) (record : Record) : Option String :=
  (cheapestFirst world record.reads).findSome? (readVerdict rules world record)

/-! ## Programs, variables, made names and steps before the run -/

/-- Whether a step is answered from a record: unknown once the step ran. -/
def answeredFrom (answer : Option (List String)) (id : String) : Option Bool := answer.map (fun ids => decide (id ∈ ids))

def servedVerdict (world : World) (record : Record) : Option String :=
  (record.served.getD []).findSome? fun (label, id) =>
    if answeredFrom (world.served label) id = some true then none
    else some ("the program " ++ label ++ " started, which it talked to, is not the one it talked to")

def variableVerdict (world : World) (row : String × String) : Option String :=
  if heldAs (world.values row.1) = row.2 then none else some ("the variable " ++ row.1 ++ " has another value")

def variablesVerdict (world : World) (record : Record) : Option String :=
  (record.variables.getD []).findSome? (variableVerdict world)

/--
A name the run made where its commit held nothing: the record does not hold once a commit puts something
there. Where git cannot say, anything there may be the commit's.
-/
def madeVerdict (world : World) (record : Record) : Option String :=
  match record.made with
  | none => none
  | some made =>
    let held := world.holds made
    let there := held.getD (made.filter fun name => present world.fs (absolute world.root name))
    (made.find? fun name => decide (name ∈ there)).map fun name =>
      name ++ ", which the run made, " ++ (if held.isNone then "is there now" else "is in the commit now")

def fromVerdict (world : World) (record : Record) : Option String :=
  (record.from.getD []).findSome? fun (label, id) =>
    if answeredFrom (world.answered label) id = some false then
      some (label ++ " is answered from another of its runs")
    else none

/-- Whether the step at a place in `from` is answered from the record this run read its files under. -/
def again (world : World) (record : Record) (place : Nat) : Bool :=
  match (record.from.getD [])[place]? with
  | some (label, id) => answeredFrom (world.answered label) id = some true
  | none => false

def labelAt (record : Record) (place : Nat) : String := (((record.from.getD [])[place]?).map (·.1)).getD ""

/-- A consumer that changed an input holds the producer's preimage. A name-only input needs no bytes. -/
def GivenRow.matches (row : GivenRow) (now : String) : Bool :=
  let expected := row.prior.getD row.state
  if row.prior = some nameOnly then namePresent now
  else if row.prior = some regularOnly then now.startsWith "f:"
  else expected != unmeasured && same now expected

def givenVerdict (world : World) (record : Record) : Option String :=
  (record.given.getD []).findSome? fun row =>
    let now := measure world.fs (absolute world.root row.path)
    let left := row.path ++ ", which " ++ labelAt record row.place ++ " left,"
    if row.matches now then none
    else if row.prior = some unmeasured then some (left ++ " changed")
    else if now ≠ absent then some (if row.prior.getD row.state = absent then row.path ++ " now exists" else left ++ " changed")
    else if again world record row.place then none
    else some (left ++ " is gone")

/-- A missing input of a producer that will restore it can defer a directory check. -/
def pending (world : World) (record : Record) : List String :=
  (record.given.getD []).filterMap fun row =>
    let now := measure world.fs (absolute world.root row.path)
    if !row.matches now && row.prior != some unmeasured && now = absent && again world record row.place then some row.path
    else none

/-! ## Directories -/

/-- A name a step before the run wrote in a directory: it is there, or that step writes it again. -/
def addedVerdict (world : World) (record : Record) (path directory : String) (added : List (String × Nat)) :
    Option String :=
  added.findSome? fun (name, place) =>
    if !present world.fs (directory ++ "/" ++ name) && !again world record place then
      some ((if path = "." then "" else path ++ "/") ++ name ++ " is gone")
    else none

def listVerdict (world : World) (record : Record) (row : ListRow) : Option String :=
  if row.path ∈ pending world record then none
  else
    let added := row.added.getD []
    if listing world.fs (absolute world.root row.path) (row.own ++ added.map (·.1)) world.mounts = some row.digest then
      added.findSome? fun (name, place, kind) =>
        let path := (if row.path = "." then "" else row.path ++ "/") ++ name
        match lstat world.fs (joinPath (absolute world.root row.path) name) with
        | .ok node => if node.entryType = kind then none else some (path ++ " changed type")
        | .error .ENOENT => if again world record place then none else some (path ++ " is gone")
        | .error _ => some (path ++ " cannot be inspected")
    else some (row.path ++ " gained or lost an entry")

def listsVerdict (world : World) (record : Record) : Option String :=
  record.lists.findSome? (listVerdict world record)

def linkVerdict (world : World) (record : Record) (row : LinkRow) : Option String :=
  if row.path ∈ pending world record then none
  else
    let added := row.added.getD []
    if dirLinks world.fs (absolute world.root row.path) (row.own ++ added.map (·.1)) = some row.count then
      addedVerdict world record row.path (absolute world.root row.path) added
    else some (row.path ++ " gained or lost a subdirectory")

/-- The `u3` rule: a directory the run looked at holds while its count of directories is the same. -/
def linksVerdict (rules : Rules) (world : World) (record : Record) : Option String :=
  if rules.u3 then (record.links.getD []).findSome? (linkVerdict world record) else none

/-! ## `changed` -/

/--
`changed`: what a record's run read that is no longer the same, or none when every path it read still holds
what the run left there and every variable it could have used holds the value it had.
-/
def changed (rules : Rules) (world : World) (record : Record) : Option String :=
  first [
    servedVerdict world record,
    variablesVerdict world record,
    readsVerdict rules world record,
    madeVerdict world record,
    fromVerdict world record,
    givenVerdict world record,
    linksVerdict rules world record,
    listsVerdict world record
  ]

/-! ## Soundness: a record that holds names nothing that changed -/

/-- A record that holds has every read as its row says. -/
theorem reads_hold_of_unchanged {rules : Rules} {world : World} {record : Record}
    (holds : changed rules world record = none) (row : ReadRow) (held : row ∈ record.reads) :
    readHolds rules.u2 (measure world.fs (absolute world.root row.path)) row.state row.other = true := by
  have quiet := first_eq_none.mp holds (readsVerdict rules world record) (by simp)
  have each := List.findSome?_eq_none_iff.mp quiet row (mem_cheapestFirst.mpr held)
  simp only [readVerdict] at each
  split at each
  · rename_i yes
    exact (Bool.and_eq_true_iff.mp yes).1
  · split at each <;> contradiction

/-- A committed path never satisfies a row which originally observed absence and then created the path. -/
theorem changed_of_occupied_absence (u3 : Bool) (world : World) (record : Record) (row : ReadRow)
    (held : row ∈ record.reads) (missing : row.other = some absent)
    (occupied : measure world.fs (absolute world.root row.path) ≠ absent)
    (foreign_ : leftover world record row.path = false) :
    changed ⟨true, u3⟩ world record ≠ none := by
  intro holds
  have quiet := first_eq_none.mp holds (readsVerdict ⟨true, u3⟩ world record) (by simp)
  have each := List.findSome?_eq_none_iff.mp quiet row (mem_cheapestFirst.mpr held)
  simp [readVerdict, absenceHolds, missing, occupied, foreign_] at each
  split at each <;> contradiction

/-- No producer can restore an unmeasured input of a consumer that changed it. -/
theorem changed_of_unmeasured_given (rules : Rules) (world : World) (record : Record) (row : GivenRow)
    (held : row ∈ record.given.getD []) (unknown : row.prior = some unmeasured) :
    changed rules world record ≠ none := by
  intro holds
  have quiet := first_eq_none.mp holds (givenVerdict world record) (by simp)
  have each := List.findSome?_eq_none_iff.mp quiet row held
  simp [GivenRow.matches, unknown, unmeasured, nameOnly, regularOnly] at each

/--
**Theorem 2 (no stale hit on a read).** A record that holds `[path, state]` does not hold on a file system
where the path measures otherwise.
-/
theorem changed_of_read_mutated (rules : Rules) (world : World) (record : Record) (row : ReadRow)
    (held : row ∈ record.reads) (plain : row.other = none)
    (mutated : measure world.fs (absolute world.root row.path) ≠ row.state) :
    changed rules world record ≠ none := by
  intro holds
  have each := reads_hold_of_unchanged holds row held
  cases u2 : rules.u2 <;> simp [readHolds, same, u2, plain, mutated] at each

/--
**Theorem 2b (no stale hit on a path that could not be read).** A record that holds `[path, !<code>]` holds on
no file system: the state says only that the path could not be read, which is as true of a file whose bytes
changed. `observe` stores no such row (`readRow`); a record that holds one was stored before it refused them.
-/
theorem changed_of_unread (rules : Rules) (world : World) (record : Record) (row : ReadRow)
    (held : row ∈ record.reads) (plain : row.other = none) (failed : unread row.state = true) :
    changed rules world record ≠ none := by
  intro holds
  have each := reads_hold_of_unchanged holds row held
  cases u2 : rules.u2 <;> simp [readHolds, same, u2, plain, failed] at each

/--
**Theorem 3 (no stale hit on a listed directory).** A record that holds a listing `[directory, digest, own]`
does not hold once the directory's names apart from `own` have another digest, or the directory cannot be
listed. The one exemption `changed` makes is a directory a step before the run wrote that is missing now and
that the step writes again (`pending`).
-/
theorem changed_of_listing_mutated (rules : Rules) (world : World) (record : Record) (row : ListRow)
    (held : row ∈ record.lists) (due : row.path ∉ pending world record)
    (mutated : listing world.fs (absolute world.root row.path) (row.own ++ (row.added.getD []).map (·.1)) world.mounts ≠
      some row.digest) :
    changed rules world record ≠ none := by
  intro holds
  have quiet := first_eq_none.mp holds (listsVerdict world record) (by simp)
  have each := List.findSome?_eq_none_iff.mp quiet row held
  simp [listVerdict, due, mutated] at each

/-- Theorem 3 for a record of a run that read no file of a step before it: no directory is exempt. -/
theorem changed_of_listing_mutated_alone (rules : Rules) (world : World) (record : Record) (row : ListRow)
    (held : row ∈ record.lists) (alone : record.given = none) (plain : row.added = none)
    (mutated : listing world.fs (absolute world.root row.path) row.own world.mounts ≠ some row.digest) :
    changed rules world record ≠ none := by
  apply changed_of_listing_mutated rules world record row held
  · simp [pending, alone]
  · simpa [plain] using mutated

/--
**Theorem 4 (no stale hit on a variable).** A record that holds `[name, held]` does not hold where the
variable's value is held as anything else.
-/
theorem changed_of_variable_mutated (rules : Rules) (world : World) (record : Record) (name value : String)
    (held : (name, value) ∈ record.variables.getD []) (mutated : heldAs (world.values name) ≠ value) :
    changed rules world record ≠ none := by
  intro holds
  have quiet := first_eq_none.mp holds (variablesVerdict world record) (by simp)
  have each := List.findSome?_eq_none_iff.mp quiet (name, value) held
  simp [variableVerdict, mutated] at each

/--
**Theorem 5 (`u2`).** Under `u2`, a record that holds `[path, left, before]` for a file its run changed does
not hold on a file system where the file is as the run left it, when that is not as the run found it.
-/
theorem changed_of_modified_left (u3 : Bool) (world : World) (record : Record) (row : ReadRow) (before : String)
    (held : row ∈ record.reads) (modified : row.other = some before) (found : before ≠ absent)
    (measured : before ≠ nameOnly) (bytes : before ≠ regularOnly) (rewritten : before ≠ row.state)
    (left : measure world.fs (absolute world.root row.path) = row.state) :
    changed ⟨true, u3⟩ world record ≠ none := by
  intro holds
  have each := reads_hold_of_unchanged holds row held
  simp [readHolds, same, modified, found, measured, bytes, left] at each
  exact rewritten each.2.1.symm

/--
**Theorem 5b (`u2`, a removed input).** Under `u2`, a record that holds `[path, left, before]` for a path its
run found does not hold on a file system where the path is gone, whatever the run left there: the run read
what was there, and a tree where nothing is there is not the tree the run read. So a path the run found and
then removed, whose row is `[path, -, before]`, does not hold where it is already gone.
-/
theorem changed_of_removed_left (u3 : Bool) (world : World) (record : Record) (row : ReadRow) (before : String)
    (held : row ∈ record.reads) (modified : row.other = some before) (found : before ≠ absent)
    (gone : measure world.fs (absolute world.root row.path) = absent) :
    changed ⟨true, u3⟩ world record ≠ none := by
  intro holds
  have each := reads_hold_of_unchanged holds row held
  by_cases unseen : before = nameOnly
  · subst unseen
    simp [readHolds, modified, found, namePresent, gone] at each
  · by_cases truncated : before = regularOnly
    · simp [readHolds, modified, truncated, regularOnly, nameOnly, gone, absent, State.render] at each
    · simp [readHolds, same, modified, found, unseen, truncated, gone] at each
      exact found each.2.1.symm

/--
Why `u2` is needed: before it, the same record held on the file system the run left, whatever the run had
found. A run answered from it would be given the results of a run that read other bytes.
-/
theorem legacy_holds_as_left (u3 : Bool) (world : World) (row : ReadRow) (readable : unread row.state = false)
    (left : measure world.fs (absolute world.root row.path) = row.state) :
    changed ⟨false, u3⟩ world { id := "", reads := [row], lists := [] } = none := by
  apply first_eq_none.mpr
  intro verdict among
  simp only [List.mem_cons, List.not_mem_nil, or_false] at among
  rcases among with rfl | rfl | rfl | rfl | rfl | rfl | rfl | rfl
  · simp [servedVerdict]
  · simp [variablesVerdict]
  · apply List.findSome?_eq_none_iff.mpr
    intro other inside
    have same : other = row := by simpa using mem_cheapestFirst.mp inside
    subst same
    simp [readVerdict, absenceHolds, readHolds, same, left, readable]
  · simp [madeVerdict]
  · simp [fromVerdict]
  · simp [givenVerdict]
  · cases u3 <;> simp [linksVerdict]
  · simp [listsVerdict]

/--
**Theorem 6 (`u3`).** Under `u3`, a record that holds `[directory, count, own]` does not hold once the
directory's link count less the directories among `own` is another: a directory made in it or taken out of it
that is not the run's own. The exemption is the one of Theorem 3.
-/
theorem changed_of_links_mutated (u2 : Bool) (world : World) (record : Record) (links : List LinkRow) (row : LinkRow)
    (stored : record.links = some links) (held : row ∈ links) (due : row.path ∉ pending world record)
    (mutated : dirLinks world.fs (absolute world.root row.path) (row.own ++ (row.added.getD []).map (·.1)) ≠
      some row.count) :
    changed ⟨u2, true⟩ world record ≠ none := by
  intro holds
  have quiet := first_eq_none.mp holds (linksVerdict ⟨u2, true⟩ world record) (by simp)
  have each := List.findSome?_eq_none_iff.mp quiet row (by simpa [stored] using held)
  simp [linkVerdict, due, mutated] at each

/-- A record that holds is answered by every program it talked to. -/
theorem changed_of_program_restarted (rules : Rules) (world : World) (record : Record) (label id : String)
    (held : (label, id) ∈ record.served.getD []) (restarted : answeredFrom (world.served label) id ≠ some true) :
    changed rules world record ≠ none := by
  intro holds
  have quiet := first_eq_none.mp holds (servedVerdict world record) (by simp)
  have each := List.findSome?_eq_none_iff.mp quiet (label, id) held
  simp [restarted] at each

end ObservedReadsSpec

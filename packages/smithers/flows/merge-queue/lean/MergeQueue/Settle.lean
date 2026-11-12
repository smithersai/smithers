import MergeQueue.Compact
import MergeQueue.Safety

/-!
# Moving the queue's starting commit forward

The target's tree only grows, and the queue runs for months. Every part that
every run was built on is behind the queue for good: nothing reads it again
except to check that a candidate still extends the target. `State.cut k` drops
the first `k` parts from the target's tree and from every run's base. The
driver cuts the longest prefix every run shares, and tells the repository to
move its starting commit forward by the same parts, so the trees the queue and
the repository speak of stay the same trees.

This file proves that cutting changes nothing the queue does, for a state in
which every run's base starts with the parts being cut (`State.onPrefix`):

* `cut_plan`: the cut state plans the same decision;
* `cut_step`: one event on the cut state gives the cut of that event on the
  full state, once both are pruned;
* `onPrefix_step`: every event keeps every run on the prefix, so the cut stays
  valid for as long as the queue runs.
-/

namespace MergeQueue

/-- A run with the first `k` parts cut from its base. -/
def Run.cut (k : Nat) (r : Run) : Run := { r with base := r.base.drop k }

/-- The state with the first `k` parts cut from the target's tree and from
every run's base. -/
def State.cut (k : Nat) (s : State) : State :=
  { s with main := s.main.drop k, runs := s.runs.map (Run.cut k) }

/-- The target's tree and every run's base start with `p`. -/
def State.onPrefix (p : Tree) (s : State) : Prop :=
  p <+: s.main ∧ ∀ r ∈ s.runs, p <+: r.base

@[simp] theorem Run.cut_id (k : Nat) (r : Run) : (r.cut k).id = r.id := rfl
@[simp] theorem Run.cut_batch (k : Nat) (r : Run) : (r.cut k).batch = r.batch := rfl
@[simp] theorem Run.cut_results (k : Nat) (r : Run) : (r.cut k).results = r.results := rfl
@[simp] theorem Run.cut_pending (cfg : Config) (k : Nat) (r : Run) : (r.cut k).pending cfg = r.pending cfg := rfl

@[simp] theorem State.cut_changes (k : Nat) (s : State) : (s.cut k).changes = s.changes := rfl
@[simp] theorem State.cut_main (k : Nat) (s : State) : (s.cut k).main = s.main.drop k := rfl
@[simp] theorem State.cut_runs (k : Nat) (s : State) : (s.cut k).runs = s.runs.map (Run.cut k) := rfl
@[simp] theorem State.cut_nextRun (k : Nat) (s : State) : (s.cut k).nextRun = s.nextRun := rfl
@[simp] theorem State.cut_nextSeq (k : Nat) (s : State) : (s.cut k).nextSeq = s.nextSeq := rfl
@[simp] theorem State.cut_history (k : Nat) (s : State) : (s.cut k).history = s.history := rfl
@[simp] theorem State.cut_pushing (k : Nat) (s : State) : (s.cut k).pushing = s.pushing := rfl

/-- What a tree adds to the target is what it adds once both lose a shared prefix. -/
theorem strip_drop {p m b batch : Tree} (main : p <+: m) (base : p <+: b) :
    strip (m.drop p.length) (b.drop p.length ++ batch) = strip m (b ++ batch) := by
  obtain ⟨m', rfl⟩ := main
  obtain ⟨b', rfl⟩ := base
  simp only [List.drop_left]
  apply Option.ext
  intro added
  simp only [strip_eq_some, List.append_assoc, List.append_cancel_left_eq]

theorem Run.cut_tree {p : Tree} {r : Run} (base : p <+: r.base) : (r.cut p.length).tree = r.tree.drop p.length := by
  obtain ⟨b', eq⟩ := base
  simp [Run.tree, Run.cut, ← eq]

theorem State.cut_ready (k : Nat) (s : State) : (s.cut k).ready = s.ready := rfl
theorem State.cut_partReady (k : Nat) (s : State) : (s.cut k).partReady = s.partReady := rfl

theorem State.cut_live {p : Tree} {s : State} (on : s.onPrefix p) {r : Run} (member : r ∈ s.runs) :
    (s.cut p.length).live (r.cut p.length) = s.live r := by
  have stripped : strip (s.cut p.length).main (r.cut p.length).tree = strip s.main r.tree :=
    strip_drop on.1 (on.2 r member)
  unfold State.live
  rw [stripped]
  rfl

theorem State.cut_findRun (k : Nat) (s : State) (run : RunId) :
    (s.cut k).findRun run = (s.findRun run).map (Run.cut k) := by
  simp [State.findRun, List.find?_map, Function.comp_def]

theorem State.cut_pendingCount (cfg : Config) (k : Nat) (s : State) : (s.cut k).pendingCount cfg = s.pendingCount cfg := by
  simp [State.pendingCount, List.countP_map, Function.comp_def]

theorem State.findRun_mem {s : State} {run : RunId} {r : Run} (found : s.findRun run = some r) : r ∈ s.runs :=
  List.mem_of_find?_eq_some found

theorem State.cut_pushingRun {p : Tree} {s : State} (on : s.onPrefix p) :
    (s.cut p.length).pushingRun = s.pushingRun.map (Run.cut p.length) := by
  unfold State.pushingRun
  simp only [State.cut_pushing, State.cut_findRun]
  cases s.pushing with
  | none => rfl
  | some id =>
    cases found : s.findRun id with
    | none => simp [found]
    | some r =>
      simp only [found, Option.map_some, State.cut_live on (State.findRun_mem found)]
      cases (s.live r).isSome <;> rfl

theorem State.cut_pushingPart {p : Tree} {s : State} (on : s.onPrefix p) :
    (s.cut p.length).pushingPart = s.pushingPart := by
  funext part
  unfold State.pushingPart
  rw [State.cut_pushingRun on]
  cases s.pushingRun <;> rfl

theorem State.cut_failuresOf (k : Nat) (s : State) : (s.cut k).failuresOf = s.failuresOf := by
  funext c
  unfold State.failuresOf
  cases c.status with
  | fixing run =>
    simp only [State.cut_findRun]
    cases s.findRun run <;> simp
  | _ => rfl

/-! ## List facts for runs that are all cut the same way -/

theorem any_map_congr {f g : Run → Bool} {cut : Run → Run} {l : List Run} (same : ∀ r ∈ l, f (cut r) = g r) :
    (l.map cut).any f = l.any g := by
  induction l with
  | nil => rfl
  | cons a rest ih =>
    simp only [List.map_cons, List.any_cons, same a (by simp), ih fun r member => same r (by simp [member])]

theorem find_map_congr {f g : Run → Bool} {cut : Run → Run} {l : List Run} (same : ∀ r ∈ l, f (cut r) = g r) :
    (l.map cut).find? f = (l.find? g).map cut := by
  induction l with
  | nil => rfl
  | cons a rest ih =>
    simp only [List.map_cons, List.find?_cons, same a (by simp)]
    cases g a
    · exact ih fun r member => same r (by simp [member])
    · rfl

theorem filterMap_map_congr {β : Type} {f g : Run → Option β} {cut : Run → Run} {l : List Run}
    (same : ∀ r ∈ l, f (cut r) = g r) : (l.map cut).filterMap f = l.filterMap g := by
  induction l with
  | nil => rfl
  | cons a rest ih =>
    simp only [List.map_cons, List.filterMap_cons, same a (by simp), ih fun r member => same r (by simp [member])]

/-! ## The policy on the cut state -/

/-- Two trees on the cut state are equal exactly when the full trees are. -/
theorem State.cut_treeEq {p : Tree} {s : State} (on : s.onPrefix p) {r : Run} (member : r ∈ s.runs)
    (batch : List Part) :
    ((r.cut p.length).tree == (s.cut p.length).main ++ batch) = (r.tree == s.main ++ batch) := by
  obtain ⟨m', main⟩ := on.1
  obtain ⟨b', base⟩ := on.2 r member
  apply Bool.eq_iff_iff.mpr
  simp only [beq_iff_eq, Run.tree, Run.cut, State.cut_main, ← main, ← base, List.drop_left, List.append_assoc,
    List.append_cancel_left_eq]

theorem State.cut_landable {p : Tree} {s : State} (on : s.onPrefix p) (cfg : Config) {r : Run} (member : r ∈ s.runs) :
    (s.cut p.length).landable cfg (r.cut p.length) = s.landable cfg r := by
  simp [State.landable, State.cut_live on member]

theorem State.cut_blameable {p : Tree} {s : State} (on : s.onPrefix p) {r : Run} (member : r ∈ s.runs) :
    (s.cut p.length).blameable (r.cut p.length) = s.blameable r := by
  simp [State.blameable, State.cut_live on member]

theorem State.cut_evidence (k : Nat) (s : State) (r : Run) : (s.cut k).evidence (r.cut k) = s.evidence r := rfl

theorem State.cut_prefixLength {p : Tree} {s : State} (on : s.onPrefix p) {r : Run} (member : r ∈ s.runs) :
    (s.cut p.length).prefixLength (r.cut p.length) = s.prefixLength r := by
  simp [State.prefixLength, State.cut_live on member, State.cut_ready]

theorem State.cut_failedPrefixes {p : Tree} {s : State} (on : s.onPrefix p) :
    (s.cut p.length).failedPrefixes = s.failedPrefixes := by
  unfold State.failedPrefixes
  exact filterMap_map_congr fun r member => by
    simp only [State.cut_prefixLength on member, Run.cut_results]
    rfl

theorem State.cut_unfailedPrefixes {p : Tree} {s : State} (on : s.onPrefix p) (bound : Nat) :
    (s.cut p.length).unfailedPrefixes bound = s.unfailedPrefixes bound := by
  unfold State.unfailedPrefixes
  exact filterMap_map_congr fun r member => by
    simp only [State.cut_prefixLength on member, Run.cut_results]
    rfl

theorem State.cut_shortestFailed {p : Tree} {s : State} (on : s.onPrefix p) :
    (s.cut p.length).shortestFailed = s.shortestFailed := by
  simp [State.shortestFailed, State.cut_failedPrefixes on]

theorem State.cut_longestUnfailed {p : Tree} {s : State} (on : s.onPrefix p) (bound : Nat) :
    (s.cut p.length).longestUnfailed bound = s.longestUnfailed bound := by
  simp [State.longestUnfailed, State.cut_unfailedPrefixes on]

theorem State.cut_doomed {p : Tree} {s : State} (on : s.onPrefix p) {r : Run} (member : r ∈ s.runs) :
    (s.cut p.length).doomed (r.cut p.length) = s.doomed r := by
  simp [State.doomed, State.cut_live on member, State.cut_prefixLength on member, State.cut_shortestFailed on]

theorem State.cut_outOfOrder {p : Tree} {s : State} (on : s.onPrefix p) (cfg : Config) :
    (s.cut p.length).outOfOrder cfg = s.outOfOrder cfg := by
  unfold State.outOfOrder
  exact any_map_congr fun r member => by simp [State.cut_live on member, State.cut_prefixLength on member]

theorem State.cut_nextStart {p : Tree} {s : State} (on : s.onPrefix p) (cfg : Config) :
    (s.cut p.length).nextStart cfg = s.nextStart cfg := by
  simp [State.nextStart, State.cut_pendingCount, State.cut_outOfOrder on, State.cut_ready,
    State.cut_shortestFailed on, State.cut_longestUnfailed on]

theorem State.cut_nextProbe {p : Tree} {s : State} (on : s.onPrefix p) (cfg : Config) :
    (s.cut p.length).nextProbe cfg = s.nextProbe cfg := by
  unfold State.nextProbe
  have tested : ∀ c : Change, (s.cut p.length).runs.any (fun r => r.tree == (s.cut p.length).main ++ [c.part])
      = s.runs.any (fun r => r.tree == s.main ++ [c.part]) :=
    fun c => any_map_congr fun r member => State.cut_treeEq on member [c.part]
  simp only [State.cut_pendingCount, State.cut_ready, tested]

theorem State.cut_useless {p : Tree} {s : State} (on : s.onPrefix p) {r : Run} (member : r ∈ s.runs) :
    (s.cut p.length).useless (r.cut p.length) = s.useless r := by
  simp [State.useless, State.cut_live on member, State.cut_evidence, State.cut_doomed on member]

theorem Run.cut_tree_length {p : Tree} {r : Run} (base : p <+: r.base) :
    (r.cut p.length).tree.length + p.length = r.tree.length := by
  obtain ⟨b', eq⟩ := base
  simp [Run.tree, Run.cut, ← eq]
  omega

theorem State.cut_bestLandable_fold {p : Tree} {s : State} (on : s.onPrefix p) (cfg : Config) (l : List Run)
    (members : ∀ r ∈ l, r ∈ s.runs) (best : Option Run) (prefixed : ∀ b, best = some b → p <+: b.base) :
    (l.map (Run.cut p.length)).foldl
        (fun best r =>
          if (s.cut p.length).landable cfg r then
            match best with
            | some b => if b.tree.length < r.tree.length then some r else best
            | none => some r
          else best)
        (best.map (Run.cut p.length))
      = (l.foldl
          (fun best r =>
            if s.landable cfg r then
              match best with
              | some b => if b.tree.length < r.tree.length then some r else best
              | none => some r
            else best)
          best).map (Run.cut p.length) := by
  induction l generalizing best with
  | nil => rfl
  | cons a rest ih =>
    have member := members a (by simp)
    have later := fun next ok => ih (fun r h => members r (by simp [h])) next ok
    simp only [List.map_cons, List.foldl_cons, State.cut_landable on cfg member]
    cases landable : s.landable cfg a
    · simpa using later best prefixed
    · cases best with
      | none =>
        simpa using later (some a) (fun b eq => by cases eq; exact on.2 a member)
      | some b =>
        have lengthA := Run.cut_tree_length (on.2 a member)
        have lengthB := Run.cut_tree_length (prefixed b rfl)
        by_cases longer : b.tree.length < a.tree.length
        · have cutLonger : (b.cut p.length).tree.length < (a.cut p.length).tree.length := by omega
          simpa [longer, cutLonger] using later (some a) (fun b eq => by cases eq; exact on.2 a member)
        · have cutLonger : ¬ (b.cut p.length).tree.length < (a.cut p.length).tree.length := by omega
          simpa [longer, cutLonger] using later (some b) prefixed

theorem State.cut_bestLandable {p : Tree} {s : State} (on : s.onPrefix p) (cfg : Config) :
    (s.cut p.length).bestLandable cfg = (s.bestLandable cfg).map (Run.cut p.length) :=
  State.cut_bestLandable_fold on cfg s.runs (fun _ h => h) none (fun _ h => by cases h)

theorem State.cut_nextPush {p : Tree} {s : State} (on : s.onPrefix p) (cfg : Config) :
    (s.cut p.length).nextPush cfg = (s.nextPush cfg).map (Run.cut p.length) := by
  unfold State.nextPush
  rw [State.cut_pushingRun on, State.cut_bestLandable on]
  cases s.pushingRun <;> simp

/-- **The cut state plans the same decision.** -/
theorem cut_plan {p : Tree} {s : State} (on : s.onPrefix p) (cfg : Config) : plan cfg (s.cut p.length) = plan cfg s := by
  have blamed : (s.cut p.length).runs.find? (s.cut p.length).blameable
      = (s.runs.find? s.blameable).map (Run.cut p.length) :=
    find_map_congr fun r member => State.cut_blameable on member
  have forgotten : (s.cut p.length).runs.find? (s.cut p.length).useless
      = (s.runs.find? s.useless).map (Run.cut p.length) :=
    find_map_congr fun r member => State.cut_useless on member
  unfold plan
  rw [State.cut_nextPush on, blamed, forgotten, State.cut_nextStart on, State.cut_nextProbe on]
  cases s.nextPush cfg with
  | some r => rfl
  | none =>
    cases s.runs.find? s.blameable with
    | some r => rfl
    | none =>
      cases s.runs.find? s.useless with
      | some r => rfl
      | none => rfl

/-! ## Events on the cut state -/

theorem State.cut_enqueue (k : Nat) (s : State) (id : ChangeId) (priority : Nat) :
    (s.cut k).enqueue id priority = (s.enqueue id priority).cut k := by
  unfold State.enqueue
  simp only [State.cut_changes, State.cut_nextSeq]
  split <;> rfl

theorem State.cut_withdraw {p : Tree} {s : State} (on : s.onPrefix p) (id : ChangeId) :
    (s.cut p.length).withdraw id = (s.withdraw id).cut p.length := by
  unfold State.withdraw
  rw [State.cut_pushingPart on]
  simp only [State.cut_changes]
  split <;> rfl

theorem State.cut_result (cfg : Config) (k : Nat) (s : State) (run : RunId) (check : CheckId) (verdict : Verdict)
    (duration : Nat) :
    (s.cut k).result cfg run check verdict duration = (s.result cfg run check verdict duration).cut k := by
  unfold State.result
  have known : (s.cut k).runs.any (fun r => r.id == run && !answered r.results check)
      = s.runs.any (fun r => r.id == run && !answered r.results check) :=
    any_map_congr fun _ _ => rfl
  rw [known]
  split
  · simp only [State.cut, List.map_map]
    congr 1
    apply List.map_congr_left
    intro r _
    simp only [Function.comp_apply, Run.cut]
    split <;> rfl
  · rfl

theorem State.cut_fixed (k : Nat) (s : State) (id : ChangeId) (attempt : Nat) :
    (s.cut k).fixed id attempt = (s.fixed id attempt).cut k := by
  unfold State.fixed
  simp only [State.cut_changes]
  split <;> rfl

theorem State.cut_gaveUp (k : Nat) (s : State) (id : ChangeId) (attempt : Nat) (detail : String) :
    (s.cut k).gaveUp id attempt detail = (s.gaveUp id attempt detail).cut k := by
  unfold State.gaveUp
  rw [State.cut_failuresOf]
  rfl

theorem State.cut_cancel (k : Nat) (s : State) (run : RunId) : (s.cut k).cancel run = (s.cancel run).cut k := by
  simp [State.cancel, State.cut, List.filter_map, Function.comp_def]

/-- Pruned states are equal when everything but the landings is. -/
theorem State.pruned_eq_of {s t : State} (main : s.main = t.main) (changes : s.changes = t.changes)
    (runs : s.runs = t.runs) (nextRun : s.nextRun = t.nextRun) (nextSeq : s.nextSeq = t.nextSeq)
    (history : s.history = t.history) (pushing : s.pushing = t.pushing) : s.pruned = t.pruned :=
  State.pruned_congr main runs nextRun nextSeq history pushing (by rw [changes])

theorem drop_append_prefix {p m : Tree} (main : p <+: m) (added : Tree) :
    m.drop p.length ++ added = (m ++ added).drop p.length := by
  obtain ⟨m', rfl⟩ := main
  simp

theorem State.cut_foreign {p : Tree} {s : State} (on : s.onPrefix p) (id : ChangeId) :
    ((s.cut p.length).foreign id).pruned = ((s.foreign id).cut p.length).pruned := by
  unfold State.foreign
  simp only [State.cut_changes]
  split
  · rfl
  · apply State.pruned_eq_of <;> first | rfl | exact drop_append_prefix on.1 _

theorem State.cut_start {p : Tree} {s : State} (on : s.onPrefix p) (cfg : Config) (count : Nat) :
    (s.cut p.length).start cfg count = (s.start cfg count).cut p.length := by
  unfold State.start
  have tested : (s.cut p.length).runs.any
        (fun r => r.tree == (s.cut p.length).main ++ (s.ready.take count).map Change.part)
      = s.runs.any (fun r => r.tree == s.main ++ (s.ready.take count).map Change.part) :=
    any_map_congr fun r member => State.cut_treeEq on member _
  simp only [State.cut_ready, State.cut_pendingCount]
  rw [tested, apply_ite (State.cut p.length)]
  congr 1
  simp [State.cut, Run.cut]

theorem State.cut_probe {p : Tree} {s : State} (on : s.onPrefix p) (cfg : Config) (id : ChangeId) :
    (s.cut p.length).probe cfg id = (s.probe cfg id).cut p.length := by
  unfold State.probe
  simp only [State.cut_changes]
  cases s.changes.find? (fun c => c.id == id && c.status.isQueued) with
  | none => rfl
  | some c =>
    have tested : (s.cut p.length).runs.any (fun r => r.tree == (s.cut p.length).main ++ [c.part])
        = s.runs.any (fun r => r.tree == s.main ++ [c.part]) :=
      any_map_congr fun r member => State.cut_treeEq on member _
    simp only [State.cut_pendingCount]
    rw [tested, apply_ite (State.cut p.length)]
    congr 1
    simp [State.cut, Run.cut]

theorem State.cut_push {p : Tree} {s : State} (on : s.onPrefix p) (cfg : Config) (run : RunId) :
    (s.cut p.length).push cfg run = (s.push cfg run).cut p.length := by
  unfold State.push
  rw [State.cut_pushingRun on, State.cut_findRun]
  cases s.pushingRun with
  | some _ => rfl
  | none =>
    cases found : s.findRun run with
    | none => rfl
    | some r =>
      simp only [Option.map_none, Option.map_some, State.cut_live on (State.findRun_mem found), Run.cut_results]
      split <;> rfl

theorem State.cut_landNow {p : Tree} {s : State} (on : s.onPrefix p) (cfg : Config) (run : RunId) :
    ((s.cut p.length).landNow cfg run).pruned = ((s.landNow cfg run).cut p.length).pruned := by
  unfold State.landNow
  rw [State.cut_findRun]
  cases found : s.findRun run with
  | none => rfl
  | some r =>
    have member := State.findRun_mem found
    simp only [Option.map_some, State.cut_live on member, Run.cut_results]
    cases s.live r with
    | none => rfl
    | some batch =>
      simp only
      split
      · apply State.pruned_eq_of <;> first | rfl | skip
        · exact Run.cut_tree (on.2 r member)
        · simp [State.cut, List.filter_map, Function.comp_def]
      · rfl

theorem State.cut_land {p : Tree} {s : State} (on : s.onPrefix p) (cfg : Config) (run : RunId) :
    ((s.cut p.length).land cfg run).pruned = ((s.land cfg run).cut p.length).pruned := by
  unfold State.land
  simp only [State.cut_pushing]
  split
  · exact State.cut_landNow on cfg run
  · rfl

theorem State.cut_blame {p : Tree} {s : State} (on : s.onPrefix p) (cfg : Config) (run : RunId) :
    (s.cut p.length).blame cfg run = (s.blame cfg run).cut p.length := by
  unfold State.blame
  rw [State.cut_findRun]
  cases found : s.findRun run with
  | none => rfl
  | some r =>
    simp only [Option.map_some, State.cut_live on (State.findRun_mem found), Run.cut_results]
    split
    · split <;> rfl
    · rfl

/-- **One event on the cut state is the cut of that event on the full state**,
once both are pruned (a landing records the tree before it, which the cut
shortens; the pruned state holds no landing). -/
theorem cut_step {p : Tree} {s : State} (on : s.onPrefix p) (cfg : Config) (e : Event) :
    (step cfg (s.cut p.length) e).pruned = ((step cfg s e).cut p.length).pruned := by
  cases e with
  | enqueue id priority => exact congrArg State.pruned (State.cut_enqueue p.length s id priority)
  | withdraw id => exact congrArg State.pruned (State.cut_withdraw on id)
  | result run check verdict duration =>
    exact congrArg State.pruned (State.cut_result cfg p.length s run check verdict duration)
  | fixed id attempt => exact congrArg State.pruned (State.cut_fixed p.length s id attempt)
  | gaveUp id attempt detail => exact congrArg State.pruned (State.cut_gaveUp p.length s id attempt detail)
  | foreign id => exact State.cut_foreign on id
  | land run => exact State.cut_land on cfg run
  | start count => exact congrArg State.pruned (State.cut_start on cfg count)
  | probe id => exact congrArg State.pruned (State.cut_probe on cfg id)
  | push run => exact congrArg State.pruned (State.cut_push on cfg run)
  | blame run => exact congrArg State.pruned (State.cut_blame on cfg run)
  | cancel run => exact congrArg State.pruned (State.cut_cancel p.length s run)

/-! ## The cut stays valid -/

/-- A state keeps its prefix when its target's tree extends the old one and
each of its runs has the base of an old run or starts on the old target. -/
theorem State.onPrefix_of {p : Tree} {s t : State} (on : s.onPrefix p) (main : s.main <+: t.main)
    (runs : ∀ r ∈ t.runs, (∃ old ∈ s.runs, r.base = old.base) ∨ r.base = s.main) : t.onPrefix p := by
  refine ⟨List.IsPrefix.trans on.1 main, ?_⟩
  intro r member
  rcases runs r member with ⟨old, held, same⟩ | same
  · rw [same]; exact on.2 old held
  · rw [same]; exact on.1

/-- After an event, every run has the base of a run the queue held before, or
starts on the target as it was. -/
theorem step_run_bases (cfg : Config) (s : State) (e : Event) :
    ∀ r ∈ (step cfg s e).runs, (∃ old ∈ s.runs, r.base = old.base) ∨ r.base = s.main := by
  intro r member
  cases e with
  | enqueue id priority =>
    rcases s.enqueue_cases id priority with same | ⟨_, eq⟩
    · exact Or.inl ⟨r, by simpa [step, same] using member, rfl⟩
    · exact Or.inl ⟨r, by simpa [step, eq] using member, rfl⟩
  | withdraw id =>
    refine Or.inl ⟨r, ?_, rfl⟩
    simp only [step, State.withdraw] at member
    split at member <;> simpa [State.withdrawNow] using member
  | result run check verdict duration =>
    simp only [step, State.result] at member
    split at member
    · obtain ⟨old, held, eq⟩ := List.mem_map.mp member
      refine Or.inl ⟨old, held, ?_⟩
      rw [← eq]
      split <;> rfl
    · exact Or.inl ⟨r, member, rfl⟩
  | fixed id attempt =>
    refine Or.inl ⟨r, ?_, rfl⟩
    simp only [step, State.fixed] at member
    split at member <;> simpa [State.fixedNow] using member
  | gaveUp id attempt detail => exact Or.inl ⟨r, by simpa [step, State.gaveUp] using member, rfl⟩
  | foreign id =>
    refine Or.inl ⟨r, ?_, rfl⟩
    simp only [step, State.foreign] at member
    split at member <;> simpa using member
  | land run =>
    refine Or.inl ⟨r, ?_, rfl⟩
    rcases s.land_cases cfg run with same | ⟨_, eq⟩
    · simpa [step, same] using member
    · simp only [step, eq] at member
      rcases s.landNow_cases cfg run with same | ⟨found, batch, _, _, _, landed⟩
      · simpa [same] using member
      · rw [landed] at member
        exact (List.mem_filter.mp member).1
  | start count =>
    rcases s.start_cases cfg count with same | ⟨_, _, _, _, took⟩
    · exact Or.inl ⟨r, by simpa [step, same] using member, rfl⟩
    · simp only [step, took, List.mem_append, List.mem_singleton] at member
      rcases member with held | rfl
      · exact Or.inl ⟨r, held, rfl⟩
      · exact Or.inr rfl
  | probe id =>
    simp only [step, State.probe] at member
    split at member
    · exact Or.inl ⟨r, member, rfl⟩
    · split at member
      · exact Or.inl ⟨r, member, rfl⟩
      · simp only [List.mem_append, List.mem_singleton] at member
        rcases member with held | rfl
        · exact Or.inl ⟨r, held, rfl⟩
        · exact Or.inr rfl
  | push run =>
    refine Or.inl ⟨r, ?_, rfl⟩
    simp only [step, State.push] at member
    repeat' split at member
    all_goals simpa using member
  | blame run =>
    refine Or.inl ⟨r, ?_, rfl⟩
    simp only [step, State.blame] at member
    repeat' split at member
    all_goals simpa using member
  | cancel run =>
    refine Or.inl ⟨r, ?_, rfl⟩
    simp only [step, State.cancel] at member
    exact (List.mem_filter.mp member).1

/-- **Every event keeps the target and every run on the prefix**, so a cut
that was valid stays valid for as long as the queue runs. -/
theorem onPrefix_step {p : Tree} {s : State} (on : s.onPrefix p) (cfg : Config) (e : Event) :
    (step cfg s e).onPrefix p := by
  obtain ⟨added, grows⟩ := main_only_grows cfg s e
  exact State.onPrefix_of on (by rw [grows]; exact List.prefix_append _ _) (step_run_bases cfg s e)

/-- **Every run was started on the target**: in every reachable state a run's
base is a prefix of the target's tree. -/
theorem Reachable.bases {cfg : Config} {s : State} (reach : Reachable cfg s) : ∀ r ∈ s.runs, r.base <+: s.main := by
  induction reach with
  | empty => intro r member; simp [State.empty] at member
  | @step before e _ ih =>
    obtain ⟨added, grows⟩ := main_only_grows cfg before e
    intro r member
    rw [grows]
    rcases step_run_bases cfg before e r member with ⟨old, held, same⟩ | same
    · rw [same]; exact List.IsPrefix.trans (ih old held) (List.prefix_append _ _)
    · rw [same]; exact List.prefix_append _ _

/-! ## How much the driver cuts -/

/-- The parts of the target's tree that every run was built on: the length of
the shortest base, and the whole tree when the queue holds no run. -/
def State.settled (s : State) : Nat :=
  s.runs.foldl (fun k r => min k r.base.length) s.main.length

theorem foldl_min_le (l : List Run) (start : Nat) :
    l.foldl (fun k r => min k r.base.length) start ≤ start
      ∧ ∀ r ∈ l, l.foldl (fun k r => min k r.base.length) start ≤ r.base.length := by
  induction l generalizing start with
  | nil => exact ⟨Nat.le_refl _, fun _ member => by simp at member⟩
  | cons a rest ih =>
    have later := ih (min start a.base.length)
    refine ⟨Nat.le_trans later.1 (Nat.min_le_left _ _), ?_⟩
    intro r member
    rcases List.mem_cons.mp member with rfl | held
    · exact Nat.le_trans later.1 (Nat.min_le_right _ _)
    · exact later.2 r held

theorem State.settled_le_main (s : State) : s.settled ≤ s.main.length := (foldl_min_le s.runs s.main.length).1

theorem State.settled_le_base (s : State) : ∀ r ∈ s.runs, s.settled ≤ r.base.length :=
  (foldl_min_le s.runs s.main.length).2

/-- **Any number of parts every run was built on can be cut**: in a reachable
state they are a prefix of the target's tree and of every run's base. -/
theorem onPrefix_take {cfg : Config} {s : State} (reach : Reachable cfg s) {k : Nat} (main : k ≤ s.main.length)
    (runs : ∀ r ∈ s.runs, k ≤ r.base.length) : s.onPrefix (s.main.take k) ∧ (s.main.take k).length = k := by
  have length : (s.main.take k).length = k := by simp [List.length_take, Nat.min_eq_left main]
  refine ⟨⟨List.take_prefix _ _, ?_⟩, length⟩
  intro r member
  exact List.prefix_of_prefix_length_le (List.take_prefix _ _) (reach.bases r member) (by rw [length]; exact runs r member)

/-- **What the driver cuts is always valid**: the settled parts of a reachable
state are a prefix of its target's tree and of every run's base. -/
theorem settled_onPrefix {cfg : Config} {s : State} (reach : Reachable cfg s) :
    s.onPrefix (s.main.take s.settled) ∧ (s.main.take s.settled).length = s.settled :=
  onPrefix_take reach s.settled_le_main s.settled_le_base

/-- **Cutting again adds up.** After `a` valid parts are cut, the settled parts
of what is left are valid to cut from the full state on top of `a`. -/
theorem settled_after_cut {s : State} {a : Nat} (main : a ≤ s.main.length) (runs : ∀ r ∈ s.runs, a ≤ r.base.length) :
    a + (s.cut a).settled ≤ s.main.length ∧ ∀ r ∈ s.runs, a + (s.cut a).settled ≤ r.base.length := by
  have left := (s.cut a).settled_le_main
  simp only [State.cut_main, List.length_drop] at left
  refine ⟨by omega, ?_⟩
  intro r member
  have base := (s.cut a).settled_le_base (r.cut a) (List.mem_map.mpr ⟨r, member, rfl⟩)
  simp only [Run.cut, List.length_drop] at base
  have enough := runs r member
  omega

/-! ## What the driver carries: cut, then pruned -/

/-- What the queue keeps of a state whose first `p.length` parts are settled. -/
def State.kept (k : Nat) (s : State) : State := (s.cut k).pruned

theorem State.cut_cut (a b : Nat) (s : State) : (s.cut a).cut b = s.cut (a + b) := by
  simp [State.cut, Run.cut, List.drop_drop, Function.comp_def]

theorem State.cut_pruned (k : Nat) (s : State) : (s.cut k).pruned = s.pruned.cut k := rfl

/-- **The kept state plans the same decision.** -/
theorem kept_plan {p : Tree} {s : State} (on : s.onPrefix p) (cfg : Config) :
    plan cfg (s.kept p.length) = plan cfg s := by
  rw [State.kept, pruned_plan, cut_plan on]

/-- **One event on the kept state is what is kept of that event on the full
state.** -/
theorem kept_step {p : Tree} {s : State} (on : s.onPrefix p) (cfg : Config) (e : Event)
    (ids : (s.changes.map (·.id)).Nodup) (fresh : e.fresh s = true) :
    (step cfg (s.kept p.length) e).pruned = (step cfg s e).kept p.length := by
  have freshCut : e.fresh (s.cut p.length) = true := by cases e <;> exact fresh
  rw [State.kept, pruned_step cfg (s.cut p.length) e ids freshCut, cut_step on]
  rfl

/-- **A whole round on the kept state is what is kept of that round on the
full state**: fold the events the world reported, pruning after each, then
let the policy settle. -/
theorem kept_round {p : Tree} (cfg : Config) (fuel : Nat) {s : State} (reach : Reachable cfg s)
    (on : s.onPrefix p) (events : List Event) (fresh : freshTrace cfg s events) :
    settlePruned cfg fuel (runPruned cfg (s.kept p.length) events)
      = (settle cfg fuel (run cfg s events)).kept p.length := by
  have folded : ∀ (events : List Event) (s : State), Reachable cfg s → s.onPrefix p → freshTrace cfg s events →
      runPruned cfg (s.kept p.length) events = (run cfg s events).kept p.length
        ∧ Reachable cfg (run cfg s events) ∧ (run cfg s events).onPrefix p := by
    intro events
    induction events with
    | nil => intro s reach on _; exact ⟨rfl, reach, on⟩
    | cons e rest ih =>
      intro s reach on fresh
      have here := kept_step on cfg e reach.inv.changeIds fresh.1
      have later := ih (step cfg s e) (Reachable.step e reach) (onPrefix_step on cfg e) fresh.2
      refine ⟨?_, later.2⟩
      simpa [runPruned, run, here] using later.1
  have settled : ∀ (fuel : Nat) (s : State), Reachable cfg s → s.onPrefix p →
      settlePruned cfg fuel (s.kept p.length) = (settle cfg fuel s).kept p.length := by
    intro fuel
    induction fuel with
    | zero => intro s _ _; rfl
    | succ fuel ih =>
      intro s reach on
      simp only [settlePruned, settle, kept_plan on]
      cases planned : plan cfg s with
      | none => rfl
      | some e =>
        have here := kept_step on cfg e reach.inv.changeIds (plan_fresh planned)
        simpa [here] using ih (step cfg s e) (Reachable.step e reach) (onPrefix_step on cfg e)
  obtain ⟨same, reached, still⟩ := folded events s reach on fresh
  rw [same]
  exact settled fuel _ reached still

end MergeQueue

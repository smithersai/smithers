import PatternsSpec.Saga
import PatternsSpec.Bounded
import PatternsSpec.Quarantine
import PatternsSpec.ReviewLoop
import PatternsSpec.Escalation
import PatternsSpec.Intervene

/-!
# Machine-checked laws of the patterns

Every theorem here is proved in full from the definitions of the specification and rests on nothing but Lean's own
foundations.
-/

namespace PatternsSpec

/-! ## Saga: the unwind is the committed prefix, reversed, each step once -/

namespace Saga

theorem nodup_reverse {α : Type} {items : List α} (h : items.Nodup) : items.reverse.Nodup := by
  unfold List.Nodup at h ⊢
  rw [List.pairwise_reverse]
  exact h.imp (fun differs => differs.symm)

/-- The committed steps are a prefix of the declared steps: no step commits past a step that did not. -/
theorem forward_committed_prefix : ∀ (steps : List Step), (forward steps).committed <+: steps
  | [] => by simp [forward]
  | step :: rest => by
    obtain ⟨tail, h⟩ := forward_committed_prefix rest
    unfold forward
    split
    · exact ⟨tail, by simp [h]⟩
    · exact List.nil_prefix
    · exact List.nil_prefix
    · by_cases sealed : step.sealed
      · exact ⟨rest, by simp [sealed]⟩
      · simp [sealed]

/-- Every step whose action succeeded before the chain ended is committed. -/
theorem forward_commits_finished : ∀ (steps : List Step),
    steps.takeWhile (fun step => step.action == .ok) <+: (forward steps).committed
  | [] => by simp [forward]
  | step :: rest => by
    obtain ⟨tail, h⟩ := forward_commits_finished rest
    unfold forward
    split
    · rename_i ok
      exact ⟨tail, by simp [ok, h]⟩
    all_goals
      rename_i other
      simp [other]

/-- The actions run in declaration order and stop at the step that ends the chain. -/
theorem forward_started_prefix : ∀ (steps : List Step), (forward steps).started <+: steps.map (·.id)
  | [] => by simp [forward]
  | step :: rest => by
    obtain ⟨tail, h⟩ := forward_started_prefix rest
    unfold forward
    split
    · exact ⟨tail, by simp [h]⟩
    all_goals exact ⟨rest.map (·.id), by simp⟩

/-- A chain that finished committed every step. -/
theorem forward_finished : ∀ (steps : List Step), (forward steps).stop = .finished → (forward steps).committed = steps
  | [], _ => by simp [forward]
  | step :: rest, h => by
    unfold forward at h ⊢
    split at h
    · simp only at h ⊢
      rw [forward_finished rest h]
    all_goals simp at h

/-- A saga that was not refused has distinct step ids and at least one step. -/
theorem run_accepted {policy : Policy} {steps : List Step} (h : ∀ reason, (run policy steps).outcome ≠ .refused reason) :
    steps ≠ [] ∧ (steps.map (·.id)).Nodup := by
  unfold run at h
  by_cases empty : steps = []
  · simp [empty] at h
  · by_cases distinct : (steps.map (·.id)).Nodup
    · exact ⟨empty, distinct⟩
    · simp [empty, distinct] at h

theorem run_of_accepted {policy : Policy} {steps : List Step} (nonempty : steps ≠ [])
    (distinct : (steps.map (·.id)).Nodup) :
    run policy steps =
      { started := (forward steps).started
        unwound := (unwinding policy (forward steps)).map (·.id)
        outcome := settle policy (forward steps) } := by
  simp [run, nonempty, distinct]

/--
**Reverse-prefix compensation.** When the chain does not finish and the policy compensates, the compensations run
are exactly those of the committed prefix of the declared steps, last first.
-/
theorem run_unwinds_reverse_prefix {policy : Policy} {steps : List Step} (nonempty : steps ≠ [])
    (distinct : (steps.map (·.id)).Nodup) (stopped : (forward steps).stop ≠ .finished) (compensates : policy ≠ .fail) :
    ∃ committed rest, steps = committed ++ rest ∧ (forward steps).committed = committed ∧
      (run policy steps).unwound = (committed.map (·.id)).reverse := by
  obtain ⟨rest, h⟩ := forward_committed_prefix steps
  refine ⟨(forward steps).committed, rest, h.symm, rfl, ?_⟩
  rw [run_of_accepted nonempty distinct]
  simp [unwinding, stopped, compensates, List.map_reverse]

/-- **Exactly once.** No compensation runs twice. -/
theorem run_unwound_nodup (policy : Policy) (steps : List Step) : (run policy steps).unwound.Nodup := by
  unfold run
  by_cases empty : steps = []
  · simp [empty]
  · by_cases distinct : (steps.map (·.id)).Nodup
    · simp only [empty, distinct, not_true_eq_false, if_false]
      unfold unwinding
      split
      · simp
      · rw [List.map_reverse]
        exact nodup_reverse (distinct.sublist ((forward_committed_prefix steps).sublist.map _))
    · simp [empty, distinct]

/-- **Exactly once.** Every compensation that runs, runs once. -/
theorem run_unwound_once {policy : Policy} {steps : List Step} {id : Text} (h : id ∈ (run policy steps).unwound) :
    (run policy steps).unwound.count id = 1 := by
  rw [(run_unwound_nodup policy steps).count]
  simp [h]

/-- Only a declared step is compensated. -/
theorem run_unwound_started {policy : Policy} {steps : List Step} {id : Text}
    (h : id ∈ (run policy steps).unwound) : id ∈ steps.map (·.id) := by
  unfold run at h
  by_cases empty : steps = []
  · simp [empty] at h
  · by_cases distinct : (steps.map (·.id)).Nodup
    · simp only [empty, distinct, not_true_eq_false, if_false] at h
      unfold unwinding at h
      split at h
      · simp at h
      · rw [List.map_reverse, List.mem_reverse] at h
        exact ((forward_committed_prefix steps).sublist.map _).subset h
    · simp [empty, distinct] at h

/-- A saga that completed compensated nothing, and holds every step's value in order. -/
theorem run_completed {policy : Policy} {steps : List Step} {values : List Text}
    (h : (run policy steps).outcome = .completed values) :
    (run policy steps).unwound = [] ∧ values = steps.map (·.id) := by
  have accepted := run_accepted (policy := policy) (steps := steps) (by intro reason; rw [h]; simp)
  rw [run_of_accepted accepted.1 accepted.2] at h ⊢
  simp only at h ⊢
  have finished : (forward steps).stop = .finished := by
    cases stop : (forward steps).stop with
    | finished => rfl
    | interrupted => simp [settle, stop] at h
    | failed id =>
      simp only [settle, stop] at h
      split at h
      · simp at h
      · split at h <;> simp at h
    | died id =>
      simp only [settle, stop] at h
      split at h <;> simp at h
  simp only [settle, finished] at h
  rw [forward_finished steps finished] at h
  exact ⟨by simp [unwinding, finished], (Outcome.completed.inj h).symm⟩

/-- Under `fail` no compensation ever runs. -/
theorem run_fail_unwinds_nothing (steps : List Step) : (run .fail steps).unwound = [] := by
  unfold run
  by_cases empty : steps = []
  · simp [empty]
  · by_cases distinct : (steps.map (·.id)).Nodup <;> simp [empty, distinct, unwinding]

/-- The residue names only compensated steps. -/
theorem residue_subset {unwound : List Step} {id : Text} (h : id ∈ residue unwound) : id ∈ unwound.map (·.id) := by
  unfold residue at h
  rw [mem_sortTexts, List.mem_map] at h
  obtain ⟨step, member, rfl⟩ := h
  exact List.mem_map.mpr ⟨step, (List.mem_filter.mp member).1, rfl⟩

/-- A compensated step is in the residue exactly when its compensation did not undo it. -/
theorem mem_residue {unwound : List Step} {id : Text} :
    id ∈ residue unwound ↔ ∃ step ∈ unwound, step.undo ≠ .ok ∧ step.id = id := by
  unfold residue
  rw [mem_sortTexts, List.mem_map]
  constructor
  · rintro ⟨step, member, rfl⟩
    have ⟨inside, dirty⟩ := List.mem_filter.mp member
    exact ⟨step, inside, by simpa using dirty, rfl⟩
  · rintro ⟨step, inside, dirty, rfl⟩
    exact ⟨step, List.mem_filter.mpr ⟨inside, by simpa using dirty⟩, rfl⟩

theorem residue_eq_nil {unwound : List Step} (h : residue unwound = []) : ∀ step ∈ unwound, step.undo = .ok := by
  intro step inside
  apply Classical.byContradiction
  intro dirty
  have member : step.id ∈ residue unwound := mem_residue.mpr ⟨step, inside, dirty, rfl⟩
  rw [h] at member
  simp at member

/-- **A clean unwind only.** `Compensated` is returned only under `compensate` and only when every compensation undid its step. -/
theorem settle_compensated {policy : Policy} {chain : Forward} {failure : Text}
    (h : settle policy chain = .compensated failure) :
    policy = .compensate ∧ chain.stop = .failed failure ∧ ∀ step ∈ unwinding policy chain, step.undo = .ok := by
  cases stop : chain.stop with
  | finished => simp [settle, stop] at h
  | interrupted => simp [settle, stop] at h
  | died id =>
    simp only [settle, stop] at h
    split at h <;> simp at h
  | failed id =>
    simp only [settle, stop] at h
    split at h
    · simp at h
    · rename_i clean
      split at h
      · rename_i compensate
        exact ⟨compensate, by rw [Outcome.compensated.inj h], residue_eq_nil (Classical.not_not.mp clean)⟩
      · simp at h

/-- **Dirty state outranks the trigger.** A failed chain with a residue reports the residue, whatever the policy. -/
theorem settle_dirty {policy : Policy} {chain : Forward} {id : Text} (stop : chain.stop = .failed id)
    (dirty : residue (unwinding policy chain) ≠ []) :
    settle policy chain = .dirty (residue (unwinding policy chain)) (some id) := by
  simp [settle, stop, dirty]

end Saga

/-! ## Bounded: the ranking is a stable descending reordering, and the width bounds every batch and the window -/

namespace Bounded

theorem insertRanked_perm (entry : Ranked) : ∀ (ranked : List Ranked), (insertRanked entry ranked).Perm (entry :: ranked)
  | [] => List.Perm.refl _
  | head :: rest => by
    unfold insertRanked
    split
    · exact ((insertRanked_perm entry rest).cons head).trans (List.Perm.swap entry head rest)
    · exact List.Perm.refl _

/-- The ranking reorders the members and nothing else: none is dropped, none is repeated. -/
theorem order_perm : ∀ (ranked : List Ranked), (order ranked).Perm ranked
  | [] => List.Perm.refl _
  | head :: rest => (insertRanked_perm head (order rest)).trans ((order_perm rest).cons head)

/-- No member is ahead of one with a higher priority. -/
def Descending (ranked : List Ranked) : Prop := ranked.Pairwise (fun earlier later => later.rank ≤ earlier.rank)

theorem insertRanked_descending (entry : Ranked) : ∀ (ranked : List Ranked),
    Descending ranked → Descending (insertRanked entry ranked)
  | [], _ => by simp [insertRanked, Descending]
  | head :: rest, h => by
    have ⟨ahead, tail⟩ := List.pairwise_cons.mp h
    unfold insertRanked
    split
    · rename_i lower
      refine List.pairwise_cons.mpr ⟨?_, insertRanked_descending entry rest tail⟩
      intro other member
      rcases List.mem_cons.mp ((insertRanked_perm entry rest).mem_iff.mp member) with same | inside
      · rw [same]
        exact Int.le_of_lt lower
      · exact ahead other inside
    · rename_i higher
      refine List.pairwise_cons.mpr ⟨?_, h⟩
      intro other member
      rcases List.mem_cons.mp member with same | inside
      · rw [same]
        exact Int.not_lt.mp higher
      · exact Int.le_trans (ahead other inside) (Int.not_lt.mp higher)

/-- **Priority.** The ranking is in descending priority. -/
theorem order_descending : ∀ (ranked : List Ranked), Descending (order ranked)
  | [] => by simp [order, Descending]
  | head :: rest => insertRanked_descending head (order rest) (order_descending rest)

theorem filter_insertRanked (rank : Int) (entry : Ranked) : ∀ (ranked : List Ranked),
    (insertRanked entry ranked).filter (fun member => member.rank == rank) =
      (entry :: ranked).filter (fun member => member.rank == rank)
  | [] => rfl
  | head :: rest => by
    unfold insertRanked
    split
    · rename_i lower
      have ih := filter_insertRanked rank entry rest
      by_cases same : entry.rank = rank
      · have differs : ¬ head.rank = rank := by omega
        simp [same, differs] at ih ⊢
        exact ih
      · simp [List.filter_cons, same] at ih ⊢
        rw [ih]
    · rfl

/-- **Stability.** Members of equal priority keep their declaration order. -/
theorem order_stable (rank : Int) : ∀ (ranked : List Ranked),
    (order ranked).filter (fun member => member.rank == rank) = ranked.filter (fun member => member.rank == rank)
  | [] => rfl
  | head :: rest => by
    rw [order, filter_insertRanked, List.filter_cons, List.filter_cons, order_stable rank rest]

theorem chunksFuel_flatten {α : Type} {width : Nat} (positive : 0 < width) : ∀ (fuel : Nat) (items : List α),
    items.length ≤ fuel → (chunksFuel width fuel items).flatten = items
  | 0, items, h => by
    have empty : items = [] := List.length_eq_zero_iff.mp (Nat.le_zero.mp h)
    simp [chunksFuel, empty]
  | fuel + 1, [], _ => by simp [chunksFuel]
  | fuel + 1, head :: rest, h => by
    have shorter : ((head :: rest).drop width).length ≤ fuel := by
      rw [List.length_drop]
      simp only [List.length_cons] at h ⊢
      omega
    rw [chunksFuel, List.flatten_cons, chunksFuel_flatten positive fuel _ shorter, List.take_append_drop]

/-- The batches, in order, are the ranking: no member is dropped, repeated or moved. -/
theorem chunks_flatten {α : Type} {width : Nat} (positive : 0 < width) (items : List α) :
    (chunks width items).flatten = items :=
  chunksFuel_flatten positive items.length items (Nat.le_refl _)

theorem chunksFuel_bounded {α : Type} {width : Nat} (positive : 0 < width) : ∀ (fuel : Nat) (items : List α),
    ∀ batch ∈ chunksFuel width fuel items, batch.length ≤ width ∧ batch ≠ []
  | 0, _, batch, member => by simp [chunksFuel] at member
  | fuel + 1, [], batch, member => by simp [chunksFuel] at member
  | fuel + 1, head :: rest, batch, member => by
    rw [chunksFuel] at member
    rcases List.mem_cons.mp member with first | later
    · subst first
      constructor
      · rw [List.length_take]
        exact Nat.min_le_left _ _
      · cases width with
        | zero => omega
        | succ width => simp
    · exact chunksFuel_bounded positive fuel _ batch later

/-- **Width.** No batch holds more members than the width, and none is empty. -/
theorem chunks_bounded {α : Type} {width : Nat} (positive : 0 < width) (items : List α) :
    ∀ batch ∈ chunks width items, batch.length ≤ width ∧ batch ≠ [] :=
  chunksFuel_bounded positive items.length items

theorem atLeast_le {least : Int} {num : Num} {value : Nat} (h : num.atLeast least = some value) :
    least ≤ (value : Int) := by
  unfold Num.atLeast at h
  split at h
  · split at h
    · rename_i enough
      have := Option.some.inj h
      omega
    · simp at h
  · simp at h

theorem ranks_names (request : Request) : ∀ (names : List Text) (ranked : List Ranked),
    ranks request names = .ok ranked → ranked.map (·.name) = names
  | [], ranked, h => by
    simp [ranks] at h
    simp [← h]
  | name :: rest, ranked, h => by
    unfold ranks at h
    split at h
    · simp at h
    · split at h
      · rename_i tail found
        have := ranks_names request rest tail found
        cases h
        simp [this]
      · simp at h

/--
**A plan is sound.** A request that is not refused has a positive width, and its ranking is the declared members,
each once, in descending priority.
-/
theorem plan_sound {request : Request} {width : Nat} {ranked : List Ranked} (h : plan request = .ok (width, ranked)) :
    0 < width ∧ (ranked.map (·.name)).Perm request.members ∧ Descending ranked := by
  unfold plan at h
  split at h
  · simp at h
  · rename_i found bound
    split at h
    · simp at h
    · split at h
      · simp at h
      · split at h
        · simp at h
        · rename_i declared names
          have ⟨same, order⟩ := Prod.mk.inj (Except.ok.inj h)
          subst same order
          have positive := atLeast_le bound
          refine ⟨by omega, ?_, order_descending declared⟩
          rw [← ranks_names request _ declared names]
          exact (order_perm declared).map _

/--
**The window.** The members started are a prefix of the ranking, so none starts ahead of a higher priority, and the
members in flight never exceed the width.
-/
theorem run_window {request : Request} {width : Nat} {ranked : List Ranked} (h : plan request = .ok (width, ranked)) :
    (run request).started <+: ranked.map (·.name) ∧ (run request).peak ≤ width := by
  unfold run
  rw [h]
  simp only
  split
  · exact ⟨List.prefix_refl _, Nat.min_le_left _ _⟩
  · exact ⟨List.take_prefix _ _, Nat.min_le_left _ _⟩

/-- A refused request starts nothing. -/
theorem run_refused {request : Request} {refusal : Refusal} (h : plan request = .error refusal) :
    (run request).started = [] ∧ (run request).outcome = .refused refusal := by
  unfold run
  rw [h]
  simp

end Bounded

/-! ## Quarantine: a failure is isolated, never dropped -/

namespace Quarantine

/-- A member is quarantined exactly when it failed. -/
theorem envelope_quarantined (member : Member) :
    envelope member = .quarantined member.name ↔ member.fails = true := by
  unfold envelope
  by_cases fails : member.fails <;> simp [fails]

/--
**Isolation.** Under `quarantine` with no width bound every member starts and the join settles with one envelope per
member, in declaration order: no failure fails the join or stops a sibling.
-/
theorem run_quarantine {members : List Member} (nonempty : members ≠ []) :
    run .quarantine none members =
      { started := members.map (·.name), outcome := .settled (members.map envelope) } := by
  simp [run, nonempty]

/-- The same holds under any valid width bound. -/
theorem run_quarantine_bounded {members : List Member} {num : Num} {width : Nat} (nonempty : members ≠ [])
    (valid : num.atLeast 1 = some width) :
    run .quarantine (some num) members =
      { started := members.map (·.name), outcome := .settled (members.map envelope) } := by
  simp [run, nonempty, valid]

theorem named_eq_nil {kind : Entry} {entries : List (Text × Entry)} :
    named kind entries = [] ↔ ∀ entry ∈ entries, entry.2 ≠ kind := by
  unfold named
  rw [List.map_eq_nil_iff, List.filter_eq_nil_iff]
  constructor
  · intro h entry member same
    exact h entry member (by simp [same])
  · intro h entry member same
    exact h entry member (by simpa using same)

/-- **Halt after join.** `settle` returns values exactly when every entry succeeded, and then returns all of them. -/
theorem settle_values {entries : List (Text × Entry)} :
    settle entries = .values (entries.map (·.1)) ↔ ∀ entry ∈ entries, entry.2 = .succeeded := by
  unfold settle
  constructor
  · intro h entry member
    split at h
    · simp at h
    · rename_i valid
      split at h
      · simp at h
      · rename_i clean
        have notInvalid := named_eq_nil.mp (Classical.not_not.mp valid) entry member
        have notQuarantined := named_eq_nil.mp (Classical.not_not.mp clean) entry member
        cases kind : entry.2 <;> simp_all
  · intro h
    have valid : named .invalid entries = [] := named_eq_nil.mpr (fun entry member => by simp [h entry member])
    have clean : named .quarantined entries = [] := named_eq_nil.mpr (fun entry member => by simp [h entry member])
    simp [valid, clean]

end Quarantine

/-! ## ReviewLoop: the loop ends within its round bound, and within the stall bound when nothing changes -/

namespace ReviewLoop

/-- A loop started at `index` with `fuel` revisions left reviews at least one round and at most `fuel + 1`. -/
theorem loop_round (policy : Option Policy) (rounds : List Round) : ∀ (fuel index : Nat) (state : State),
    index + 1 ≤ (loop policy rounds fuel index state).round ∧
      (loop policy rounds fuel index state).round ≤ index + fuel + 1
  | 0, index, state => by
    simp only [loop]
    split <;> constructor <;> dsimp only <;> omega
  | fuel + 1, index, state => by
    simp only [loop]
    split
    · constructor <;> dsimp only <;> omega
    · split
      · have := loop_round none rounds fuel (index + 1) state
        omega
      · split
        · constructor <;> dsimp only <;> omega
        · rename_i next _
          have := loop_round (some ‹Policy›) rounds fuel (index + 1) next
          omega

/-- **Termination.** A loop that is not refused makes at most `maxRounds` reviews. -/
theorem run_terminates {request : Request} {maxRounds : Nat} (valid : request.maxRounds.atLeast 1 = some maxRounds) :
    (run request).round ≤ maxRounds := by
  have positive := Bounded.atLeast_le valid
  have bound : ∀ policy, (loop policy request.rounds (maxRounds - 1) 0 initial).round ≤ maxRounds := by
    intro policy
    have := (loop_round policy request.rounds (maxRounds - 1) 0 initial).2
    omega
  unfold run
  rw [valid]
  dsimp only
  split
  · exact bound _
  · split
    · exact Nat.zero_le _
    · exact bound _

/-- A running loop never answers with a refusal: only the options are refused, before any round. -/
theorem loop_not_refused (policy : Option Policy) (rounds : List Round) (reason : Refusal) :
    ∀ (fuel index : Nat) (state : State), (loop policy rounds fuel index state).verdict ≠ .refused reason
  | 0, index, state => by
    simp only [loop]
    split <;> simp
  | fuel + 1, index, state => by
    simp only [loop]
    split
    · simp
    · split
      · exact loop_not_refused none rounds reason fuel (index + 1) state
      · split
        · split <;> simp
        · rename_i next _
          exact loop_not_refused (some ‹Policy›) rounds reason fuel (index + 1) next

/-- A refused loop reviews nothing. -/
theorem run_refused {request : Request} {reason : Refusal} (h : (run request).verdict = .refused reason) :
    (run request).round = 0 := by
  revert h
  unfold run
  split
  · intro _
    rfl
  · split
    · intro h
      exact absurd h (loop_not_refused _ _ _ _ _ _)
    · split
      · intro _
        rfl
      · intro h
        exact absurd h (loop_not_refused _ _ _ _ _ _)

/-- **Approval is earned.** A loop is approved only by an accepted review of the round it ended on. -/
theorem loop_approved (policy : Option Policy) (rounds : List Round) : ∀ (fuel index : Nat) (state : State),
    (loop policy rounds fuel index state).verdict = .approved →
      accepted (roundAt rounds ((loop policy rounds fuel index state).round - 1)).review = true
  | 0, index, state => by
    simp only [loop]
    split
    · rename_i approved
      intro _
      simpa using approved
    · intro h
      simp at h
  | fuel + 1, index, state => by
    simp only [loop]
    split
    · rename_i approved
      intro _
      simpa using approved
    · split
      · exact loop_approved none rounds fuel (index + 1) state
      · split
        · intro h
          split at h <;> simp at h
        · rename_i next _
          exact loop_approved (some ‹Policy›) rounds fuel (index + 1) next

/-- Without a stall breaker a loop ends approved or exhausted, never stalled. -/
theorem loop_unbroken (rounds : List Round) : ∀ (fuel index : Nat) (state : State),
    (loop none rounds fuel index state).verdict = .approved ∨ (loop none rounds fuel index state).verdict = .exhausted
  | 0, index, state => by
    simp only [loop]
    split <;> simp
  | fuel + 1, index, state => by
    simp only [loop]
    split
    · simp
    · exact loop_unbroken rounds fuel (index + 1) state

/-- A round that does not stall leaves the output streak one step along and below the threshold. -/
theorem observe_none {policy : Policy} {state next : State} {observation : Observation}
    (h : observe policy state observation = (next, none)) :
    next.output = advance state.output observation.output ∧ length next.output < policy.rounds := by
  simp only [observe] at h
  have ⟨same, quiet⟩ := Prod.mk.inj h
  subst same
  refine ⟨rfl, ?_⟩
  split at quiet
  · simp at quiet
  · split at quiet
    · simp at quiet
    · split at quiet
      · simp at quiet
      · rename_i below
        dsimp only
        omega

/-- **The breaker is honest.** A stall is reported only for a streak that reached the threshold, with the policy's action. -/
theorem observe_some {policy : Policy} {state next : State} {observation : Observation} {stalled : Stalled}
    (h : observe policy state observation = (next, some stalled)) :
    policy.rounds ≤ stalled.rounds ∧ stalled.on = policy.on := by
  simp only [observe] at h
  have ⟨_, loud⟩ := Prod.mk.inj h
  split at loud
  · rename_i reached
    cases loud
    exact ⟨reached, rfl⟩
  · split at loud
    · rename_i reached
      cases loud
      exact ⟨reached, rfl⟩
    · split at loud
      · rename_i reached
        cases loud
        exact ⟨reached, rfl⟩
      · simp at loud

/-- The same key again extends a streak by at least one round. -/
theorem advance_grows (prior : Streak Nat) (key streak : Nat)
    (held : streak = 0 ∨ ∃ rounds, prior = some (key, rounds) ∧ streak ≤ rounds) :
    ∃ rounds, advance prior (some key) = some (key, rounds) ∧ streak + 1 ≤ rounds := by
  rcases held with zero | ⟨rounds, same, enough⟩
  · subst zero
    unfold advance
    cases prior with
    | none => exact ⟨1, rfl, Nat.le_refl _⟩
    | some entry =>
      obtain ⟨other, rounds⟩ := entry
      dsimp only
      split
      · exact ⟨rounds + 1, rfl, by omega⟩
      · exact ⟨1, rfl, Nat.le_refl _⟩
  · subst same
    exact ⟨rounds + 1, by simp [advance], by omega⟩

/--
While every round reports the same output, a loop that has already seen it `streak` times in a row ends within the
rounds the threshold still allows.
-/
theorem loop_stall_bound (policy : Policy) (rounds : List Round) (key : Nat) :
    ∀ (fuel index : Nat) (state : State) (streak : Nat),
      (∀ later, index ≤ later → (roundAt rounds later).observation.output = some key) →
      (streak = 0 ∨ ∃ held, state.output = some (key, held) ∧ streak ≤ held) →
      streak < policy.rounds →
      (loop (some policy) rounds fuel index state).round + streak ≤ index + policy.rounds
  | 0, index, state, streak, _, _, below => by
    simp only [loop]
    split <;> dsimp only <;> omega
  | fuel + 1, index, state, streak, same, held, below => by
    simp only [loop]
    split
    · dsimp only
      omega
    · split
      · dsimp only
        omega
      · rename_i next quiet
        obtain ⟨output, under⟩ := observe_none quiet
        rw [same index (Nat.le_refl _)] at output
        obtain ⟨grown, advanced, enough⟩ := advance_grows state.output key streak held
        rw [advanced] at output
        have under' : grown < policy.rounds := by
          rw [output] at under
          exact under
        have := loop_stall_bound policy rounds key fuel (index + 1) next (streak + 1)
          (fun later after => same later (by omega)) (Or.inr ⟨grown, output, enough⟩) (by omega)
        omega

/--
**The stall bound.** With a stall breaker of `stallRounds`, a loop whose every round reports the same output ends
within `stallRounds` reviews, whatever `maxRounds` allows.
-/
theorem run_stall_bound {request : Request} {maxRounds stallRounds key : Nat} {rounds : Num} {on : Option On}
    (valid : request.maxRounds.atLeast 1 = some maxRounds) (stall : request.stall = some (rounds, on))
    (breaker : rounds.atLeast 2 = some stallRounds)
    (same : ∀ index, (roundAt request.rounds index).observation.output = some key) :
    (run request).round ≤ stallRounds := by
  have threshold := Bounded.atLeast_le breaker
  have := loop_stall_bound { rounds := stallRounds, on := on.getD .stop } request.rounds key (maxRounds - 1) 0 initial 0
    (fun later _ => same later) (Or.inl rfl) (by dsimp only; omega)
  dsimp only at this
  simp only [run, valid, stall, breaker]
  omega

/-- **Both bounds.** Such a loop ends within the smaller of the round bound and the stall bound. -/
theorem run_bounded {request : Request} {maxRounds stallRounds key : Nat} {rounds : Num} {on : Option On}
    (valid : request.maxRounds.atLeast 1 = some maxRounds) (stall : request.stall = some (rounds, on))
    (breaker : rounds.atLeast 2 = some stallRounds)
    (same : ∀ index, (roundAt request.rounds index).observation.output = some key) :
    (run request).round ≤ min maxRounds stallRounds :=
  Nat.le_min.mpr ⟨run_terminates valid, run_stall_bound valid stall breaker same⟩

end ReviewLoop

/-! ## Escalation: the ladder stops at the first rung that does not escalate -/

namespace Escalation

/-- The level a climb settles at is the first rung that does not escalate: every rung below it escalated. -/
theorem climb_some (accept : Bool) : ∀ (rungs : List Rung) (base level : Nat), climb accept base rungs = some level →
    ∃ below rung above, rungs = below ++ rung :: above ∧ level = base + below.length ∧
      escalates accept rung = false ∧ ∀ lower ∈ below, escalates accept lower = true
  | [], _, _, h => by simp [climb] at h
  | rung :: rest, base, level, h => by
    unfold climb at h
    split at h
    · rename_i escalated
      obtain ⟨below, settled, above, shape, at_, stops, all⟩ := climb_some accept rest (base + 1) level h
      refine ⟨rung :: below, settled, above, by simp [shape], by simp only [List.length_cons]; omega, stops, ?_⟩
      intro lower member
      rcases List.mem_cons.mp member with first | inside
      · rw [first]
        exact escalated
      · exact all lower inside
    · rename_i settled
      exact ⟨[], rung, rest, rfl, by simp [Option.some.inj h], by simpa using settled, by simp⟩

/-- A climb settles nowhere exactly when every rung escalates. -/
theorem climb_none (accept : Bool) : ∀ (rungs : List Rung) (base : Nat),
    climb accept base rungs = none ↔ ∀ rung ∈ rungs, escalates accept rung = true
  | [], _ => by simp [climb]
  | rung :: rest, base => by
    unfold climb
    split
    · rename_i escalated
      rw [climb_none accept rest (base + 1)]
      simp [escalated]
    · rename_i settled
      simp [settled]

/-- No rung runs twice and none runs past the ladder. -/
theorem run_ran_le (accept fallback : Bool) (rungs : List Rung) : (run accept fallback rungs).ran ≤ rungs.length := by
  unfold run
  split
  · exact Nat.zero_le _
  · dsimp only
    split
    · rename_i level settled
      obtain ⟨below, rung, above, shape, at_, _, _⟩ := climb_some accept rungs 0 level settled
      rw [shape]
      simp only [List.length_append, List.length_cons]
      omega
    · exact Nat.le_refl _

/--
**First good enough.** A ladder that reached a rung stopped at the first rung that did not escalate: that rung ran,
every rung below it escalated, and the fallback did not run.
-/
theorem run_reached {accept fallback : Bool} {rungs : List Rung} {level : Nat}
    (h : (run accept fallback rungs).outcome = .reached level false) :
    ∃ below rung above, rungs = below ++ rung :: above ∧ level = below.length ∧
      escalates accept rung = false ∧ ∀ lower ∈ below, escalates accept lower = true := by
  unfold run at h
  split at h
  · simp at h
  · dsimp only at h
    split at h
    · rename_i settled found
      obtain ⟨below, rung, above, shape, at_, stops, all⟩ := climb_some accept rungs 0 settled found
      have same : settled = level := by
        have := Outcome.reached.inj h
        exact this.1
      exact ⟨below, rung, above, shape, by omega, stops, all⟩
    · split at h
      · have := Outcome.reached.inj h
        simp at this
      · simp at h

/-- **The fallback is last.** The fallback runs only after every rung escalated, and settles at the ladder's length. -/
theorem run_fallback {accept fallback : Bool} {rungs : List Rung} {level : Nat}
    (h : (run accept fallback rungs).outcome = .reached level true) :
    fallback = true ∧ level = rungs.length ∧ ∀ rung ∈ rungs, escalates accept rung = true := by
  unfold run at h
  split at h
  · simp at h
  · dsimp only at h
    split at h
    · have := Outcome.reached.inj h
      simp at this
    · rename_i none
      split at h
      · rename_i falls
        exact ⟨falls, (Outcome.reached.inj h).1.symm, (climb_none accept rungs 0).mp none⟩
      · simp at h

/-- **Exhaustion.** A ladder is exhausted exactly when it has a rung, every rung escalates, and there is no fallback. -/
theorem run_exhausted {accept fallback : Bool} {rungs : List Rung} :
    (run accept fallback rungs).outcome = .exhausted (rungs.length - 1) ↔
      rungs ≠ [] ∧ fallback = false ∧ ∀ rung ∈ rungs, escalates accept rung = true := by
  unfold run
  split
  · rename_i empty
    simp [empty]
  · rename_i nonempty
    dsimp only
    split
    · rename_i level settled
      have some : ¬ ∀ rung ∈ rungs, escalates accept rung = true := by
        intro all
        rw [(climb_none accept rungs 0).mpr all] at settled
        simp at settled
      simp [some]
    · rename_i none
      have all := (climb_none accept rungs 0).mp none
      cases fallback with
      | false => simpa [nonempty] using all
      | true => simp

end Escalation

/-! ## Intervene: a change is applied only past the gate -/

namespace Intervene

/-- The approval schema decodes one value: the literal `"approved"`. -/
theorem isApproved_iff (decision : Value) : decision.isApproved = true ↔ decision = .str "approved" := by
  cases decision <;> simp [Value.isApproved]

/-- An accepted review is not an approval: `true` and `{ approved: true }` do not open the gate. -/
theorem accepted_not_approved :
    accepted (.bool true) = true ∧ (Value.bool true).isApproved = false ∧
      accepted (.obj [("approved", .bool true)]) = true ∧ (Value.obj [("approved", .bool true)]).isApproved = false := by
  decide

/--
**The gate.** When no phase fails, the change is applied exactly when the run is not dry and the approval, if one is
configured, decided the literal `"approved"`.
-/
theorem run_applies_iff (dryRun : Bool) (approval : Option Value) :
    Phase.apply ∈ (run { dryRun, approval, failAt := none }).calls ↔
      dryRun = false ∧ (approval = none ∨ approval = some (.str "approved")) := by
  cases dryRun
  · cases approval with
    | none => simp [run, step, apply, report]
    | some decision =>
      by_cases approved : decision.isApproved = true
      · have same := (isApproved_iff decision).mp approved
        subst same
        simp [run, step, apply, report, Value.isApproved]
      · have differs := fun same => approved ((isApproved_iff decision).mpr same)
        simpa [run, step, apply, report, approved] using differs
  · cases approval <;> simp [run, step, report]

/-- A dry run never applies, whatever the approval decides and whichever phase fails. -/
theorem run_dry (approval : Option Value) (failAt : Option Phase) :
    Phase.apply ∉ (run { dryRun := true, approval, failAt }).calls := by
  simp only [run, step, report, if_true]
  repeat' split
  all_goals simp_all

/-- **Denied means untouched.** A denied run applied nothing and reported nothing. -/
theorem run_denied {request : Request} (h : (run request).outcome = .denied) :
    Phase.apply ∉ (run request).calls ∧ Phase.report ∉ (run request).calls := by
  revert h
  simp only [run, step, apply, report]
  repeat' split
  all_goals simp_all

/-- **No apply without approval.** Whichever phase fails, a configured approval that did not decide `"approved"` blocks the change. -/
theorem run_gated {request : Request} {decision : Value} (gate : request.approval = some decision)
    (refused : decision.isApproved = false) : Phase.apply ∉ (run request).calls := by
  simp only [run, step, apply, report, gate, refused]
  repeat' split
  all_goals simp_all

/-- A report that says a change was applied is true: the run was not dry and `apply` was called. -/
theorem run_reported_applied {request : Request} {dry : Bool} (h : (run request).outcome = .reported true dry) :
    Phase.apply ∈ (run request).calls ∧ request.dryRun = false := by
  revert h
  simp only [run, step, apply, report]
  repeat' split
  all_goals simp_all

end Intervene

end PatternsSpec

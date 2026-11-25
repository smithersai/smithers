import SmithersState.Machine

/-!
# Sync envelope, generation fencing, and replication

One authority per shard assigns a gapless `hubSeq` and keeps a receipt per
`(origin, commandId)`. Replicas apply commits strictly in order and refuse
commits from a stale generation (`epoch`).
-/

namespace SmithersState

/-- A command on the wire: the generation the sender believes in, plus its idempotency key. -/
structure Envelope where
  epoch : Nat
  origin : String
  commandId : String
  command : Command
  deriving DecidableEq, Repr

structure Receipt where
  origin : String
  commandId : String
  command : Command
  firstSeq : Nat
  count : Nat
  deriving DecidableEq, Repr

structure ShardState where
  epoch : Nat
  headSeq : Nat
  state : AppState
  receipts : List Receipt
  log : List Commit
  deriving DecidableEq, Repr

def ShardState.init : ShardState :=
  { epoch := 0, headSeq := 0, state := AppState.empty, receipts := [], log := [] }

inductive SubmitResult where
  | accepted (firstSeq count : Nat)
  | duplicate (firstSeq count : Nat)
  | refused (reason : String)
  | epochMismatch (current : Nat)
  deriving DecidableEq, Repr

def stamp (epoch : Nat) (origin commandId : String) : Nat → List Event → List Commit
  | _, [] => []
  | seq, e :: es => ⟨seq, epoch, origin, commandId, e⟩ :: stamp epoch origin commandId (seq + 1) es

def findReceipt (rs : List Receipt) (origin commandId : String) : Option Receipt :=
  rs.find? (fun r => r.origin == origin && r.commandId == commandId)

def commitAccepted (s : ShardState) (env : Envelope) (evs : List Event) : ShardState :=
  { epoch := s.epoch
    headSeq := s.headSeq + evs.length
    state := (stamp s.epoch env.origin env.commandId (s.headSeq + 1) evs).foldl evolve s.state
    receipts := ⟨env.origin, env.commandId, env.command, s.headSeq + 1, evs.length⟩ :: s.receipts
    log := s.log ++ stamp s.epoch env.origin env.commandId (s.headSeq + 1) evs }

/-- The authority's admission step. Order of checks: generation fence, receipt ledger, `decide`. -/
def submit (s : ShardState) (env : Envelope) : ShardState × SubmitResult :=
  if env.epoch = s.epoch then
    match findReceipt s.receipts env.origin env.commandId with
    | some r =>
      if r.command = env.command then (s, .duplicate r.firstSeq r.count)
      else (s, .refused "idempotency_conflict")
    | none =>
      match decide s.state env.command with
      | .refused reason => (s, .refused reason)
      | .accepted evs => (commitAccepted s env evs, .accepted (s.headSeq + 1) evs.length)
  else (s, .epochMismatch s.epoch)

/-- A new generation of the authority. It fences every writer still on the old one. -/
def bumpEpoch (s : ShardState) : ShardState := { s with epoch := s.epoch + 1 }

structure Replica where
  epoch : Nat
  cursor : Nat
  confirmed : AppState
  deriving DecidableEq, Repr

def Replica.init : Replica := { epoch := 0, cursor := 0, confirmed := AppState.empty }

inductive ApplyResult where
  | applied
  | duplicate
  | gap
  | staleEpoch
  | epochAhead
  deriving DecidableEq, Repr

/-- A replica applies one commit from the authority's log. -/
def applyCommit (r : Replica) (c : Commit) : Replica × ApplyResult :=
  if c.epoch < r.epoch then (r, .staleEpoch)
  else if r.epoch < c.epoch then (r, .epochAhead)
  else if c.hubSeq ≤ r.cursor then (r, .duplicate)
  else if c.hubSeq = r.cursor + 1 then
    ({ r with cursor := c.hubSeq, confirmed := evolve r.confirmed c }, .applied)
  else (r, .gap)

def applyAll (r : Replica) (cs : List Commit) : Replica :=
  cs.foldl (fun r c => (applyCommit r c).1) r

/-- Resync: adopt a newer generation from a snapshot. An older or equal one is ignored. -/
def installSnapshot (r : Replica) (epoch seq : Nat) (state : AppState) : Replica :=
  if r.epoch < epoch then { epoch := epoch, cursor := seq, confirmed := state } else r

/-! ## Idempotency -/

/-- **idempotent_submit.** Re-submitting a committed `commandId` with the identical
payload returns `duplicate`, appends 0 events, and preserves the whole shard state. -/
theorem idempotent_submit (s : ShardState) (env : Envelope) (r : Receipt)
    (hep : env.epoch = s.epoch)
    (hfind : findReceipt s.receipts env.origin env.commandId = some r)
    (hsame : r.command = env.command) :
    submit s env = (s, .duplicate r.firstSeq r.count)
      ∧ (submit s env).1.log = s.log
      ∧ (submit s env).1.state = s.state := by
  have h : submit s env = (s, .duplicate r.firstSeq r.count) := by
    simp [submit, hep, hfind, hsame]
  exact ⟨h, by rw [h], by rw [h]⟩

/-- Whatever the generation, a known `(origin, commandId)` never changes the shard. -/
theorem known_command_preserves_state (s : ShardState) (env : Envelope) (r : Receipt)
    (hfind : findReceipt s.receipts env.origin env.commandId = some r) :
    (submit s env).1 = s := by
  unfold submit
  split
  · simp only [hfind]
    split <;> rfl
  · rfl

/-- End to end: accept once, then every retry of the same envelope is a duplicate
that reports the original sequence numbers and changes nothing. -/
theorem resubmit_is_duplicate (s s' : ShardState) (env : Envelope) (first count : Nat)
    (h : submit s env = (s', .accepted first count)) :
    submit s' env = (s', .duplicate first count) := by
  unfold submit at h
  split at h
  · rename_i hep
    split at h
    · split at h
      · cases h
      · cases h
    · split at h
      · cases h
      · rename_i evs hdec
        injection h with h1 h2
        injection h2 with hf hc
        subst h1 hf hc
        simp [submit, commitAccepted, findReceipt, hep]
  · cases h

/-- Same key, different payload: refused, state untouched. -/
theorem idempotency_conflict_refused (s : ShardState) (env : Envelope) (r : Receipt)
    (hep : env.epoch = s.epoch)
    (hfind : findReceipt s.receipts env.origin env.commandId = some r)
    (hdiff : r.command ≠ env.command) :
    submit s env = (s, .refused "idempotency_conflict") := by
  simp [submit, hep, hfind, hdiff]

/-! ## Generation fencing -/

/-- **fencing_rejects_stale_generation.** A stale-generation submit is never applied
at the authority, and a stale-generation commit is never applied at a replica. -/
theorem fencing_rejects_stale_generation :
    (∀ (s : ShardState) (env : Envelope), env.epoch < s.epoch →
      submit s env = (s, .epochMismatch s.epoch))
    ∧ (∀ (r : Replica) (c : Commit), c.epoch < r.epoch →
      applyCommit r c = (r, .staleEpoch)) := by
  constructor
  · intro s env h
    have hne : env.epoch ≠ s.epoch := Nat.ne_of_lt h
    simp [submit, hne]
  · intro r c h
    simp [applyCommit, h]

/-- Any generation mismatch, stale or ahead, leaves the authority untouched. -/
theorem fencing_rejects_any_mismatch (s : ShardState) (env : Envelope)
    (h : env.epoch ≠ s.epoch) : submit s env = (s, .epochMismatch s.epoch) := by
  simp [submit, h]

/-- After a generation bump every writer on the old generation is fenced. -/
theorem bump_fences_old_writers (s : ShardState) (env : Envelope) (h : env.epoch = s.epoch) :
    submit (bumpEpoch s) env = (bumpEpoch s, .epochMismatch (s.epoch + 1)) := by
  have hne : env.epoch ≠ (bumpEpoch s).epoch := by simp [bumpEpoch, h]
  simpa [bumpEpoch] using fencing_rejects_any_mismatch (bumpEpoch s) env hne

/-! ## Gapless monotonic hubSeq -/

/-- `Gapless k log`: the commits carry sequence numbers `k+1, k+2, …` with no hole. -/
def Gapless : Nat → List Commit → Prop
  | _, [] => True
  | k, c :: cs => c.hubSeq = k + 1 ∧ Gapless (k + 1) cs

theorem stamp_length (epoch : Nat) (origin commandId : String) (seq : Nat) (evs : List Event) :
    (stamp epoch origin commandId seq evs).length = evs.length := by
  induction evs generalizing seq with
  | nil => rfl
  | cons e es ih => simp [stamp, ih]

theorem stamp_events (epoch : Nat) (origin commandId : String) (seq : Nat) (evs : List Event) :
    (stamp epoch origin commandId seq evs).map (fun c => c.event) = evs := by
  induction evs generalizing seq with
  | nil => rfl
  | cons e es ih => simp [stamp, ih]

theorem gapless_stamp (epoch : Nat) (origin commandId : String) (k : Nat) (evs : List Event) :
    Gapless k (stamp epoch origin commandId (k + 1) evs) := by
  induction evs generalizing k with
  | nil => trivial
  | cons e es ih => exact ⟨rfl, ih (k + 1)⟩

theorem gapless_append {k : Nat} {xs ys : List Commit}
    (hx : Gapless k xs) (hy : Gapless (k + xs.length) ys) : Gapless k (xs ++ ys) := by
  induction xs generalizing k with
  | nil => simpa using hy
  | cons x xs ih =>
    obtain ⟨h1, h2⟩ := hx
    refine ⟨h1, ih h2 ?_⟩
    have e : k + (x :: xs).length = k + 1 + xs.length := by simp; omega
    rw [← e]; exact hy

/-- Position of a commit in a gapless log is fixed by its sequence number. -/
theorem gapless_split {k : Nat} {log : List Commit} {c : Commit}
    (hg : Gapless k log) (hc : c ∈ log) :
    ∃ pre post, log = pre ++ c :: post ∧ c.hubSeq = k + pre.length + 1 := by
  induction log generalizing k with
  | nil => cases hc
  | cons a l ih =>
    obtain ⟨h1, h2⟩ := hg
    rcases List.mem_cons.mp hc with e | hin
    · subst e
      exact ⟨[], l, rfl, by simpa using h1⟩
    · obtain ⟨pre, post, hl, hs⟩ := ih h2 hin
      refine ⟨a :: pre, post, by simp [hl], ?_⟩
      simp; omega

/-! ## The authority's invariant -/

structure HubInv (s : ShardState) : Prop where
  gapless : Gapless 0 s.log
  head : s.log.length = s.headSeq
  replay : s.state = s.log.foldl evolve AppState.empty
  wf : s.state.plan.WF

theorem init_inv : HubInv ShardState.init :=
  { gapless := trivial, head := rfl, replay := rfl, wf := empty_wf }

theorem commitAccepted_inv {s : ShardState} (env : Envelope) {evs : List Event}
    (h : HubInv s) (hv : ValidEvents s.state.plan evs) : HubInv (commitAccepted s env evs) where
  gapless := by
    unfold commitAccepted
    apply gapless_append h.gapless
    rw [h.head]
    simpa using gapless_stamp s.epoch env.origin env.commandId s.headSeq evs
  head := by
    simp [commitAccepted, stamp_length, h.head]
  replay := by
    simp [commitAccepted, List.foldl_append, ← h.replay]
  wf := by
    unfold commitAccepted
    exact commits_preserve_wf h.wf hv _ (stamp_events _ _ _ _ _)

/-- Every submit keeps the log gapless, the head equal to the log length, the state
equal to the replay of the log, and the plan tree well formed. -/
theorem submit_preserves_inv (s : ShardState) (env : Envelope) (h : HubInv s) :
    HubInv (submit s env).1 := by
  unfold submit
  split
  · split
    · split <;> exact h
    · split
      · exact h
      · rename_i evs hdec
        exact commitAccepted_inv env h (decide_valid hdec)
  · exact h

theorem bumpEpoch_preserves_inv (s : ShardState) (h : HubInv s) : HubInv (bumpEpoch s) :=
  { gapless := h.gapless, head := h.head, replay := h.replay, wf := h.wf }

/-- The log only grows: a submit never rewrites committed history. -/
theorem submit_log_prefix (s : ShardState) (env : Envelope) :
    ∃ suffix, (submit s env).1.log = s.log ++ suffix := by
  unfold submit
  split
  · split
    · split <;> exact ⟨[], by simp⟩
    · split
      · exact ⟨[], by simp⟩
      · exact ⟨_, rfl⟩
  · exact ⟨[], by simp⟩

/-! ## Replica convergence -/

theorem applyCommit_duplicate_noop (r : Replica) (c : Commit) (h : c.hubSeq ≤ r.cursor) :
    (applyCommit r c).1 = r := by
  unfold applyCommit
  repeat' split
  all_goals first | rfl | omega

theorem applyCommit_gap_noop (r : Replica) (c : Commit) (h : r.cursor + 1 < c.hubSeq) :
    (applyCommit r c).1 = r := by
  unfold applyCommit
  repeat' split
  all_goals first | rfl | omega

/-- A clean in-order delivery advances the cursor by its length and folds `evolve`. -/
theorem applyAll_gapless (r : Replica) (cs : List Commit)
    (hg : Gapless r.cursor cs) (he : ∀ c ∈ cs, c.epoch = r.epoch) :
    applyAll r cs =
      { epoch := r.epoch, cursor := r.cursor + cs.length, confirmed := cs.foldl evolve r.confirmed } := by
  induction cs generalizing r with
  | nil => rfl
  | cons c cs ih =>
    obtain ⟨h1, h2⟩ := hg
    have hce : c.epoch = r.epoch := he c (by simp)
    have hstep : (applyCommit r c).1 =
        { epoch := r.epoch, cursor := r.cursor + 1, confirmed := evolve r.confirmed c } := by
      have hnle : ¬ (r.cursor + 1 ≤ r.cursor) := by omega
      simp [applyCommit, hce, h1, hnle]
    unfold applyAll
    simp only [List.foldl_cons]
    rw [hstep]
    have := ih { epoch := r.epoch, cursor := r.cursor + 1, confirmed := evolve r.confirmed c }
      h2 (fun c' hc' => he c' (by simp [hc']))
    unfold applyAll at this
    rw [this]
    simp; omega

/-- **prefix_convergence.** Two replicas that agree on `(epoch, cursor, confirmed)` and
apply the identical commit prefix reach equal confirmed state. -/
theorem prefix_convergence (r₁ r₂ : Replica) (cs : List Commit)
    (he : r₁.epoch = r₂.epoch) (hk : r₁.cursor = r₂.cursor)
    (hc : r₁.confirmed = r₂.confirmed) :
    (applyAll r₁ cs).confirmed = (applyAll r₂ cs).confirmed
      ∧ (applyAll r₁ cs).cursor = (applyAll r₂ cs).cursor := by
  have : r₁ = r₂ := by
    cases r₁; cases r₂; simp_all
  subst this
  exact ⟨rfl, rfl⟩

/-- A replica is consistent with a log when its confirmed state is exactly the replay
of the first `cursor` commits. -/
def Consistent (log : List Commit) (r : Replica) : Prop :=
  r.cursor ≤ log.length ∧ r.confirmed = (log.take r.cursor).foldl evolve AppState.empty

theorem take_length_append {α : Type} (pre post : List α) :
    (pre ++ post).take pre.length = pre := by
  induction pre with
  | nil => simp
  | cons a l ih => simp [ih]

theorem take_succ_length_append {α : Type} (pre post : List α) (c : α) :
    (pre ++ c :: post).take (pre.length + 1) = pre ++ [c] := by
  induction pre with
  | nil => simp
  | cons a l ih => simp [ih]

/-- Delivering any commit of the log, in any order and any number of times, keeps a
replica consistent with that log. -/
theorem applyCommit_preserves_consistent {log : List Commit} (hg : Gapless 0 log)
    {r : Replica} (hr : Consistent log r) {c : Commit} (hc : c ∈ log) :
    Consistent log (applyCommit r c).1 := by
  unfold applyCommit
  split
  · exact hr
  · split
    · exact hr
    · split
      · exact hr
      · split
        · rename_i hseq
          obtain ⟨pre, post, hl, hs⟩ := gapless_split hg hc
          have hpre : pre.length = r.cursor := by omega
          obtain ⟨_, hconf⟩ := hr
          constructor
          · show c.hubSeq ≤ log.length
            rw [hl]; simp; omega
          · show evolve r.confirmed c = (log.take c.hubSeq).foldl evolve AppState.empty
            rw [hconf, hseq, hl, ← hpre, take_succ_length_append, take_length_append,
              List.foldl_append]
            rfl
        · exact hr

theorem applyAll_preserves_consistent {log : List Commit} (hg : Gapless 0 log)
    (ds : List Commit) (hd : ∀ c ∈ ds, c ∈ log) {r : Replica} (hr : Consistent log r) :
    Consistent log (applyAll r ds) := by
  induction ds generalizing r with
  | nil => exact hr
  | cons d ds ih =>
    unfold applyAll
    simp only [List.foldl_cons]
    exact ih (fun c hc => hd c (by simp [hc]))
      (applyCommit_preserves_consistent hg hr (hd d (by simp)))

/-- **convergence_under_faults.** Two replicas fed arbitrary deliveries drawn from one
gapless log (duplicated, reordered, dropped, any generation) hold equal confirmed
state whenever their cursors are equal. -/
theorem convergence_under_faults {log : List Commit} (hg : Gapless 0 log)
    (r₁ r₂ : Replica) (h₁ : Consistent log r₁) (h₂ : Consistent log r₂)
    (d₁ d₂ : List Commit) (hd₁ : ∀ c ∈ d₁, c ∈ log) (hd₂ : ∀ c ∈ d₂, c ∈ log)
    (hk : (applyAll r₁ d₁).cursor = (applyAll r₂ d₂).cursor) :
    (applyAll r₁ d₁).confirmed = (applyAll r₂ d₂).confirmed := by
  have c₁ := (applyAll_preserves_consistent hg d₁ hd₁ h₁).2
  have c₂ := (applyAll_preserves_consistent hg d₂ hd₂ h₂).2
  rw [c₁, c₂, hk]

/-- A fully caught-up consistent replica equals the authority. -/
theorem caught_up_replica_equals_hub (s : ShardState) (hs : HubInv s) (r : Replica)
    (hr : Consistent s.log r) (hk : r.cursor = s.headSeq) : r.confirmed = s.state := by
  obtain ⟨_, hconf⟩ := hr
  rw [hconf, hs.replay, hk, ← hs.head, List.take_length]

/-- A snapshot of an invariant-holding authority is a consistent replica. -/
theorem snapshot_consistent (s : ShardState) (hs : HubInv s) (r : Replica)
    (hr : Consistent s.log r) :
    Consistent s.log (installSnapshot r s.epoch s.headSeq s.state) := by
  unfold installSnapshot
  split
  · constructor
    · show s.headSeq ≤ s.log.length
      rw [hs.head]; exact Nat.le_refl _
    · show s.state = (s.log.take s.headSeq).foldl evolve AppState.empty
      rw [← hs.head, List.take_length]; exact hs.replay
  · exact hr

end SmithersState

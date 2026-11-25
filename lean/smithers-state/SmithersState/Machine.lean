import SmithersState.PlanTree
import SmithersState.Chat

/-!
# The reference machine: `decide`, `evolve`, `rebasePending`
-/

namespace SmithersState

def decide (s : AppState) : Command → Decision
  | .upsertPlanNode id parent title milestone sources assumptions dodFast order exp =>
    decideUpsert s.plan id parent title milestone sources assumptions dodFast order exp
  | .movePlanNode id newParent order exp => decideMove s.plan id newParent order exp
  | .toggleAssumption id index exp => decideToggle s.plan id index exp
  | .setNodeStatus id status exp => decideStatus s.plan id status exp
  | .attachArtifact id artifactId exp => decideAttach s.plan id artifactId exp
  | .postMessage id author body => decidePost s.chat id author body
  | .updateMessageStatus id status => decideMessageStatus s.chat id status

def evolve (s : AppState) (c : Commit) : AppState :=
  { plan := evolvePlan s.plan c.event, chat := evolveChat s.chat c.hubSeq c.event }

/-- Optimistic application: pending events carry `hubSeq = 0` until the hub commits them. -/
def applyOptimistic (s : AppState) (evs : List Event) : AppState :=
  evs.foldl (fun st e => evolve st ⟨0, 0, "", "", e⟩) s

/-- Replay pending commands over a confirmed state. Refused commands leave the
state unchanged; the caller reads the decisions to drop or surface them. -/
def rebasePending (confirmed : AppState) : List Command → AppState × List Decision
  | [] => (confirmed, [])
  | c :: cs =>
    let d := decide confirmed c
    let next := match d with
      | .accepted evs => applyOptimistic confirmed evs
      | .refused _ => confirmed
    let rest := rebasePending next cs
    (rest.1, d :: rest.2)

theorem decide_deterministic (s₁ s₂ : AppState) (c₁ c₂ : Command)
    (hs : s₁ = s₂) (hc : c₁ = c₂) : decide s₁ c₁ = decide s₂ c₂ := by
  subst hs hc; rfl

theorem evolve_deterministic (s₁ s₂ : AppState) (e₁ e₂ : Commit)
    (hs : s₁ = s₂) (he : e₁ = e₂) : evolve s₁ e₁ = evolve s₂ e₂ := by
  subst hs he; rfl

/-- Replay determinism: equal states and equal event lists fold to equal states. -/
theorem replay_deterministic (s₁ s₂ : AppState) (es₁ es₂ : List Commit)
    (hs : s₁ = s₂) (he : es₁ = es₂) : es₁.foldl evolve s₁ = es₂.foldl evolve s₂ := by
  subst hs he; rfl

theorem rebasePending_deterministic (s₁ s₂ : AppState) (p₁ p₂ : List Command)
    (hs : s₁ = s₂) (hp : p₁ = p₂) : rebasePending s₁ p₁ = rebasePending s₂ p₂ := by
  subst hs hp; rfl

theorem rebasePending_decisions_length (s : AppState) (cs : List Command) :
    (rebasePending s cs).2.length = cs.length := by
  induction cs generalizing s with
  | nil => rfl
  | cons c cs ih => simp [rebasePending, ih]

theorem decide_valid {s : AppState} {c : Command} {evs : List Event}
    (h : decide s c = .accepted evs) : ValidEvents s.plan evs := by
  cases c with
  | upsertPlanNode id parent title milestone sources assumptions dodFast order exp =>
    exact decideUpsert_valid h
  | movePlanNode id newParent order exp =>
    obtain ⟨he, hv⟩ := decideMove_valid h
    exact Or.inr ⟨_, he, hv⟩
  | toggleAssumption id index exp => exact decideToggle_valid h
  | setNodeStatus id status exp => exact decideStatus_valid h
  | attachArtifact id artifactId exp => exact decideAttach_valid h
  | postMessage id author body =>
    simp only [decide, decidePost] at h
    split at h
    · split at h
      · injection h with h; subst h; exact Or.inl rfl
      · cases h
    · injection h with h; subst h; exact Or.inr ⟨_, rfl, trivial⟩
  | updateMessageStatus id status =>
    simp only [decide, decideMessageStatus] at h
    split at h
    · cases h
    · split at h
      · injection h with h; subst h; exact Or.inl rfl
      · split at h
        · cases h
        · injection h with h; subst h; exact Or.inr ⟨_, rfl, trivial⟩

/-- Applying the events of one accepted command, at any sequence numbers. -/
theorem commits_preserve_wf {s : AppState} {evs : List Event} (hwf : s.plan.WF)
    (hv : ValidEvents s.plan evs) (commits : List Commit)
    (hc : commits.map (fun c => c.event) = evs) :
    (commits.foldl evolve s).plan.WF := by
  rcases hv with h | ⟨e, h, hval⟩
  · subst h
    cases commits with
    | nil => exact hwf
    | cons c cs => simp at hc
  · subst h
    cases commits with
    | nil => simp at hc
    | cons c cs =>
      cases cs with
      | nil =>
        simp at hc
        subst hc
        exact evolvePlan_preserves_wf _ _ hwf hval
      | cons c' cs' => simp at hc

/-- **plan_tree_acyclic.** Every admitted `MovePlanNode` keeps the tree well formed:
every parent pointer names an existing node, and no node is its own ancestor. -/
theorem plan_tree_acyclic (s : AppState) (id : Id) (newParent : Option Id) (order : Nat)
    (exp : Option Nat) (evs : List Event) (hwf : s.plan.WF)
    (h : decide s (.movePlanNode id newParent order exp) = .accepted evs) :
    let s' := applyOptimistic s evs
    s'.plan.WF
      ∧ (∀ n, ¬ Ancestor (parentOf s'.plan.nodes) n n)
      ∧ (∀ n m, parentOf s'.plan.nodes n = some (some m) → parentOf s'.plan.nodes m ≠ none) := by
  intro s'
  have hwf' : s'.plan.WF := by
    obtain ⟨he, hv⟩ := decideMove_valid (t := s.plan) h
    subst he
    exact evolvePlan_preserves_wf _ _ hwf hv
  exact ⟨hwf', fun n => wf_acyclic hwf' n, fun n m hnm => wf_parent_exists hwf' hnm⟩

/-- The same for every command, not only moves. -/
theorem decide_preserves_wf (s : AppState) (c : Command) (evs : List Event)
    (hwf : s.plan.WF) (h : decide s c = .accepted evs) :
    (applyOptimistic s evs).plan.WF := by
  rcases decide_valid h with he | ⟨e, he, hv⟩
  · subst he; exact hwf
  · subst he; exact evolvePlan_preserves_wf _ _ hwf hv

end SmithersState

import SmithersState.Basic

/-!
# Plan tree: decisions, evolution, and the acyclicity proof

A tree is well formed (`PlanTree.WF`) when every node is `Grounded`: following
parent pointers from it reaches a root in finitely many steps, and every pointer
on the way names a node that exists. `grounded_no_self_ancestor` shows this rules
out cycles. `evolvePlan_preserves_wf` shows every admitted event keeps it.
-/

namespace SmithersState

def findNode (nodes : List PlanNode) (id : Id) : Option PlanNode :=
  nodes.find? (fun n => n.id == id)

/-- `none`: no such node. `some none`: a root. `some (some p)`: child of `p`. -/
def parentOf (nodes : List PlanNode) (id : Id) : Option (Option Id) :=
  (findNode nodes id).map (fun n => n.parent)

/-- Walk parent pointers from `cur`. `some true`: met `target`. `some false`: reached
a root without meeting it. `none`: out of fuel or a dangling pointer. -/
def walk (par : Id → Option (Option Id)) (target : Id) : Nat → Id → Option Bool
  | 0, _ => none
  | fuel + 1, cur =>
    if cur = target then some true
    else match par cur with
      | none => none
      | some none => some false
      | some (some p) => walk par target fuel p

def revOk (t : PlanTree) : Option Nat → Bool
  | none => true
  | some r => r == t.revision

def mergeAssumptions : List Assumption → List String → List Assumption
  | _, [] => []
  | [], t :: ts => ⟨t, false⟩ :: mergeAssumptions [] ts
  | o :: os, t :: ts => ⟨t, o.verified && o.text == t⟩ :: mergeAssumptions os ts

def toggleAt : List Assumption → Nat → List Assumption
  | [], _ => []
  | a :: as, 0 => { a with verified := !a.verified } :: as
  | a :: as, i + 1 => a :: toggleAt as i

def updateNode (nodes : List PlanNode) (id : Id) (f : PlanNode → PlanNode) : List PlanNode :=
  nodes.map (fun n => if n.id = id then f n else n)

def decideUpsert (t : PlanTree) (id : Id) (parent : Option Id) (title milestone : String)
    (sources assumptions : List String) (dodFast : String) (order : Nat)
    (exp : Option Nat) : Decision :=
  if revOk t exp then
    match findNode t.nodes id with
    | some n =>
      if n.parent = parent then
        .accepted [.planNodeUpdated id title milestone sources assumptions dodFast]
      else .refused "parent_mismatch"
    | none =>
      match parent with
      | none => .accepted [.planNodeCreated id none title milestone sources assumptions dodFast order]
      | some p =>
        if (findNode t.nodes p).isSome then
          .accepted [.planNodeCreated id (some p) title milestone sources assumptions dodFast order]
        else .refused "parent_missing"
  else .refused "revision_mismatch"

def decideMove (t : PlanTree) (id : Id) (newParent : Option Id) (order : Nat)
    (exp : Option Nat) : Decision :=
  if revOk t exp then
    match findNode t.nodes id with
    | none => .refused "node_missing"
    | some _ =>
      match newParent with
      | none => .accepted [.planNodeMoved id none order]
      | some p =>
        if (findNode t.nodes p).isSome then
          match walk (parentOf t.nodes) id (t.nodes.length + 1) p with
          | some false => .accepted [.planNodeMoved id (some p) order]
          | some true => .refused "cycle"
          | none => .refused "unrooted"
        else .refused "parent_missing"
  else .refused "revision_mismatch"

def decideToggle (t : PlanTree) (id : Id) (index : Nat) (exp : Option Nat) : Decision :=
  if revOk t exp then
    match findNode t.nodes id with
    | none => .refused "node_missing"
    | some n =>
      if index < n.assumptions.length then .accepted [.assumptionToggled id index]
      else .refused "assumption_missing"
  else .refused "revision_mismatch"

def decideStatus (t : PlanTree) (id : Id) (status : String) (exp : Option Nat) : Decision :=
  if revOk t exp then
    match findNode t.nodes id with
    | none => .refused "node_missing"
    | some _ => .accepted [.nodeStatusSet id status]
  else .refused "revision_mismatch"

def decideAttach (t : PlanTree) (id : Id) (artifactId : String) (exp : Option Nat) : Decision :=
  if revOk t exp then
    match findNode t.nodes id with
    | none => .refused "node_missing"
    | some n =>
      if n.artifactIds.contains artifactId then .accepted []
      else .accepted [.artifactAttached id artifactId]
  else .refused "revision_mismatch"

def evolvePlan (t : PlanTree) : Event → PlanTree
  | .planNodeCreated id parent title milestone sources assumptions dodFast order =>
    { revision := t.revision + 1
      nodes := t.nodes ++ [{
        id := id, parent := parent, title := title, milestone := milestone,
        status := "pending", sources := sources,
        assumptions := assumptions.map (fun x => ⟨x, false⟩),
        dodFast := dodFast, artifactIds := [], order := order }] }
  | .planNodeUpdated id title milestone sources assumptions dodFast =>
    { revision := t.revision + 1
      nodes := updateNode t.nodes id (fun n =>
        { n with title := title, milestone := milestone, sources := sources,
                 assumptions := mergeAssumptions n.assumptions assumptions,
                 dodFast := dodFast }) }
  | .planNodeMoved id parent order =>
    { revision := t.revision + 1
      nodes := updateNode t.nodes id (fun n => { n with parent := parent, order := order }) }
  | .assumptionToggled id index =>
    { revision := t.revision + 1
      nodes := updateNode t.nodes id (fun n => { n with assumptions := toggleAt n.assumptions index }) }
  | .nodeStatusSet id status =>
    { revision := t.revision + 1
      nodes := updateNode t.nodes id (fun n => { n with status := status }) }
  | .artifactAttached id artifactId =>
    { revision := t.revision + 1
      nodes := updateNode t.nodes id (fun n => { n with artifactIds := n.artifactIds ++ [artifactId] }) }
  | .messagePosted _ _ _ _ _ _ => t
  | .messageStatusUpdated _ _ => t
  | .messageMetadataUpdated _ _ _ => t
  | .messageBodyUpdated _ _ => t

/-! ## Well-formedness -/

inductive Grounded (par : Id → Option (Option Id)) : Id → Prop where
  | root {n : Id} : par n = some none → Grounded par n
  | step {n m : Id} : par n = some (some m) → Grounded par m → Grounded par n

/-- `Ancestor par a n`: `a` is a strict ancestor of `n`. -/
inductive Ancestor (par : Id → Option (Option Id)) (a : Id) : Id → Prop where
  | direct {n : Id} : par n = some (some a) → Ancestor par a n
  | step {m n : Id} : par n = some (some m) → Ancestor par a m → Ancestor par a n

def WFPar (par : Id → Option (Option Id)) : Prop :=
  ∀ n, par n ≠ none → Grounded par n

def PlanTree.WF (t : PlanTree) : Prop := WFPar (parentOf t.nodes)

theorem Grounded.exists {par : Id → Option (Option Id)} {n : Id}
    (g : Grounded par n) : par n ≠ none := by
  cases g with
  | root h => simp [h]
  | step h _ => simp [h]

/-- Valid parent pointers: a well-formed tree never points at a missing node. -/
theorem wf_parent_exists {par : Id → Option (Option Id)} {n m : Id}
    (hwf : WFPar par) (h : par n = some (some m)) : par m ≠ none := by
  have g := hwf n (by simp [h])
  cases g with
  | root h' => simp [h] at h'
  | step h' gm =>
    rw [h] at h'
    injection h' with h'
    injection h' with h'
    subst h'
    exact gm.exists

theorem Ancestor.extend {par : Id → Option (Option Id)} {a b x : Id}
    (h : Ancestor par a x) (hb : par a = some (some b)) : Ancestor par b x := by
  induction h with
  | direct hx => exact Ancestor.step hx (Ancestor.direct hb)
  | step hx _ ih => exact Ancestor.step hx ih

theorem Ancestor.inv {par : Id → Option (Option Id)} {a n : Id} (h : Ancestor par a n) :
    par n = some (some a) ∨ ∃ m, par n = some (some m) ∧ Ancestor par a m := by
  cases h with
  | direct h => exact Or.inl h
  | step h h' => exact Or.inr ⟨_, h, h'⟩

/-- Acyclicity: a grounded node is never its own strict ancestor. -/
theorem grounded_no_self_ancestor {par : Id → Option (Option Id)} {n : Id}
    (g : Grounded par n) : ¬ Ancestor par n n := by
  induction g with
  | root h =>
    intro ha
    rcases ha.inv with h' | ⟨m', h', _⟩
    · simp [h] at h'
    · simp [h] at h'
  | step h _ ih =>
    intro ha
    rcases ha.inv with h' | ⟨m', h', ha'⟩
    · rw [h] at h'
      injection h' with h'
      injection h' with h'
      subst h'
      exact ih (Ancestor.direct h)
    · rw [h] at h'
      injection h' with h'
      injection h' with h'
      subst h'
      exact ih (Ancestor.extend ha' h)

theorem wf_acyclic {par : Id → Option (Option Id)} (hwf : WFPar par) (n : Id) :
    ¬ Ancestor par n n := by
  intro ha
  have hex : par n ≠ none := by
    rcases ha.inv with h | ⟨m, h, _⟩
    · simp [h]
    · simp [h]
  exact grounded_no_self_ancestor (hwf n hex) ha

/-- Point update of the parent function: what a move or a create does. -/
def setPar (par : Id → Option (Option Id)) (target : Id) (np : Option Id) :
    Id → Option (Option Id) :=
  fun x => if x = target then some np else par x

theorem walk_grounded {par : Id → Option (Option Id)} {target : Id} {np : Option Id} :
    ∀ (fuel : Nat) (cur : Id), walk par target fuel cur = some false →
      Grounded (setPar par target np) cur := by
  intro fuel
  induction fuel with
  | zero => intro cur h; simp [walk] at h
  | succ k ih =>
    intro cur h
    unfold walk at h
    by_cases hc : cur = target
    · simp [hc] at h
    · simp only [hc, ite_false] at h
      cases hp : par cur with
      | none => simp [hp] at h
      | some o =>
        cases o with
        | none => exact Grounded.root (by simp [setPar, hc, hp])
        | some p =>
          simp only [hp] at h
          exact Grounded.step (m := p) (by simp [setPar, hc, hp]) (ih p h)

theorem grounded_setPar_of_target {par : Id → Option (Option Id)} {target : Id}
    {np : Option Id} (hT : Grounded (setPar par target np) target) {m : Id}
    (hm : Grounded par m) : Grounded (setPar par target np) m := by
  induction hm with
  | @root n h =>
    by_cases hn : n = target
    · subst hn; exact hT
    · exact Grounded.root (by simp [setPar, hn, h])
  | @step n k h _ ih =>
    by_cases hn : n = target
    · subst hn; exact hT
    · exact Grounded.step (m := k) (by simp [setPar, hn, h]) ih

theorem grounded_setPar_fresh {par : Id → Option (Option Id)} {target : Id}
    {np : Option Id} (hf : par target = none) {m : Id}
    (hm : Grounded par m) : Grounded (setPar par target np) m := by
  induction hm with
  | @root n h =>
    have hn : n ≠ target := by intro e; subst e; simp [hf] at h
    exact Grounded.root (by simp [setPar, hn, h])
  | @step n k h _ ih =>
    have hn : n ≠ target := by intro e; subst e; simp [hf] at h
    exact Grounded.step (m := k) (by simp [setPar, hn, h]) ih

theorem wf_move {par : Id → Option (Option Id)} {target : Id} {np : Option Id} {fuel : Nat}
    (hwf : WFPar par)
    (hnp : np = none ∨ ∃ p, np = some p ∧ walk par target fuel p = some false) :
    WFPar (setPar par target np) := by
  have hT : Grounded (setPar par target np) target := by
    rcases hnp with h | ⟨p, h, hw⟩
    · subst h; exact Grounded.root (by simp [setPar])
    · subst h; exact Grounded.step (m := p) (by simp [setPar]) (walk_grounded _ _ hw)
  intro n hn
  by_cases hnt : n = target
  · subst hnt; exact hT
  · have hpn : par n ≠ none := by simpa [setPar, hnt] using hn
    exact grounded_setPar_of_target hT (hwf n hpn)

theorem wf_create {par : Id → Option (Option Id)} {target : Id} {np : Option Id}
    (hwf : WFPar par) (hfresh : par target = none)
    (hnp : np = none ∨ ∃ p, np = some p ∧ par p ≠ none) :
    WFPar (setPar par target np) := by
  have hT : Grounded (setPar par target np) target := by
    rcases hnp with h | ⟨p, h, hp⟩
    · subst h; exact Grounded.root (by simp [setPar])
    · subst h
      exact Grounded.step (m := p) (by simp [setPar]) (grounded_setPar_fresh hfresh (hwf p hp))
  intro n hn
  by_cases hnt : n = target
  · subst hnt; exact hT
  · have hpn : par n ≠ none := by simpa [setPar, hnt] using hn
    exact grounded_setPar_fresh hfresh (hwf n hpn)

/-! ## Connecting the list representation to the parent function -/

theorem findNode_id {nodes : List PlanNode} {x : Id} {n : PlanNode}
    (h : findNode nodes x = some n) : n.id = x := by
  have := List.find?_some h
  simpa using this

theorem findNode_map (g : PlanNode → PlanNode) (hg : ∀ n, (g n).id = n.id) (x : Id) :
    ∀ nodes : List PlanNode, findNode (nodes.map g) x = (findNode nodes x).map g := by
  intro nodes
  induction nodes with
  | nil => rfl
  | cons n ns ih =>
    unfold findNode at ih ⊢
    simp only [List.map_cons, List.find?_cons, hg n]
    cases h : (n.id == x) with
    | true => simp
    | false => simpa using ih

theorem findNode_append_single (nodes : List PlanNode) (new : PlanNode) (x : Id) :
    findNode (nodes ++ [new]) x =
      match findNode nodes x with
      | some n => some n
      | none => if new.id = x then some new else none := by
  induction nodes with
  | nil =>
    simp only [findNode, List.nil_append, List.find?_cons, List.find?_nil]
    cases hb : (new.id == x) with
    | true =>
      have : new.id = x := by simpa using hb
      simp [this]
    | false =>
      have : ¬ new.id = x := by simpa using hb
      simp [this]
  | cons n ns ih =>
    unfold findNode at ih ⊢
    simp only [List.cons_append, List.find?_cons]
    cases h : (n.id == x) with
    | true => simp
    | false => simpa using ih

theorem parentOf_updateNode_same (nodes : List PlanNode) (id : Id) (f : PlanNode → PlanNode)
    (hid : ∀ n, (f n).id = n.id) (hp : ∀ n, (f n).parent = n.parent) :
    parentOf (updateNode nodes id f) = parentOf nodes := by
  funext x
  unfold parentOf updateNode
  rw [findNode_map _ (by intro n; by_cases h : n.id = id <;> simp [h, hid]) x nodes]
  cases findNode nodes x with
  | none => rfl
  | some n => by_cases h : n.id = id <;> simp [h, hp]

theorem parentOf_move (nodes : List PlanNode) (id : Id) (np : Option Id) (order : Nat)
    (hex : (findNode nodes id).isSome) :
    parentOf (updateNode nodes id (fun n => { n with parent := np, order := order })) =
      setPar (parentOf nodes) id np := by
  funext x
  unfold parentOf updateNode setPar
  rw [findNode_map _ (by intro n; by_cases h : n.id = id <;> simp [h]) x nodes]
  by_cases hx : x = id
  · subst hx
    cases hf : findNode nodes x with
    | none => simp [hf] at hex
    | some n => simp [findNode_id hf]
  · cases hf : findNode nodes x with
    | none => simp [hx, hf]
    | some n =>
      have : n.id ≠ id := by rw [findNode_id hf]; exact hx
      simp [hx, this, hf]

theorem parentOf_create (nodes : List PlanNode) (new : PlanNode)
    (hfresh : findNode nodes new.id = none) :
    parentOf (nodes ++ [new]) = setPar (parentOf nodes) new.id new.parent := by
  funext x
  unfold parentOf setPar
  rw [findNode_append_single]
  by_cases hx : x = new.id
  · subst hx; simp [hfresh]
  · have hx' : new.id ≠ x := fun e => hx e.symm
    cases hf : findNode nodes x with
    | none => simp [hx, hx', hf]
    | some n => simp [hx, hf]

/-! ## Admitted events preserve well-formedness -/

/-- What `decide` guarantees about an event it emits, relative to the tree it read. -/
def Event.Valid (t : PlanTree) : Event → Prop
  | .planNodeCreated id parent _ _ _ _ _ _ =>
    findNode t.nodes id = none ∧
      (parent = none ∨ ∃ p, parent = some p ∧ parentOf t.nodes p ≠ none)
  | .planNodeMoved id parent _ =>
    (findNode t.nodes id).isSome ∧
      (parent = none ∨
        ∃ p, parent = some p ∧
          walk (parentOf t.nodes) id (t.nodes.length + 1) p = some false)
  | _ => True

theorem evolvePlan_preserves_wf (t : PlanTree) (e : Event) (hwf : t.WF)
    (hv : e.Valid t) : (evolvePlan t e).WF := by
  unfold PlanTree.WF at hwf ⊢
  cases e with
  | planNodeCreated id parent title milestone sources assumptions dodFast order =>
    obtain ⟨hfresh, hnp⟩ := hv
    simp only [evolvePlan]
    rw [parentOf_create _ _ hfresh]
    exact wf_create hwf (by simp [parentOf, hfresh]) hnp
  | planNodeUpdated id title milestone sources assumptions dodFast =>
    simp only [evolvePlan]
    rw [parentOf_updateNode_same]
    · exact hwf
    · intro n; rfl
    · intro n; rfl
  | planNodeMoved id parent order =>
    obtain ⟨hex, hnp⟩ := hv
    simp only [evolvePlan]
    rw [parentOf_move _ _ _ _ hex]
    exact wf_move hwf hnp
  | assumptionToggled id index =>
    simp only [evolvePlan]
    rw [parentOf_updateNode_same]
    · exact hwf
    · intro n; rfl
    · intro n; rfl
  | nodeStatusSet id status =>
    simp only [evolvePlan]
    rw [parentOf_updateNode_same]
    · exact hwf
    · intro n; rfl
    · intro n; rfl
  | artifactAttached id artifactId =>
    simp only [evolvePlan]
    rw [parentOf_updateNode_same]
    · exact hwf
    · intro n; rfl
    · intro n; rfl
  | messagePosted _ _ _ _ _ _ => exact hwf
  | messageStatusUpdated _ _ => exact hwf
  | messageMetadataUpdated _ _ _ => exact hwf
  | messageBodyUpdated _ _ => exact hwf

/-- `decide` emits zero events or exactly one valid event. -/
def ValidEvents (t : PlanTree) (evs : List Event) : Prop :=
  evs = [] ∨ ∃ e, evs = [e] ∧ e.Valid t

theorem decideMove_valid {t : PlanTree} {id : Id} {np : Option Id} {order : Nat}
    {exp : Option Nat} {evs : List Event}
    (h : decideMove t id np order exp = .accepted evs) :
    evs = [.planNodeMoved id np order] ∧ Event.Valid t (.planNodeMoved id np order) := by
  unfold decideMove at h
  split at h
  · split at h
    · cases h
    · rename_i n hfind
      split at h
      · injection h with h
        subst h
        exact ⟨rfl, by simp [hfind], Or.inl rfl⟩
      · rename_i p
        split at h
        · split at h
          · rename_i hw
            injection h with h
            subst h
            exact ⟨rfl, by simp [hfind], Or.inr ⟨p, rfl, hw⟩⟩
          · cases h
          · cases h
        · cases h
  · cases h

theorem decideUpsert_valid {t : PlanTree} {id : Id} {parent : Option Id}
    {title milestone : String} {sources assumptions : List String} {dodFast : String}
    {order : Nat} {exp : Option Nat} {evs : List Event}
    (h : decideUpsert t id parent title milestone sources assumptions dodFast order exp
      = .accepted evs) : ValidEvents t evs := by
  unfold decideUpsert at h
  split at h
  · split at h
    · split at h
      · injection h with h
        subst h
        exact Or.inr ⟨_, rfl, trivial⟩
      · cases h
    · rename_i hfind
      split at h
      · injection h with h
        subst h
        exact Or.inr ⟨_, rfl, hfind, Or.inl rfl⟩
      · rename_i p
        split at h
        · rename_i hp
          injection h with h
          subst h
          refine Or.inr ⟨_, rfl, hfind, Or.inr ⟨p, rfl, ?_⟩⟩
          unfold parentOf
          cases hf : findNode t.nodes p with
          | none => simp [hf] at hp
          | some n => simp
        · cases h
  · cases h

theorem decideToggle_valid {t : PlanTree} {id : Id} {index : Nat} {exp : Option Nat}
    {evs : List Event} (h : decideToggle t id index exp = .accepted evs) :
    ValidEvents t evs := by
  unfold decideToggle at h
  split at h
  · split at h
    · cases h
    · split at h
      · injection h with h
        subst h
        exact Or.inr ⟨_, rfl, trivial⟩
      · cases h
  · cases h

theorem decideStatus_valid {t : PlanTree} {id : Id} {status : String} {exp : Option Nat}
    {evs : List Event} (h : decideStatus t id status exp = .accepted evs) :
    ValidEvents t evs := by
  unfold decideStatus at h
  split at h
  · split at h
    · cases h
    · injection h with h
      subst h
      exact Or.inr ⟨_, rfl, trivial⟩
  · cases h

theorem decideAttach_valid {t : PlanTree} {id : Id} {artifactId : String} {exp : Option Nat}
    {evs : List Event} (h : decideAttach t id artifactId exp = .accepted evs) :
    ValidEvents t evs := by
  unfold decideAttach at h
  split at h
  · split at h
    · cases h
    · split at h
      · injection h with h
        subst h
        exact Or.inl rfl
      · injection h with h
        subst h
        exact Or.inr ⟨_, rfl, trivial⟩
  · cases h

theorem empty_wf : ({ revision := 0, nodes := [] } : PlanTree).WF := by
  intro n hn
  simp [parentOf, findNode] at hn

end SmithersState

/-
Reference specification of `treeOf` of `packages/ci/src/replay/ProcessTable.ts`: a process and everything
under it, read from a table that may name a process twice, give it two parents, or hold a cycle.
-/

namespace ReportReplaySpec

/-- One row of the process table. -/
structure ProcessEntry where
  pid : Nat
  parent : Nat
  cpuMs : Nat

/-- A process and everything under it. -/
structure ProcessTree where
  cpuMs : Nat
  pids : List Nat
  leaves : List Nat

/-- `[...new Set(list)]`: each value once, where it first stands. -/
def dedup : List Nat → List Nat
  | [] => []
  | x :: rest => x :: (dedup rest).filter (· != x)

/-- The processes the table gives `parent` as their parent, a row at a time. -/
def childrenOf (table : List ProcessEntry) (parent : Nat) : List Nat :=
  (table.filter (·.parent == parent)).map (·.pid)

/-- The CPU time of a process: of its last row, as a `Map` keeps the last value of a key. -/
def cpuOf (table : List ProcessEntry) (pid : Nat) : Nat :=
  match table.reverse.find? (·.pid == pid) with
  | some entry => entry.cpuMs
  | none => 0

/-- The children of `next` that the walk has not met. -/
def below (table : List ProcessEntry) (seen : List Nat) (next : Nat) : List Nat :=
  (dedup (childrenOf table next)).filter fun pid => !seen.contains pid

/-- How many rows name a process the walk has not met: what a walk has left to do. -/
def unseen (table : List ProcessEntry) (seen : List Nat) : Nat :=
  (table.filter fun entry => !seen.contains entry.pid).length

theorem filter_length_lt {α : Type} (p q : α → Bool) (l : List α) (imp : ∀ x, p x = true → q x = true)
    (witness : ∃ x ∈ l, q x = true ∧ p x = false) : (l.filter p).length < (l.filter q).length := by
  induction l with
  | nil => obtain ⟨x, hx, _⟩ := witness; cases hx
  | cons a l ih =>
    have le : (l.filter p).length ≤ (l.filter q).length := by
      clear ih witness
      induction l with
      | nil => simp
      | cons b l ih =>
        by_cases hp : p b = true
        · simp [hp, imp b hp, ih]
        · by_cases hq : q b = true
          · simp [hp, hq]; omega
          · simp [hp, hq, ih]
    obtain ⟨x, hx, hq, hp⟩ := witness
    rcases List.mem_cons.mp hx with rfl | hx
    · simp [hq, hp]; omega
    · have := ih ⟨x, hx, hq, hp⟩
      by_cases hpa : p a = true
      · simp [hpa, imp a hpa]; omega
      · by_cases hqa : q a = true
        · simp [hpa, hqa]; omega
        · simp [hpa, hqa]; omega

theorem mem_dedup {x : Nat} : ∀ {l : List Nat}, x ∈ dedup l → x ∈ l
  | [], h => by simp [dedup] at h
  | a :: l, h => by
    simp only [dedup, List.mem_cons, List.mem_filter] at h
    rcases h with rfl | ⟨h, _⟩
    · exact List.mem_cons_self
    · exact List.mem_cons_of_mem _ (mem_dedup h)

/-- A child the walk has not met is a process of the table, and not among those met. -/
theorem mem_below {table : List ProcessEntry} {seen : List Nat} {next pid : Nat}
    (h : pid ∈ below table seen next) : (∃ entry ∈ table, entry.pid = pid) ∧ pid ∉ seen := by
  simp only [below, List.mem_filter] at h
  obtain ⟨member, fresh⟩ := h
  have := mem_dedup member
  simp only [childrenOf, List.mem_map, List.mem_filter] at this
  obtain ⟨entry, ⟨inTable, _⟩, rfl⟩ := this
  exact ⟨⟨entry, inTable, rfl⟩, by simpa using fresh⟩

/-- Meeting a new child leaves strictly less to do: why a walk ends, cycle or not. -/
theorem unseen_lt {table : List ProcessEntry} {seen : List Nat} {next pid : Nat}
    (h : pid ∈ below table seen next) : unseen table (below table seen next ++ seen) < unseen table seen := by
  obtain ⟨⟨entry, inTable, rfl⟩, fresh⟩ := mem_below h
  apply filter_length_lt
  · intro x hx
    simp only [List.contains_eq_mem, List.mem_append, decide_eq_false_iff_not, not_or,
      Bool.not_eq_eq_eq_not, Bool.not_true] at hx ⊢
    exact hx.2
  · refine ⟨entry, inTable, ?_, ?_⟩
    · simpa using fresh
    · simp only [List.contains_eq_mem, List.mem_append, Bool.not_eq_eq_eq_not, Bool.not_false,
        decide_eq_true_eq]
      exact Or.inl h

/--
The walk of `ProcessTable.treeOf`: `waiting` is its stack, top first, and `seen` every process that was ever
put on it. Each turn takes the top, counts it, and puts on the children not yet seen, the last one on top.

It is defined for every table. A turn either meets a new process, which leaves fewer rows unseen, or meets
none, which leaves a shorter stack; a parent cycle cannot keep either going.
-/
def walk (table : List ProcessEntry) (waiting seen : List Nat) (tree : ProcessTree) : ProcessTree :=
  match waiting with
  | [] => tree
  | next :: rest =>
    walk table ((below table seen next).reverse ++ rest) (below table seen next ++ seen)
      { cpuMs := tree.cpuMs + cpuOf table next
        pids := tree.pids ++ [next]
        leaves := if (below table seen next).isEmpty then tree.leaves ++ [next] else tree.leaves }
termination_by (unseen table seen, waiting.length)
decreasing_by
  cases h : below table seen next with
  | nil => simp [Prod.lex_def]
  | cons pid others =>
    have := unseen_lt (table := table) (seen := seen) (next := next) (pid := pid) (by simp [h])
    rw [h] at this
    simp [Prod.lex_def]
    exact Or.inl this

/-- `ProcessTable.treeOf`: the tree under `root`, empty when the table has no such process. -/
def treeOf (table : List ProcessEntry) (root : Nat) : ProcessTree :=
  let start := if table.any (·.pid == root) then [root] else []
  walk table start start { cpuMs := 0, pids := [], leaves := [] }

end ReportReplaySpec

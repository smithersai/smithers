import CapabilitySpec.Basic

/-!
# Strict total orders and the sorted list without repeats

A capability set is kept in one normal form: each group sorted without repeats, and the groups sorted without repeats.
This file has the order and the normal form; `Theorems` proves the normal form is unique.
-/

namespace CapabilitySpec

/-- A decidable strict total order. -/
class StrictTotal (α : Type) where
  lt : α → α → Bool
  irrefl : ∀ a, lt a a = false
  trans : ∀ a b c, lt a b = true → lt b c = true → lt a c = true
  connected : ∀ a b, lt a b = false → lt b a = false → a = b

open StrictTotal

/-- Lexicographic order: the first difference decides, and a proper prefix comes first. -/
def ltList {α : Type} [StrictTotal α] : List α → List α → Bool
  | [], [] => false
  | [], _ :: _ => true
  | _ :: _, [] => false
  | a :: as, b :: bs => lt a b || (!lt b a && ltList as bs)

/-- Puts a value into a sorted list without repeats; a value already there is not added. -/
def place {α : Type} [StrictTotal α] (a : α) : List α → List α
  | [] => [a]
  | b :: rest => if lt a b then a :: b :: rest else if lt b a then b :: place a rest else b :: rest

/-- The values of a list, sorted, each once. -/
def normalize {α : Type} [StrictTotal α] (values : List α) : List α := values.foldr place []

/-- Each value of the list is below every later one. -/
abbrev Sorted {α : Type} [StrictTotal α] (values : List α) : Prop :=
  values.Pairwise fun a b => lt a b = true

end CapabilitySpec

namespace CapabilitySpec

open StrictTotal

instance : StrictTotal Nat where
  lt a b := decide (a < b)
  irrefl a := by simp
  trans a b c := by simp only [decide_eq_true_eq]; omega
  connected a b := by simp only [decide_eq_false_iff_not]; omega

theorem ltList_irrefl {α : Type} [StrictTotal α] : ∀ (l : List α), ltList l l = false
  | [] => rfl
  | a :: l => by simp [ltList, irrefl, ltList_irrefl l]

theorem ltList_connected {α : Type} [StrictTotal α] :
    ∀ (l m : List α), ltList l m = false → ltList m l = false → l = m
  | [], [], _, _ => rfl
  | [], _ :: _, h, _ => by simp [ltList] at h
  | _ :: _, [], _, h => by simp [ltList] at h
  | a :: l, b :: m, h₁, h₂ => by
    simp only [ltList, Bool.or_eq_false_iff, Bool.and_eq_false_iff, Bool.not_eq_false'] at h₁ h₂
    have e : a = b := connected a b h₁.1 h₂.1
    subst e
    have ia := irrefl a
    have t₁ : ltList l m = false := by
      cases h₁.2 with
      | inl h => rw [ia] at h; cases h
      | inr h => exact h
    have t₂ : ltList m l = false := by
      cases h₂.2 with
      | inl h => rw [ia] at h; cases h
      | inr h => exact h
    rw [ltList_connected l m t₁ t₂]

theorem ltList_trans {α : Type} [StrictTotal α] :
    ∀ (l m n : List α), ltList l m = true → ltList m n = true → ltList l n = true
  | [], [], _, h, _ => by simp [ltList] at h
  | [], _ :: _, [], _, h => by simp [ltList] at h
  | [], _ :: _, _ :: _, _, _ => rfl
  | _ :: _, [], _, h, _ => by simp [ltList] at h
  | _ :: _, _ :: _, [], _, h => by simp [ltList] at h
  | a :: l, b :: m, c :: n, h₁, h₂ => by
    simp only [ltList, Bool.or_eq_true, Bool.and_eq_true, Bool.not_eq_true'] at h₁ h₂ ⊢
    cases h₁ with
    | inl ab =>
      cases h₂ with
      | inl bc => exact Or.inl (trans a b c ab bc)
      | inr bc =>
        cases hbc : lt b c with
        | true => exact Or.inl (trans a b c ab hbc)
        | false =>
          have e : b = c := connected b c hbc bc.1
          subst e
          exact Or.inl ab
    | inr ab =>
      cases hab : lt a b with
      | true =>
        cases h₂ with
        | inl bc => exact Or.inl (trans a b c hab bc)
        | inr bc =>
          cases hbc : lt b c with
          | true => exact Or.inl (trans a b c hab hbc)
          | false =>
            have e : b = c := connected b c hbc bc.1
            subst e
            exact Or.inl hab
      | false =>
        have e : a = b := connected a b hab ab.1
        subst e
        cases h₂ with
        | inl bc => exact Or.inl bc
        | inr bc => exact Or.inr ⟨bc.1, ltList_trans l m n ab.2 bc.2⟩

instance {α : Type} [StrictTotal α] : StrictTotal (List α) where
  lt := ltList
  irrefl := ltList_irrefl
  trans := ltList_trans
  connected := ltList_connected

/-- The place of a selector when selectors are ordered by the code units of their names. -/
def Selector.rank : Selector → Nat
  | .any => 0
  | .within .fs => 1
  | .exact .fsRead => 2
  | .exact .fsWrite => 3
  | .within .jj => 4
  | .exact .jjDiff => 5
  | .exact .jjOpRestore => 6
  | .exact .jjRestore => 7
  | .exact .jjRevert => 8
  | .exact .jjRoot => 9
  | .exact .jjSnapshot => 10
  | .exact .jjStatus => 11
  | .exact .jjWorkspaceAdd => 12
  | .exact .jjWorkspaceForget => 13
  | .within .memory => 14
  | .exact .memoryRead => 15
  | .exact .memoryWrite => 16
  | .within .model => 17
  | .exact .modelCall => 18
  | .within .net => 19
  | .exact .netGet => 20
  | .exact .netPost => 21
  | .exact .netPrivate => 22
  | .within .proc => 23
  | .exact .procSpawn => 24
  | .within .remote => 25
  | .exact .remoteAcquire => 26

def Selector.ranked : Nat → Selector
  | 1 => .within .fs
  | 2 => .exact .fsRead
  | 3 => .exact .fsWrite
  | 4 => .within .jj
  | 5 => .exact .jjDiff
  | 6 => .exact .jjOpRestore
  | 7 => .exact .jjRestore
  | 8 => .exact .jjRevert
  | 9 => .exact .jjRoot
  | 10 => .exact .jjSnapshot
  | 11 => .exact .jjStatus
  | 12 => .exact .jjWorkspaceAdd
  | 13 => .exact .jjWorkspaceForget
  | 14 => .within .memory
  | 15 => .exact .memoryRead
  | 16 => .exact .memoryWrite
  | 17 => .within .model
  | 18 => .exact .modelCall
  | 19 => .within .net
  | 20 => .exact .netGet
  | 21 => .exact .netPost
  | 22 => .exact .netPrivate
  | 23 => .within .proc
  | 24 => .exact .procSpawn
  | 25 => .within .remote
  | 26 => .exact .remoteAcquire
  | _ => .any

theorem Selector.ranked_rank (selector : Selector) : Selector.ranked selector.rank = selector := by
  cases selector with
  | any => rfl
  | within space => cases space <;> rfl
  | exact action => cases action <;> rfl

/-- The key a pattern is ordered by: its selector's rank, then its resource. -/
def Pattern.key (pattern : Pattern) : List Nat := pattern.action.rank :: pattern.resource

theorem Pattern.key_injective {p q : Pattern} (h : p.key = q.key) : p = q := by
  cases p with
  | mk pa pr =>
    cases q with
    | mk qa qr =>
      simp only [Pattern.key, List.cons.injEq] at h
      have e : pa = qa := by rw [← Selector.ranked_rank pa, ← Selector.ranked_rank qa, h.1]
      rw [e, h.2]

/-- Patterns in the implementation's order: by action name, then by resource, both by code unit. -/
instance : StrictTotal Pattern where
  lt p q := ltList p.key q.key
  irrefl p := ltList_irrefl p.key
  trans p q r := ltList_trans p.key q.key r.key
  connected p q h₁ h₂ := Pattern.key_injective (ltList_connected p.key q.key h₁ h₂)

end CapabilitySpec

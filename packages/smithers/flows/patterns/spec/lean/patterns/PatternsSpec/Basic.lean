/-!
# Shared vocabulary of the patterns specification

JavaScript strings and their sort order, the numbers an option may hold, the values a decision reader inspects, and
the two readers every pattern shares: `accepted` and `defaultEscalate`.
-/

namespace PatternsSpec

/-- A JavaScript string: its UTF-16 code units. Names are compared by code unit. -/
abbrev Text := List Nat

/-- JavaScript's `a < b` on strings: lexicographic by code unit, a proper prefix first. -/
def textLt : Text → Text → Bool
  | [], [] => false
  | [], _ :: _ => true
  | _ :: _, [] => false
  | a :: as, b :: bs => a < b || (a == b && textLt as bs)

/-- Puts a text into an ascending list. -/
def insertText (text : Text) : List Text → List Text
  | [] => [text]
  | head :: rest => if textLt head text then head :: insertText text rest else text :: head :: rest

/--
Texts in ascending code-unit order: `[...texts].sort()`. For texts of ASCII digits and lowercase letters this is also
the order of `localeCompare`, which is the only alphabet the saga's residue is specified over.
-/
def sortTexts : List Text → List Text
  | [] => []
  | head :: rest => insertText head (sortTexts rest)

/-- The largest integer a double holds exactly with its neighbours: `Number.MAX_SAFE_INTEGER`. -/
def maxSafe : Int := 9007199254740991

/-- A value found where a number is expected: an integer, or anything else (a fraction, a NaN, a string, nothing). -/
inductive Num where
  | integer (value : Int)
  | other
  deriving Repr, DecidableEq

/-- The integer, when `Number.isSafeInteger` accepts the value. -/
def Num.safe : Num → Option Int
  | .integer value => if -maxSafe ≤ value ∧ value ≤ maxSafe then some value else none
  | .other => none

/-- The integer, when the value is a safe integer of at least `least`. -/
def Num.atLeast (least : Int) (num : Num) : Option Nat :=
  match num.safe with
  | some value => if least ≤ value then some value.toNat else none
  | none => none

/-- A value a decision reader inspects. An object's later field shadows an earlier one of the same key. -/
inductive Value where
  | undefined
  | null
  | bool (value : Bool)
  | int (value : Int)
  | str (value : String)
  | obj (fields : List (String × Value))

/-- An object's own field. -/
def Value.own : Value → String → Option Value
  | .obj fields, key => fields.reverse.lookup key
  | _, _ => none

/-- `value === true`. -/
def Value.isTrue : Value → Bool
  | .bool true => true
  | _ => false

/-- `value === false`. -/
def Value.isFalse : Value → Bool
  | .bool false => true
  | _ => false

/-- `value === "approved"`: the only decision the approval schema decodes. -/
def Value.isApproved : Value → Bool
  | .str text => text == "approved"
  | _ => false

/-- The value has an own field `key` that is exactly `true`. -/
def Value.ownTrue (value : Value) (key : String) : Bool :=
  match value.own key with
  | some field => field.isTrue
  | none => false

/-- An accepted decision: `true`, `"approved"`, `{ approved: true }` or `{ accepted: true }`. -/
def accepted (value : Value) : Bool :=
  value.isTrue || value.isApproved || value.ownTrue "approved" || value.ownTrue "accepted"

/-- A field that reports an error: present and none of `undefined`, `null`, `false`. -/
def Value.reportsError : Value → Bool
  | .undefined => false
  | .null => false
  | .bool false => false
  | _ => true

/--
The escalation decision for a rung with no predicate and no `accept`: a missing result escalates, and so does an
object with a set `error`, `failed: true` or `ok: false`.
-/
def defaultEscalate (result : Value) : Bool :=
  match result with
  | .undefined => true
  | .null => true
  | .obj _ =>
    (match result.own "error" with
      | some field => field.reportsError
      | none => false) ||
    (match result.own "failed" with
      | some field => field.isTrue
      | none => false) ||
    (match result.own "ok" with
      | some field => field.isFalse
      | none => false)
  | _ => false

/-! ## Lemmas -/

theorem mem_insertText {text entry : Text} : ∀ {texts : List Text},
    entry ∈ insertText text texts ↔ entry = text ∨ entry ∈ texts
  | [] => by simp [insertText]
  | head :: rest => by
    unfold insertText
    split
    · rw [List.mem_cons, mem_insertText (texts := rest), List.mem_cons]
      constructor
      · rintro (h | h | h)
        · exact Or.inr (Or.inl h)
        · exact Or.inl h
        · exact Or.inr (Or.inr h)
      · rintro (h | h | h)
        · exact Or.inr (Or.inl h)
        · exact Or.inl h
        · exact Or.inr (Or.inr h)
    · simp [List.mem_cons]

/-- Sorting keeps every text and adds none. -/
theorem mem_sortTexts {entry : Text} : ∀ {texts : List Text}, entry ∈ sortTexts texts ↔ entry ∈ texts
  | [] => by simp [sortTexts]
  | head :: rest => by
    rw [sortTexts, mem_insertText, mem_sortTexts (texts := rest), List.mem_cons]

theorem length_insertText (text : Text) : ∀ (texts : List Text), (insertText text texts).length = texts.length + 1
  | [] => rfl
  | head :: rest => by
    unfold insertText
    split
    · simp [length_insertText text rest]
    · simp

/-- Sorting keeps the count. -/
theorem length_sortTexts : ∀ (texts : List Text), (sortTexts texts).length = texts.length
  | [] => rfl
  | head :: rest => by rw [sortTexts, length_insertText, length_sortTexts rest, List.length_cons]

end PatternsSpec

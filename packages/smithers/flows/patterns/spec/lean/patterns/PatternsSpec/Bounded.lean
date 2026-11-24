import PatternsSpec.Basic

/-!
# Bounded fan-out: highest priority first, at most `concurrency` in flight

The model of `Bounded.run` and of the batches `Bounded.all` declares. Members are ranked by descending priority,
declaration order among equals. The declared form cuts the ranking into batches of the width; the operational form
slides a window of the width over it.
-/

namespace PatternsSpec.Bounded

open PatternsSpec

/-- A member with the priority it resolved to. -/
structure Ranked where
  name : Text
  rank : Int
  deriving Repr, DecidableEq

inductive Refusal where
  /-- The width is not a positive safe integer. -/
  | width
  /-- There is no member. -/
  | empty
  /-- A priority names a member that is not declared. -/
  | unknown (name : Text)
  /-- A member's priority is not a safe integer. -/
  | priority (name : Text)
  deriving Repr, DecidableEq

structure Request where
  /-- The declared member names, in declaration order, distinct. -/
  members : List Text
  /-- The `priorities` record's entries, in key order. -/
  priorities : List (Text × Num)
  /-- The `priority` option: the rank of a member the record does not name. -/
  fallback : Option Num
  concurrency : Num
  /-- The members whose effect fails. -/
  failing : List Text
  deriving Repr

/-- A member's priority: its own entry, else the shared option, else 0. `none` when it is not a safe integer. -/
def rankOf (request : Request) (name : Text) : Option Int :=
  match request.priorities.lookup name with
  | some num => num.safe
  | none =>
    match request.fallback with
    | some num => num.safe
    | none => some 0

/-- Every member with its priority, or the first member, in declaration order, whose priority is refused. -/
def ranks (request : Request) : List Text → Except Refusal (List Ranked)
  | [] => .ok []
  | name :: rest =>
    match rankOf request name with
    | none => .error (.priority name)
    | some rank =>
      match ranks request rest with
      | .ok tail => .ok ({ name, rank } :: tail)
      | .error refusal => .error refusal

/-- Puts a member ahead of a ranking of later-declared members: behind every strictly higher priority. -/
def insertRanked (entry : Ranked) : List Ranked → List Ranked
  | [] => [entry]
  | head :: rest => if entry.rank < head.rank then head :: insertRanked entry rest else entry :: head :: rest

/-- Descending priority, declaration order among equals. -/
def order : List Ranked → List Ranked
  | [] => []
  | head :: rest => insertRanked head (order rest)

def chunksFuel {α : Type} (width : Nat) : Nat → List α → List (List α)
  | 0, _ => []
  | _ + 1, [] => []
  | fuel + 1, head :: rest => (head :: rest).take width :: chunksFuel width fuel ((head :: rest).drop width)

/-- Consecutive runs of `width` items; the last may be shorter. -/
def chunks {α : Type} (width : Nat) (items : List α) : List (List α) :=
  chunksFuel width items.length items

/-- The width and the ranking, or the first refusal `Bounded.run` raises. -/
def plan (request : Request) : Except Refusal (Nat × List Ranked) :=
  match request.concurrency.atLeast 1 with
  | none => .error .width
  | some width =>
    if request.members = [] then .error .empty
    else
      match request.priorities.find? (fun entry => !request.members.contains entry.1) with
      | some entry => .error (.unknown entry.1)
      | none =>
        match ranks request request.members with
        | .error refusal => .error refusal
        | .ok ranked => .ok (width, order ranked)

inductive Outcome where
  | refused (reason : Refusal)
  /-- Every member's value, keyed in ranked order. -/
  | joined (names : List Text)
  /-- The failure of the named member. -/
  | failed (name : Text)
  deriving Repr, DecidableEq

structure Run where
  /-- The members whose effect started, in start order. -/
  started : List Text
  /-- The most members ever in flight at once, when each holds its slot for at least one turn. -/
  peak : Nat
  /-- The batches the declared form sequences. -/
  batches : List (List Text)
  outcome : Outcome
  deriving Repr

/--
`Bounded.run` over members that each take the same time. Member `i` of the ranking starts when member `i - width`
finishes, so the first failing member, at position `p`, stops the run with `p + width` members started.
-/
def run (request : Request) : Run :=
  match plan request with
  | .error refusal => { started := [], peak := 0, batches := [], outcome := .refused refusal }
  | .ok (width, ranked) =>
    let names := ranked.map (·.name)
    let peak := min width names.length
    match names.findIdx? (fun name => request.failing.contains name) with
    | none => { started := names, peak, batches := chunks width names, outcome := .joined names }
    | some position =>
      { started := names.take (position + width)
        peak
        batches := chunks width names
        outcome := .failed (names.getD position []) }

end PatternsSpec.Bounded

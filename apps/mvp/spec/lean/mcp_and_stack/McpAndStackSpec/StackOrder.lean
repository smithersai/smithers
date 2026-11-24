/-!
# The TODO stack's rules

`apply` of `src/features/todos/stack.ts`: what one change does to one repository's stack. The stack is the open
TODOs in `position` order; a settled TODO (merged or dropped) has no position; at most `lanes` TODOs work at once;
a Queued TODO starts when every TODO it stacks on is In review and a lane is free.

The functions here answer on every stack the implementation accepts, kept or not: a row list in any order, with
repeated ids or positions. `Theorems.lean` proves what they keep on a stack that keeps its rules.
-/

namespace McpAndStackSpec

/-- A TODO's state (`TODO_STATES`). -/
inductive TodoState where
  | queued
  | working
  | inReview
  | merged
  | dropped
  | failed
  deriving DecidableEq, Repr

/-- `SETTLED_STATES`: merged and dropped are final. -/
def TodoState.settled : TodoState → Bool
  | .merged => true
  | .dropped => true
  | _ => false

/-- `LANE_STATES`: a Working TODO holds a lane. -/
def TodoState.inLane : TodoState → Bool
  | .working => true
  | _ => false

/-- `ACTIVE_STATES`: a Working or In review TODO has a live attempt. -/
def TodoState.active : TodoState → Bool
  | .working => true
  | .inReview => true
  | _ => false

/-- Where a commit that names no `after` starts (`STACK_BASES`). -/
inductive Base where
  | stacked
  | independent
  deriving DecidableEq, Repr

/-- A TODO as the rules see it (`Row`). -/
structure Row where
  id : String
  number : Nat
  state : TodoState
  position : Option Nat
  attempt : Nat
  revision : Nat
  after : Option String
  /-- `undefined`, `false` or `true`. -/
  baseClosed : Option Bool
  deriving DecidableEq, Repr

/-- One repository's stack (`Stack`). -/
structure Stack where
  nextNumber : Nat
  lanes : Nat
  maxOpen : Nat
  base : Base
  todos : List Row
  deriving DecidableEq, Repr

/-- A commit's `after`: absent (the stack's base), `null` (none), or a TODO's number. -/
inductive CommitAfter where
  | base
  | none
  | number (number : Int)
  deriving DecidableEq, Repr

/-- How a run ends its TODO (`FinishedState`). -/
inductive Finished where
  | merged
  | dropped
  | failed
  deriving DecidableEq, Repr

/-- A change (`Op`). -/
inductive Op where
  | commit (id : String) (after : CommitAfter)
  | drop (number : Int)
  | retry (number : Int)
  | configure (lanes maxOpen : Nat) (base : Base)
  | publish (id : String) (ordinal : Int)
  | finish (id : String) (ordinal : Int) (state : Finished)
  deriving DecidableEq, Repr

/-- A TODO that starts an attempt (`Start`). -/
structure Start where
  todoId : String
  number : Nat
  ordinal : Nat
  revision : Nat
  deriving DecidableEq, Repr

/-- Why the stack refused a change. -/
inductive Refusal where
  | stackFull
  | merged
  | notFound
  | stale
  | notRetryable
  | afterNotOpen
  deriving DecidableEq, Repr

/-- What a change did (`Result`). -/
inductive Result where
  | committed (number position : Nat) (starts : List Start)
  | dropped (number : Int) (changed : Bool) (stopped : Option (String × Nat)) (starts : List Start)
  | published (number : Nat) (starts : List Start)
  | finished (number : Nat) (state : Finished) (starts : List Start)
  | retried (number : Nat) (starts : List Start)
  | configured (starts : List Start)
  | refused (code : Refusal)
  deriving DecidableEq, Repr

/-- `byPosition`: the placed TODOs by position, ties in the order they came (JavaScript's sort is stable). -/
def byPosition (todos : List Row) : List Row :=
  (todos.filter fun todo => todo.position.isSome).mergeSort
    fun a b => decide (a.position.getD 0 ≤ b.position.getD 0)

/-- `openOf`: the open TODOs, in stack order. -/
def openOf (stack : Stack) : List Row := byPosition stack.todos

/-- The first TODO with that id. -/
def rowOf (todos : List Row) (id : String) : Option Row := todos.find? fun todo => decide (todo.id = id)

/--
`chainReady`: every TODO on the chain from `after` is In review and not `baseClosed`. A chain that names a TODO the
stack lacks, or that loops, is not ready: a loop spends the fuel, one step per TODO.
-/
def chainReady (todos : List Row) : Nat → Option String → Bool
  | _, none => true
  | 0, some _ => false
  | fuel + 1, some id =>
    match rowOf todos id with
    | none => false
    | some row =>
      decide (row.state = .inReview) && decide (row.baseClosed ≠ some true) && chainReady todos fuel row.after

/-- `isReady`: Queued, with every TODO it stacks on In review. -/
def isReady (todos : List Row) (todo : Row) : Bool :=
  decide (todo.state = .queued) && chainReady todos todos.length todo.after

/-- The attempt `todo` would start now. -/
def startOf (todo : Row) : Start :=
  { todoId := todo.id, number := todo.number, ordinal := todo.attempt + 1, revision := todo.revision }

/-- The start a TODO's id names: the last of that id, as a `Map` keeps it. -/
def startFor (starts : List Start) (id : String) : Option Start :=
  starts.reverse.find? fun start => decide (start.todoId = id)

/-- A TODO as its start leaves it: Working, on that attempt. -/
def started (starts : List Start) (todo : Row) : Row :=
  match startFor starts todo.id with
  | none => todo
  | some start => { todo with state := .working, attempt := start.ordinal }

/-- The starts `fill` makes: the oldest ready TODOs, one per free lane. -/
def startsOf (todos : List Row) (lanes : Nat) : List Start :=
  (((byPosition todos).filter (isReady todos)).take
    (lanes - (todos.filter fun todo => todo.state.inLane).length)).map startOf

/-- `fill`: starts the oldest ready TODOs while a lane is free. -/
def fill (todos : List Row) (lanes : Nat) : List Row × List Start :=
  (todos.map (started (startsOf todos lanes)), startsOf todos lanes)

/-- A position once the TODO at `gap` has left: the later ones move up one. -/
def closeGap (gap position : Nat) : Nat := if position > gap then position - 1 else position

/--
One TODO as `target` leaves the stack as `state`: the target unplaced, a later one moved up, and one stacked on it
handed the target's own `after`, failed when it was Queued and the target had published.
-/
def leaveRow (target : Row) (state : TodoState) (published : Bool) (todo : Row) : Row :=
  if todo.id = target.id then { todo with state := state, position := none }
  else
    { todo with
      position := todo.position.map (closeGap (target.position.getD 0))
      after := if todo.after = some target.id then target.after else todo.after
      state :=
        if todo.after = some target.id ∧ published = true ∧ todo.state = .queued then .failed else todo.state }

/-- `leave`. -/
def leave (todos : List Row) (target : Row) (state : TodoState) (published : Bool) : List Row :=
  todos.map (leaveRow target state published)

/-- `nearestOpen`: the nearest TODO on `after`'s chain that nothing closed, within one step per TODO and one more. -/
def nearestOpen (todos : List Row) : Nat → Option String → Option String
  | _, none => none
  | 0, some _ => none
  | fuel + 1, some id =>
    match rowOf todos id with
    | none => none
    | some row => if row.baseClosed ≠ some true then some id else nearestOpen todos fuel row.after

/-- `liveTarget`: the TODO of that id, when its live attempt is `ordinal`. -/
def liveTarget (stack : Stack) (id : String) (ordinal : Int) : Option Row :=
  match rowOf stack.todos id with
  | none => none
  | some target => if target.state.active ∧ (target.attempt : Int) = ordinal then some target else none

/-- The TODO a commit stacks on: refused when it names a number no open TODO has. -/
def afterOf (stack : Stack) : CommitAfter → Option (Option String)
  | .base =>
    some (match stack.base with
      | .stacked => (openOf stack).getLast?.map (·.id)
      | .independent => none)
  | .none => some none
  | .number number =>
    match (openOf stack).find? fun todo => decide ((todo.number : Int) = number) with
    | none => none
    | some named => some (some named.id)

/-- The row a commit appends. -/
def committedRow (stack : Stack) (id : String) (after : Option String) : Row :=
  { id := id
    number := stack.nextNumber
    state := .queued
    position := some ((openOf stack).length + 1)
    attempt := 0
    revision := 1
    after := after
    baseClosed := none }

/-- A retried TODO: Queued again, on the nearest TODO its chain still has. -/
def retriedRow (target : Row) (after : Option String) (todo : Row) : Row :=
  if todo.id = target.id then { todo with state := .queued, baseClosed := some false, after := after } else todo

/-- A TODO put in `state`, by id. -/
def stateRow (target : Row) (state : TodoState) (todo : Row) : Row :=
  if todo.id = target.id then { todo with state := state } else todo

/-- The state a finished TODO takes. -/
def Finished.state : Finished → TodoState
  | .merged => .merged
  | .dropped => .dropped
  | .failed => .failed

/-- `apply`: the stack after `op`, and what it did. A refused change leaves the stack as it was. -/
def apply (stack : Stack) : Op → Stack × Result
  | .commit id after =>
    if (openOf stack).length ≥ stack.maxOpen then (stack, .refused .stackFull)
    else match afterOf stack after with
      | none => (stack, .refused .afterNotOpen)
      | some base =>
        let todo := committedRow stack id base
        let filled := fill (stack.todos ++ [todo]) stack.lanes
        ({ stack with nextNumber := stack.nextNumber + 1, todos := filled.1 },
          .committed stack.nextNumber ((openOf stack).length + 1) filled.2)
  | .configure lanes maxOpen base =>
    let filled := fill stack.todos lanes
    ({ stack with lanes := lanes, maxOpen := maxOpen, base := base, todos := filled.1 }, .configured filled.2)
  | .publish id ordinal =>
    match liveTarget stack id ordinal with
    | none => (stack, .refused .stale)
    | some target =>
      let filled := fill (stack.todos.map (stateRow target .inReview)) stack.lanes
      ({ stack with todos := filled.1 }, .published target.number filled.2)
  | .finish id ordinal state =>
    match liveTarget stack id ordinal with
    | none => (stack, .refused .stale)
    | some target =>
      let changed :=
        match state with
        | .failed => stack.todos.map (stateRow target .failed)
        | .merged => leave stack.todos target .merged false
        | .dropped => leave stack.todos target .dropped true
      let filled := fill changed stack.lanes
      ({ stack with todos := filled.1 }, .finished target.number state filled.2)
  | .retry number =>
    match stack.todos.find? fun todo => decide ((todo.number : Int) = number) with
    | none => (stack, .refused .notFound)
    | some target =>
      if target.state ≠ .failed then (stack, .refused .notRetryable)
      else
        let after := nearestOpen stack.todos (stack.todos.length + 1) target.after
        let filled := fill (stack.todos.map (retriedRow target after)) stack.lanes
        ({ stack with todos := filled.1 }, .retried target.number filled.2)
  | .drop number =>
    match stack.todos.find? fun todo => decide ((todo.number : Int) = number) with
    | none => (stack, .refused .notFound)
    | some target =>
      if target.state = .merged then (stack, .refused .merged)
      else if target.state = .dropped then (stack, .dropped number false none [])
      else
        let filled := fill (leave stack.todos target .dropped (decide (target.state = .inReview))) stack.lanes
        ({ stack with todos := filled.1 },
          .dropped number true (if target.state.active then some (target.id, target.attempt) else none) filled.2)

/-- A sequence of changes: each step's stack and result. -/
def run (stack : Stack) : List Op → List (Stack × Result)
  | [] => []
  | op :: rest => apply stack op :: run (apply stack op).1 rest

/-- `violations`: what a stack's rules forbid, one line each, in the implementation's order and words. -/
def violations (stack : Stack) : List String :=
  let numbers := stack.todos.map (·.number)
  let opened := openOf stack
  (if numbers.Nodup then [] else ["a number is taken twice"]) ++
  (if numbers.any (fun number => decide (number < 1) || decide (number ≥ stack.nextNumber)) then
    ["a number outside 1 to next"] else []) ++
  (if opened.zipIdx.any (fun entry => decide (entry.1.position ≠ some (entry.2 + 1))) then
    ["open positions aren't 1 to n"] else []) ++
  (if stack.todos.any (fun todo => todo.state.settled != todo.position.isNone) then
    ["a settled TODO is placed, or an open one isn't"] else []) ++
  (if opened.any (fun todo =>
      match todo.after with
      | none => false
      | some after => !opened.any (fun before =>
          decide (before.id = after) && decide (before.position.getD 0 < todo.position.getD 0))) then
    ["an after isn't an open TODO before it"] else [])

end McpAndStackSpec

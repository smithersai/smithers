import ChainSpec.Authz

/-!
# Call keys, scopes and replay

The reference specification of `src/CallKey.ts`, of the scoped folds in `src/Event.ts` (`inChain`, `started`,
`linkCount`, `authored`, `settled`, `rejected`, `terminal`) and of the replay rules in `src/Chain.ts`: the start
check, the terminal short cut, and what one scripted call does against the journal.

A journal event keeps only what replay reads. A payload, a result and an envelope are opaque texts compared for
equality, which is what comparing their canonical JSON decides.
-/

namespace ChainSpec

-- --- keys ----------------------------------------------------------------------------------------------------------

/-- The four components a settled call is keyed by. -/
structure CallKey where
  link : Nat
  scriptDigest : Text
  ordinal : Nat
  entryDigest : Text
  deriving DecidableEq, Repr

/-- The digest recorded for calls the harness itself issues. -/
def harnessDigest : Text := []

/-- The digits of a number, least significant first; `fuel` only has to exceed the number. -/
def digitsReversed : Nat → Nat → Text
  | 0, _ => []
  | fuel + 1, value => (48 + value % 10) :: (if value / 10 = 0 then [] else digitsReversed fuel (value / 10))

/-- A number as JavaScript prints an index: decimal, no sign, no leading zero. -/
def decimal (value : Nat) : Text := (digitsReversed (value + 1) value).reverse

/-- A scope as the start of a derived name: nothing at the root, `chain/` below it. -/
def scopePrefix (chain : Text) : Text := if chain = [] then [] else chain ++ [slash]

/-- The steering boundary of a call slot: `chain/link/ordinal`, and `link/ordinal` at the root. -/
def boundaryKey (chain : Text) (link ordinal : Nat) : Text :=
  scopePrefix chain ++ (decimal link ++ slash :: decimal ordinal)

/-- The scope of the sub-chain a call slot spawns: `chain/link.ordinal`, and `link.ordinal` at the root. -/
def childScope (chain : Text) (link ordinal : Nat) : Text :=
  scopePrefix chain ++ (decimal link ++ dot :: decimal ordinal)

-- --- events --------------------------------------------------------------------------------------------------------

/-- A settled call: its key, the name and payload it was issued with, and its result. -/
structure Settled where
  key : CallKey
  name : Text
  payload : Text
  result : Text
  deriving DecidableEq, Repr

/-- A journal event. A root event's scope is the empty text. -/
inductive Event where
  | chainStarted (chain : Text) (goal : Text) (envelope : Option Text)
  | linkAuthored (chain : Text) (link : Nat) (digest : Text)
  | callSettled (chain : Text) (link : Nat) (call : Settled)
  | gateRejected (chain : Text) (link : Nat) (ordinal : Nat)
  | linkEnded (chain : Text) (link : Nat) (terminal : Bool)
  | steeringDrained (chain : Text) (link : Nat) (ordinal : Nat)
  deriving DecidableEq, Repr

def Event.chain : Event → Text
  | .chainStarted chain _ _ => chain
  | .linkAuthored chain _ _ => chain
  | .callSettled chain _ _ => chain
  | .gateRejected chain _ _ => chain
  | .linkEnded chain _ _ => chain
  | .steeringDrained chain _ _ => chain

/-- The link an event belongs to; the start of a chain belongs to none. -/
def Event.link : Event → Option Nat
  | .chainStarted _ _ _ => none
  | .linkAuthored _ link _ => some link
  | .callSettled _ link _ => some link
  | .gateRejected _ link _ => some link
  | .linkEnded _ link _ => some link
  | .steeringDrained _ link _ => some link

/-- `Event.inChain`. -/
def inChain (event : Event) (chain : Text) : Bool := event.chain == chain

/-- Whether an event belongs to one link of one scope. -/
def inScope (chain : Text) (link : Nat) (event : Event) : Bool := inChain event chain && event.link == some link

/-- The call an event settles at an ordinal of a link of a scope. -/
def settledBy (chain : Text) (link ordinal : Nat) : Event → Option Settled
  | .callSettled eventChain eventLink call =>
    if eventChain = chain ∧ eventLink = link ∧ call.key.ordinal = ordinal then some call else none
  | _ => none

/-- `Event.settled(events, link, chain).get(ordinal)`: the last settled call under the ordinal wins. -/
def settled (chain : Text) (link : Nat) : List Event → Nat → Option Settled
  | [], _ => none
  | event :: rest, ordinal =>
    match settled chain link rest ordinal with
    | some call => some call
    | none => settledBy chain link ordinal event

/-- The ordinals `Event.settled` holds, in the order the map first saw them. -/
def settledOrdinals (chain : Text) (link : Nat) (events : List Event) : List Nat :=
  (events.filterMap fun event =>
    match event with
    | .callSettled eventChain eventLink call =>
      if eventChain = chain ∧ eventLink = link then some call.key.ordinal else none
    | _ => none).eraseDups

/-- `Event.rejected(events, link, chain).has(ordinal)`. -/
def rejected (chain : Text) (link : Nat) (events : List Event) (ordinal : Nat) : Bool :=
  events.any fun event =>
    match event with
    | .gateRejected eventChain eventLink eventOrdinal => eventChain = chain ∧ eventLink = link ∧ eventOrdinal = ordinal
    | _ => false

/-- `Event.linkCount`: the link now in progress. -/
def linkCount (chain : Text) (events : List Event) : Nat :=
  (events.filter fun event =>
    match event with
    | .linkEnded eventChain _ _ => eventChain = chain
    | _ => false).length

/-- `Event.authored`: the digest of the script authored for a link, the first one recorded. -/
def authored (chain : Text) (link : Nat) : List Event → Option Text
  | [] => none
  | .linkAuthored eventChain eventLink digest :: rest =>
    if eventChain = chain ∧ eventLink = link then some digest else authored chain link rest
  | _ :: rest => authored chain link rest

/-- The goal and envelope the scope was started with, from its first `ChainStarted`. -/
def startedWith (chain : Text) : List Event → Option (Text × Option Text)
  | [] => none
  | .chainStarted eventChain goal envelope :: rest =>
    if eventChain = chain then some (goal, envelope) else startedWith chain rest
  | _ :: rest => startedWith chain rest

/-- `Event.terminal`: whether the scope's last `LinkEnded` ended the chain. -/
def isTerminal (chain : Text) : List Event → Bool
  | [] => false
  | event :: rest =>
    match event with
    | .linkEnded eventChain _ terminal =>
      if eventChain = chain then
        (if rest.any fun later =>
            match later with
            | .linkEnded laterChain _ _ => laterChain = chain
            | _ => false
          then isTerminal chain rest else terminal)
      else isTerminal chain rest
    | _ => isTerminal chain rest

-- --- one call ------------------------------------------------------------------------------------------------------

/-- A call a script issues. -/
structure Call where
  name : Text
  payload : Text
  deriving DecidableEq, Repr

/-- Why a replayed call refuses its journal. -/
inductive Divergence where
  /-- Settled under a different link or script. -/
  | identity
  /-- Settled under a different name. -/
  | name
  /-- Settled with a different payload. -/
  | payload
  /-- Settled under a different declaration than the catalog now carries. -/
  | declaration
  deriving DecidableEq, Repr

/-- What one call slot does. -/
inductive Step where
  /-- The journal holds the call: its result is served and nothing is dispatched. -/
  | replayed (result : Text)
  /-- The journal does not hold the call: it is dispatched and settles under this key. -/
  | live (key : CallKey)
  /-- The journal holds a different call in the slot: the run fails with `replay_divergence`. -/
  | diverged (reason : Divergence)
  /-- The call names no catalog entry: the catalog gate rejects it and the link aborts. -/
  | unlisted
  deriving DecidableEq, Repr

/-- Whether the script goes on to its next call. -/
def Step.continues : Step → Bool
  | .replayed _ => true
  | .live _ => true
  | _ => false

/--
One call slot against what the journal holds for it. `digestOf` is the catalog: the declaration digest of the entry
a name selects now.
-/
def replayStep (digestOf : Text → Option Text) (link : Nat) (scriptDigest : Text) (ordinal : Nat) (call : Call) :
    Option Settled → Step
  | some prior =>
    if prior.key.link ≠ link ∨ prior.key.scriptDigest ≠ scriptDigest then .diverged .identity
    else if prior.name ≠ call.name then .diverged .name
    else if prior.payload ≠ call.payload then .diverged .payload
    else if digestOf call.name ≠ some prior.key.entryDigest then .diverged .declaration
    else .replayed prior.result
  | none =>
    match digestOf call.name with
    | some entryDigest => .live ⟨link, scriptDigest, ordinal, entryDigest⟩
    | none => .unlisted

/-- A script's calls in order from an ordinal on, against the settled calls a link started with. -/
def replayFrom (digestOf : Text → Option Text) (link : Nat) (scriptDigest : Text) (prior : Nat → Option Settled) :
    Nat → List Call → List Step
  | _, [] => []
  | ordinal, call :: rest =>
    let step := replayStep digestOf link scriptDigest ordinal call (prior ordinal)
    if step.continues then step :: replayFrom digestOf link scriptDigest prior (ordinal + 1) rest else [step]

/-- The events a link appends for the calls it dispatched; `liveResult` is what each handler answered. -/
def settleFrom (digestOf : Text → Option Text) (chain : Text) (link : Nat) (scriptDigest : Text)
    (prior : Nat → Option Settled) (liveResult : Nat → Text) : Nat → List Call → List Event
  | _, [] => []
  | ordinal, call :: rest =>
    match replayStep digestOf link scriptDigest ordinal call (prior ordinal) with
    | .live key =>
      .callSettled chain link ⟨key, call.name, call.payload, liveResult ordinal⟩
        :: settleFrom digestOf chain link scriptDigest prior liveResult (ordinal + 1) rest
    | .replayed _ => settleFrom digestOf chain link scriptDigest prior liveResult (ordinal + 1) rest
    | _ => []

/-- The steps of a link that ran to its end, read again once its dispatched calls have settled. -/
def converged (liveResult : Nat → Text) : Nat → List Step → List Step
  | _, [] => []
  | ordinal, .live _ :: rest => .replayed (liveResult ordinal) :: converged liveResult (ordinal + 1) rest
  | ordinal, step :: rest => step :: converged liveResult (ordinal + 1) rest

-- --- one run -------------------------------------------------------------------------------------------------------

/-- What a run does with the journal it finds. -/
inductive Run where
  /-- The scope was started with a different goal or envelope: `replay_divergence`. -/
  | startDiverged
  /-- The scope already ended: its outcome is returned and nothing runs. -/
  | finished (fresh : Bool)
  /-- The link in progress has no authored script: the harness authors one. -/
  | unscripted (fresh : Bool) (link : Nat)
  /-- The link in progress runs its script. -/
  | scripted (fresh : Bool) (link : Nat) (scriptDigest : Text) (steps : List Step)
  deriving DecidableEq, Repr

/-- `Chain.run` over a journal, a scope and a script's calls; `fresh` says the scope had not been started. -/
def run (digestOf : Text → Option Text) (events : List Event) (chain goal : Text) (envelope : Option Text)
    (calls : List Call) : Run :=
  let started := startedWith chain events
  if started.isSome ∧ started ≠ some (goal, envelope) then .startDiverged
  else
    let fresh := started.isNone
    if isTerminal chain events then .finished fresh
    else
      let link := linkCount chain events
      match authored chain link events with
      | none => .unscripted fresh link
      | some scriptDigest =>
        .scripted fresh link scriptDigest (replayFrom digestOf link scriptDigest (settled chain link events) 0 calls)

end ChainSpec

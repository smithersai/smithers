/-!
# Smithers app state: data model

The Lean mirror of `@smthrs/app-state` (`packages/smithers/app-state`).
Every definition here has a TypeScript twin with the same name and the same
field names. The differential fuzz harness runs identical traces through both.

Milestones and statuses are plain strings here. TypeScript narrows them to
literal unions at the Schema boundary; the reducer never branches on an
unknown literal, so the model does not need the narrower type.
-/

namespace SmithersState

abbrev Id := String

structure Assumption where
  text : String
  verified : Bool
  deriving DecidableEq, Repr

structure PlanNode where
  id : Id
  parent : Option Id
  title : String
  milestone : String
  status : String
  sources : List String
  assumptions : List Assumption
  dodFast : String
  artifactIds : List String
  order : Nat
  deriving DecidableEq, Repr

structure PlanTree where
  revision : Nat
  nodes : List PlanNode
  deriving DecidableEq, Repr

/-- One step an answer took. TypeScript also stores the constant `kind = "step"`. -/
structure MessagePart where
  id : String
  flow : String
  status : String
  deriving DecidableEq, Repr

/-- The view a question was sent from, and the view's event that sent it. -/
structure MessageSource where
  viewId : String
  event : String
  deriving DecidableEq, Repr

/-- What a post sets once. `none` is an absent field: it is left out of the canonical JSON.
`data` is the values a view sent with a question, as JSON text the reducer never reads. -/
structure MessageOrigin where
  role : Option String := none
  questionId : Option String := none
  position : Option Nat := none
  createdAt : Option String := none
  source : Option MessageSource := none
  data : Option String := none
  deriving DecidableEq, Repr

/-- What a run writes while its message streams. Frozen once the status is terminal. -/
structure MessageRun where
  parts : Option (List MessagePart) := none
  failure : Option String := none
  modelId : Option String := none
  stopReason : Option String := none
  inputTokens : Option Nat := none
  outputTokens : Option Nat := none
  deriving DecidableEq, Repr

/-- What anyone may still write once the message is terminal. -/
structure MessageNotes where
  summary : Option String := none
  summaryRevision : Option String := none
  phase : Option String := none
  arc : Option String := none
  updatedAt : Option String := none
  /-- Which write of the notes this is, counted where they are kept. A patch that
  carries one no newer than the stored one changes nothing. -/
  noteVersion : Option Nat := none
  deriving DecidableEq, Repr

structure Message where
  id : Id
  author : String
  body : String
  status : String
  hubSeq : Nat
  origin : MessageOrigin := {}
  run : MessageRun := {}
  notes : MessageNotes := {}
  deriving DecidableEq, Repr

structure Chat where
  messages : List Message
  deriving DecidableEq, Repr

structure AppState where
  plan : PlanTree
  chat : Chat
  deriving DecidableEq, Repr

def AppState.empty : AppState := { plan := { revision := 0, nodes := [] }, chat := { messages := [] } }

inductive Command where
  | upsertPlanNode (id : Id) (parent : Option Id) (title milestone : String)
      (sources assumptions : List String) (dodFast : String) (order : Nat)
      (expectedRevision : Option Nat)
  | movePlanNode (id : Id) (newParent : Option Id) (order : Nat) (expectedRevision : Option Nat)
  | toggleAssumption (nodeId : Id) (index : Nat) (expectedRevision : Option Nat)
  | setNodeStatus (nodeId : Id) (status : String) (expectedRevision : Option Nat)
  | attachArtifact (nodeId : Id) (artifactId : String) (expectedRevision : Option Nat)
  | postMessage (messageId : Id) (author body : String) (origin : MessageOrigin)
      (run : MessageRun) (notes : MessageNotes)
  | updateMessageStatus (messageId : Id) (status : String)
  | updateMessageMetadata (messageId : Id) (run : MessageRun) (notes : MessageNotes)
  | updateMessageBody (messageId : Id) (author body : String)
  deriving DecidableEq, Repr

inductive Event where
  | planNodeCreated (id : Id) (parent : Option Id) (title milestone : String)
      (sources assumptions : List String) (dodFast : String) (order : Nat)
  | planNodeUpdated (id : Id) (title milestone : String)
      (sources assumptions : List String) (dodFast : String)
  | planNodeMoved (id : Id) (parent : Option Id) (order : Nat)
  | assumptionToggled (id : Id) (index : Nat)
  | nodeStatusSet (id : Id) (status : String)
  | artifactAttached (id : Id) (artifactId : String)
  | messagePosted (id : Id) (author body : String) (origin : MessageOrigin)
      (run : MessageRun) (notes : MessageNotes)
  | messageStatusUpdated (id : Id) (status : String)
  | messageMetadataUpdated (id : Id) (run : MessageRun) (notes : MessageNotes)
  | messageBodyUpdated (id : Id) (body : String)
  deriving DecidableEq, Repr

inductive Decision where
  | accepted (events : List Event)
  | refused (reason : String)
  deriving DecidableEq, Repr

/-- A sequenced event: what the shard authority appends to its log. `hubSeq` is 0
only for optimistic local application of a pending command. -/
structure Commit where
  hubSeq : Nat
  epoch : Nat
  origin : String
  commandId : String
  event : Event
  deriving DecidableEq, Repr

end SmithersState

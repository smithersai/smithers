import FlowSpec.RetryPolicy

/-!
# Flow metadata

The reference for the static checks `Flow.make` of `packages/smithers/flows/flow/src/Flow/make.ts` runs on a flow's
tag, its `maxRounds` and a `deadline` given in milliseconds, in the order it runs them.
-/

namespace FlowSpec

/-- The code units `String.prototype.trim` removes: white space and line terminators. -/
def whiteSpace : List Nat :=
  [0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007,
    0x2008, 0x2009, 0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF]

/-- `tag.trim().length === 0`: the tag is nothing but white space. -/
def blank (tag : Text) : Bool := tag.all whiteSpace.contains

/-- The check a flow's metadata fails. -/
inductive MetadataIssue where
  | tag
  | maxRounds
  | deadline
  | deadlineTooLong
  deriving Repr, DecidableEq

def MetadataIssue.name : MetadataIssue → String
  | .tag => "tag"
  | .maxRounds => "maxRounds"
  | .deadline => "deadline"
  | .deadlineTooLong => "deadlineTooLong"

/--
The first check a flow's metadata fails. `limit` is the longest deadline a store can record,
`Number.MAX_SAFE_INTEGER` milliseconds.
-/
def metadataIssue {ω : Type} [Arith ω] (limit : ω) (tag : Text) (maxRounds deadline : Option ω) :
    Option MetadataIssue :=
  if blank tag then some .tag
  else if attemptsInvalid maxRounds then some .maxRounds
  else
    match deadline with
    | none => none
    | some deadline =>
      if !Arith.finite deadline || !Arith.lt Arith.zero deadline then some .deadline
      else if Arith.lt limit deadline then some .deadlineTooLong
      else none

end FlowSpec

import FlowSpec.Basic

/-!
# Allocation scope

The reference for `allocationScope` of `packages/smithers/flows/flow/src/Action/StepIdentity.ts`: the text every
ordinal counter is keyed by.

    <kind>/<length of name>:<name>[/s:<digest> | /c:<key>][/g:<length of site>:<site>]

A length is a count of UTF-16 code units, written in decimal. The idempotency component reaches the model already
canonicalized: a declared string as its SHA-256 digest, 64 code units, and a declared object as its derived key, 69
code units (`key1_` and a digest). The hash itself is outside this specification; `Theorems.lean` proves the framing
injective for every pair of fixed-width components.
-/

namespace FlowSpec

/-- The kind of durable operation. -/
inductive Kind where
  | action
  | internal
  deriving Repr, DecidableEq

/-- `action` or `internal`, in code units. -/
def kindText : Kind → Text
  | .action => [97, 99, 116, 105, 111, 110]
  | .internal => [105, 110, 116, 101, 114, 110, 97, 108]

/-- The explicit idempotency component, canonicalized. -/
inductive Idempotency where
  | absent
  /-- A declared string: its SHA-256 digest. -/
  | text (digest : Text)
  /-- A declared object: its derived key. -/
  | object (key : Text)
  deriving Repr, DecidableEq

/-- The declaration material an allocation scope is derived from. -/
structure Identity where
  kind : Kind
  name : Text
  idempotency : Idempotency
  site : Option Text
  deriving Repr, DecidableEq

/-- The width of a SHA-256 digest in lowercase hexadecimal. -/
def digestWidth : Nat := 64

/-- The width of a derived key: `key1_` and a digest. -/
def keyWidth : Nat := 69

/-- The idempotency component has the fixed width of its form. -/
def Idempotency.WellFormed : Idempotency → Prop
  | .absent => True
  | .text digest => digest.length = digestWidth
  | .object key => key.length = keyWidth

/-- `/s:<digest>`, `/c:<key>`, or nothing. -/
def idempotencyText : Idempotency → Text
  | .absent => []
  | .text digest => 47 :: 115 :: 58 :: digest
  | .object key => 47 :: 99 :: 58 :: key

/-- `/g:<length>:<site>`, or nothing. -/
def siteText : Option Text → Text
  | none => []
  | some site => 47 :: 103 :: 58 :: (decimal site.length ++ 58 :: site)

/-- `allocationScope`. -/
def scope (identity : Identity) : Text :=
  kindText identity.kind ++ 47 :: (decimal identity.name.length ++ 58 :: (identity.name
    ++ (idempotencyText identity.idempotency ++ siteText identity.site)))

end FlowSpec

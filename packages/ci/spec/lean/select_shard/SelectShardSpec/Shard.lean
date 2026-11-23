import SelectShardSpec.Basic

/-!
# Contract 8: dividing one run across machines

The reference for `packages/ci/src/contract/Shard.vibe`: the FNV-1a hash partition (`shardOf`, `labelsOf`) and the
longest-first greedy assignment (`assign`).

`assign` is written once over an abstract load arithmetic, `Load`. With `Float` it is the implementation, IEEE
operation for operation, including the rescaling that keeps loads finite and distinguishable. With `Nat` it is the
exact algorithm. The range and partition theorems hold for every `Load`, so they hold for both.

A shard count is at least 1, as the `Shard` schema requires. With a count of 0 the implementation's remainder is not a
number, and this specification's is the hash itself. Durations are a record: each label has at most one.
-/

namespace SelectShardSpec

/-- The FNV-1a offset basis. -/
def fnvOffset : Nat := 0x811c9dc5

/-- The FNV-1a prime. -/
def fnvPrime : Nat := 0x01000193

/-- One FNV-1a step in 32 bits: xor the unit in, multiply by the prime, keep the low 32 bits. -/
def fnvStep (hash unit : Nat) : Nat :=
  ((hash ^^^ unit) * fnvPrime) % 2 ^ 32

/-- The 32-bit FNV-1a hash of a label's UTF-16 code units. -/
def fnv1a (label : Text) : Nat :=
  label.foldl fnvStep fnvOffset

/-- `shardOf`: the shard a label belongs to among `count` shards. -/
def shardOf (label : Text) (count : Nat) : Nat :=
  fnv1a label % count

/-- `labelsOf`: the labels that belong to shard `index` of `count`, in their given order. -/
def labelsOf (labels : List Text) (index count : Nat) : List Text :=
  labels.filter (fun label => shardOf label count == index)

/-- The arithmetic `assign` does on shard loads. -/
class Load (ω : Type) where
  zero : ω
  add : ω → ω → ω
  sub : ω → ω → ω
  lt : ω → ω → Bool
  same : ω → ω → Bool
  finite : ω → Bool

/-- IEEE doubles: the implementation's arithmetic. -/
instance : Load Float where
  zero := 0
  add := (· + ·)
  sub := (· - ·)
  lt := fun a b => decide (a < b)
  same := (· == ·)
  finite := Float.isFinite

/-- Natural numbers: exact loads that never overflow and never round. -/
instance : Load Nat where
  zero := 0
  add := (· + ·)
  sub := (· - ·)
  lt := fun a b => decide (a < b)
  same := (· == ·)
  finite := fun _ => true

/-- A label's weight from measured durations: its duration when that is finite and positive, and otherwise 0. -/
def measuredWeight (durations : List (Text × Float)) (label : Text) : Float :=
  match durations.find? (fun entry => entry.1 == label) with
  | some entry => if entry.2.isFinite && decide (entry.2 > 0) then entry.2 else 0
  | none => 0

/-- A label's weight from exact durations; 0 when it has none. -/
def exactWeight (durations : List (Text × Nat)) (label : Text) : Nat :=
  match durations.find? (fun entry => entry.1 == label) with
  | some entry => entry.2
  | none => 0

section Assign

variable {ω : Type} [Load ω]

/-- The scan behind `lightest`: `best` moves to an index only when that index's load is strictly less. -/
def lightestFrom (loads : List ω) : List ω → Nat → Nat → Nat
  | [], _, best => best
  | load :: rest, index, best =>
    lightestFrom loads rest (index + 1) (if Load.lt load (loads.getD best Load.zero) then index else best)

/-- The first shard with the least load. -/
def lightest (loads : List ω) : Nat :=
  lightestFrom loads loads 0 0

/-- `a` is ordered before `b`: the heavier first, then the lower label. -/
def heavierFirst (weight : Text → ω) (a b : Text) : Bool :=
  Load.lt (weight b) (weight a) || (!Load.lt (weight a) (weight b) && textLt a b)

/-- The distinct labels, longest first; equal weights in label order. -/
def order (weight : Text → ω) (labels : List Text) : List Text :=
  (dedup labels).mergeSort (fun a b => !heavierFirst weight b a)

/-- The shard a label goes to: the lightest when it has a weight, and where its hash puts it otherwise. -/
def slot (count : Nat) (weight : Text → ω) (loads : List ω) (label : Text) : Nat :=
  if Load.lt Load.zero (weight label) then lightest loads else shardOf label count

/--
The loads after shard `index` takes `duration`. Only relative loads matter: when the sum would overflow, or a
positive duration would vanish in rounding, the shard's old load is taken off every shard first.
-/
def settle (loads : List ω) (index : Nat) (duration : ω) : List ω :=
  let least := loads.getD index Load.zero
  let next := Load.add least duration
  if !Load.finite next || (Load.lt Load.zero duration && Load.same next least) then
    (loads.map (fun load => Load.sub load least)).set index duration
  else loads.set index next

/-- Places labels one after another, each seeing the loads the labels before it left. -/
def assignFrom (count : Nat) (weight : Text → ω) : List ω → List Text → List (Text × Nat)
  | _, [] => []
  | loads, label :: rest =>
    (label, slot count weight loads label)
      :: assignFrom count weight (settle loads (slot count weight loads label) (weight label)) rest

/-- `assign`: each distinct label with its shard, in the order the labels were placed. -/
def assign (labels : List Text) (count : Nat) (weight : Text → ω) : List (Text × Nat) :=
  assignFrom count weight (List.replicate count Load.zero) (order weight labels)

end Assign

/-- The labels an assignment gives shard `index`, in the order they were placed. -/
def shard (assigned : List (Text × Nat)) (index : Nat) : List Text :=
  (assigned.filter (fun entry => entry.2 == index)).map (·.1)

end SelectShardSpec

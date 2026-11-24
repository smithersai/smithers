import FlowSpec.Basic

/-!
# Retry policy

The reference for `packages/smithers/flows/flow/src/RetryPolicy.ts`: the policy's contract (`validationIssue`), the
delay before the next attempt (`nextDelay`), the classification of a failure (`isNonRetryable`) and the engine's
single retry decision (`decide`).

The model is written once over an abstract arithmetic of milliseconds, `Arith`. With `Float` it is the
implementation, IEEE operation for operation, including `Math.min` and `Math.max` on a signed zero. With `Nat` it is
the exact schedule. The bounds of `Theorems.lean` hold for every arithmetic whose order is transitive and whose
minimum is below both arguments (`LawfulArith`), which `Nat` is proved to be and which doubles are away from NaN; a
valid policy holds no NaN.

A failure reaches the model as what `errorTag` and `errorCode` read from it: its tag, its code, and the number it
carries as `retryAfterMillis`, each absent when the failure has none.
-/

namespace FlowSpec

/-- The arithmetic the retry policy does on milliseconds, ratios and counts. -/
class Arith (ω : Type) where
  zero : ω
  one : ω
  add : ω → ω → ω
  sub : ω → ω → ω
  mul : ω → ω → ω
  /-- `Math.pow(base, exponent)` for a count. -/
  pow : ω → Nat → ω
  /-- `Math.min` of two. -/
  min : ω → ω → ω
  /-- `Math.max` of two. -/
  max : ω → ω → ω
  lt : ω → ω → Bool
  le : ω → ω → Bool
  /-- `Number.isFinite`. -/
  finite : ω → Bool
  /-- The count a value is, when it is a safe integer that is not negative. -/
  count : ω → Option Nat

/-- The laws the bounds rest on. -/
class LawfulArith (ω : Type) [Arith ω] : Prop where
  le_trans : ∀ {a b c : ω}, Arith.le a b = true → Arith.le b c = true → Arith.le a c = true
  min_le_left : ∀ (a b : ω), Arith.le (Arith.min a b) a = true
  min_le_right : ∀ (a b : ω), Arith.le (Arith.min a b) b = true

/-- The bits of negative zero. -/
def negativeZero : UInt64 := 0x8000000000000000

/-- A NaN. -/
def notANumber : Float := 0.0 / 0.0

/-- `Math.min(a, b)`: NaN when either is, and negative zero below positive zero. -/
def jsMin (a b : Float) : Float :=
  if a.isNaN || b.isNaN then notANumber
  else if a < b then a
  else if b < a then b
  else if a.toBits == negativeZero then a
  else b

/-- `Math.max(a, b)`: NaN when either is, and positive zero above negative zero. -/
def jsMax (a b : Float) : Float :=
  if a.isNaN || b.isNaN then notANumber
  else if a < b then b
  else if b < a then a
  else if a.toBits == negativeZero then b
  else a

/-- `Number.MAX_SAFE_INTEGER`. -/
def maxSafeInteger : Nat := 9007199254740991

/-- The count a double is: itself when `Number.isSafeInteger` holds and it is not negative. -/
def safeCount (x : Float) : Option Nat :=
  if x.isFinite && x.floor == x && decide (x ≥ 0) && decide (x ≤ Float.ofNat maxSafeInteger) then
    some x.toUInt64.toNat
  else none

/-- IEEE doubles: the implementation's arithmetic. -/
instance : Arith Float where
  zero := 0
  one := 1
  add := (· + ·)
  sub := (· - ·)
  mul := (· * ·)
  pow := fun base exponent => Float.pow base (Float.ofNat exponent)
  min := jsMin
  max := jsMax
  lt := fun a b => decide (a < b)
  le := fun a b => decide (a ≤ b)
  finite := Float.isFinite
  count := safeCount

/-- Natural numbers: exact milliseconds that never overflow and never round. Subtraction stops at zero. -/
instance : Arith Nat where
  zero := 0
  one := 1
  add := (· + ·)
  sub := (· - ·)
  mul := (· * ·)
  pow := (· ^ ·)
  min := Nat.min
  max := Nat.max
  lt := fun a b => decide (a < b)
  le := fun a b => decide (a ≤ b)
  finite := fun _ => true
  count := some

instance : LawfulArith Nat where
  le_trans := by
    intro a b c h₁ h₂
    simp only [Arith.le, decide_eq_true_eq] at *
    omega
  min_le_left := by
    intro a b
    simp only [Arith.le, Arith.min, decide_eq_true_eq]
    exact Nat.min_le_left a b
  min_le_right := by
    intro a b
    simp only [Arith.le, Arith.min, decide_eq_true_eq]
    exact Nat.min_le_right a b

/-- One entry of `retryable`: a tag and, optionally, the code the failure must carry. -/
structure Retryable where
  tag : Text
  code : Option Text
  deriving Repr, DecidableEq

/-- A `RetryPolicy` as it is stored: every optional field present or absent. -/
structure Policy (ω : Type) where
  initialMs : ω
  factor : ω
  maxMs : ω
  maxAttempts : Option ω := none
  expirationMs : Option ω := none
  jitterRatio : Option ω := none
  nonRetryable : Option (List Text) := none
  retryable : Option (List Retryable) := none

/-- The field a contract violation names. -/
inductive Field where
  | initialMs
  | factor
  | maxMs
  | maxAttempts
  | expirationMs
  | jitterRatio
  | retryable
  deriving Repr, DecidableEq

def Field.name : Field → String
  | .initialMs => "initialMs"
  | .factor => "factor"
  | .maxMs => "maxMs"
  | .maxAttempts => "maxAttempts"
  | .expirationMs => "expirationMs"
  | .jitterRatio => "jitterRatio"
  | .retryable => "retryable"

section Model

variable {ω : Type} [Arith ω]

/-- `maxAttempts` breaks the contract: it is present and is not a safe integer of at least one. -/
def attemptsInvalid (maxAttempts : Option ω) : Bool :=
  match maxAttempts with
  | none => false
  | some limit =>
    match Arith.count limit with
    | none => true
    | some limit => decide (limit < 1)

/-- `validationIssue`: the first field that breaks the contract, in the order the implementation checks them. -/
def issue (policy : Policy ω) : Option Field :=
  if !Arith.finite policy.initialMs || Arith.le policy.initialMs Arith.zero then some .initialMs
  else if !Arith.finite policy.factor || Arith.le policy.factor Arith.zero then some .factor
  else if !Arith.finite policy.maxMs || Arith.lt policy.maxMs policy.initialMs then some .maxMs
  else if attemptsInvalid policy.maxAttempts then some .maxAttempts
  else if (match policy.expirationMs with
    | some expiration => !Arith.finite expiration || Arith.le expiration Arith.zero
    | none => false) then some .expirationMs
  else if (match policy.jitterRatio with
    | some ratio => !Arith.finite ratio || Arith.lt ratio Arith.zero || Arith.lt Arith.one ratio
    | none => false) then some .jitterRatio
  else if (match policy.retryable with
    | some entries => entries.any (fun entry => entry.tag.isEmpty || entry.code == some [])
    | none => false) then some .retryable
  else none

/-- A supplied elapsed time is not a finite duration that is at least zero. -/
def elapsedMalformed (elapsed : Option ω) : Bool :=
  match elapsed with
  | some elapsed => !Arith.finite elapsed || Arith.lt elapsed Arith.zero
  | none => false

/-- The attempt that just failed, `attempt`, was the last the policy allows. -/
def attemptsSpent (policy : Policy ω) (attempt : Nat) : Bool :=
  match policy.maxAttempts with
  | none => false
  | some limit =>
    match Arith.count limit with
    | none => false
    | some limit => decide (limit ≤ attempt)

/-- The elapsed time is past the policy's expiration. -/
def windowClosed (policy : Policy ω) (elapsed : Option ω) : Bool :=
  match policy.expirationMs, elapsed with
  | some expiration, some elapsed => Arith.lt expiration elapsed
  | _, _ => false

/-- What remains of the expiration window, when the policy declares one and the caller supplies an elapsed time. -/
def window (policy : Policy ω) (elapsed : Option ω) : Option ω :=
  match policy.expirationMs, elapsed with
  | some expiration, some elapsed => some (Arith.max Arith.zero (Arith.sub expiration elapsed))
  | _, _ => none

/-- The backoff: `initialMs * factor^(attempt - 1)`. -/
def backoff (policy : Policy ω) (attempt : Nat) : ω :=
  Arith.mul policy.initialMs (Arith.pow policy.factor (attempt - 1))

/-- The backoff under the cap and under what remains of the expiration window. -/
def capped (policy : Policy ω) (raw : ω) (elapsed : Option ω) : ω :=
  match window policy elapsed with
  | some remaining => Arith.min (Arith.min raw policy.maxMs) remaining
  | none => Arith.min raw policy.maxMs

/--
The jitter band: the last `jitterRatio` of the delay is spread by the sample, and the result never exceeds the delay.
A sample outside `[0, 1]` gives up. An absent sample is 1.
-/
def jitter (policy : Policy ω) (random : Option ω) (delay : ω) : Option ω :=
  match policy.jitterRatio with
  | none => some delay
  | some ratio =>
    if Arith.lt Arith.zero ratio then
      if Arith.le Arith.zero (random.getD Arith.one) && Arith.le (random.getD Arith.one) Arith.one then
        some (Arith.min delay
          (Arith.add (Arith.mul delay (Arith.sub Arith.one ratio))
            (Arith.mul (Arith.mul (random.getD Arith.one) delay) ratio)))
      else none
    else some delay

/-- The delay for a valid attempt count, after the policy's own contract and the attempt have been checked. -/
def delayOf (policy : Policy ω) (attempt : Nat) (random elapsed : Option ω) : Option ω :=
  if decide (attempt < 1) || elapsedMalformed elapsed || attemptsSpent policy attempt
      || windowClosed policy elapsed then none
  else if !Arith.lt Arith.zero (backoff policy attempt) then none
  else if Arith.lt (capped policy (backoff policy attempt) elapsed)
      (Arith.min (backoff policy attempt) policy.initialMs) then none
  else jitter policy random (capped policy (backoff policy attempt) elapsed)

/-- `nextDelay`: the delay before attempt `attempt + 1`, or nothing when the policy gives up. -/
def nextDelay (policy : Policy ω) (attempt : ω) (random elapsed : Option ω) : Option ω :=
  if (issue policy).isSome then none
  else
    match Arith.count attempt with
    | none => none
    | some attempt => delayOf policy attempt random elapsed

/-- Error tags that never retry, under every policy. -/
def defaultNonRetryable : List Text :=
  [utf16 "@smthrs/engine-store/CacheCorruptionDetected", utf16 "@smthrs/engine-store/AttemptEvidenceQuarantined"]

/-- The failure's tag is one that never retries: by type, or by the policy's `nonRetryable`. -/
def tagRefused (policy : Policy ω) (tag : Option Text) : Bool :=
  match tag with
  | none => false
  | some tag => defaultNonRetryable.contains tag || (policy.nonRetryable.getD []).contains tag

/-- An entry of `retryable` selects the failure: its tag, and its code when the entry names one. -/
def selects (tag code : Option Text) (entry : Retryable) : Bool :=
  some entry.tag == tag && (entry.code.isNone || entry.code == code)

/-- `isNonRetryable`: a refused tag, or a declared `retryable` that selects nothing. `nonRetryable` wins. -/
def isNonRetryable (policy : Policy ω) (tag code : Option Text) : Bool :=
  tagRefused policy tag ||
    (match policy.retryable with
    | none => false
    | some entries => !entries.any (selects tag code))

/-- Why a policy stops. -/
inductive Reason where
  | nonRetryable
  | exhausted
  | expired
  deriving Repr, DecidableEq

def Reason.name : Reason → String
  | .nonRetryable => "nonRetryable"
  | .exhausted => "exhausted"
  | .expired => "expired"

/-- The outcome of the engine's retry decision point. -/
inductive Decision (ω : Type) where
  | retryAfter (delayMs : ω)
  | giveUp (reason : Reason)

/-- The failure's own delay is usable: a finite number that is not negative. -/
def hintUsable (hint : ω) : Bool := Arith.finite hint && !Arith.lt hint Arith.zero

/--
The delay under a failure's own hint: the hint is a floor under the backoff, capped by `maxMs` and by what remains of
the expiration window.
-/
def hinted (policy : Policy ω) (elapsed : Option ω) (hint delay : ω) : ω :=
  Arith.min (Arith.min (Arith.max hint delay) policy.maxMs) ((window policy elapsed).getD policy.maxMs)

/-- The reason a policy with no delay gives: `expired` only when dropping the elapsed time would have retried. -/
def stopReason (policy : Policy ω) (attempt : ω) (random elapsed : Option ω) : Reason :=
  if policy.expirationMs.isSome
      && (match elapsed with
        | some elapsed => Arith.finite elapsed && Arith.le Arith.zero elapsed
        | none => false)
      && (nextDelay policy attempt random none).isSome then .expired
  else .exhausted

/-- `decide`: the engine's single retry decision. -/
def decideRetry (policy : Policy ω) (attempt : ω) (tag code : Option Text) (hint random elapsed : Option ω) :
    Decision ω :=
  if isNonRetryable policy tag code then .giveUp .nonRetryable
  else
    match nextDelay policy attempt random elapsed with
    | none => .giveUp (stopReason policy attempt random elapsed)
    | some delay =>
      match hint with
      | none => .retryAfter delay
      | some hint => if hintUsable hint then .retryAfter (hinted policy elapsed hint delay) else .retryAfter delay

end Model

end FlowSpec

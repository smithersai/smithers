import GenerateApplySpec.Units

/-!
# Target labels: `src/generate/Steps.vibe`

`planSteps` gives every step of every matrix variant one label. Smithers build refuses a package with two labels that
differ only by case, a label longer than 512 characters as `//:label`, and a generated target map cannot hold a
`__proto__` key. `uniqueLabel` therefore suffixes a label that is taken or too long with a hash of the step's id.

The loop that looks for a free label has no bound in the implementation. Here it takes `fuel`: `none` means the bound
was reached, which the differential tests never see.
-/

namespace GenerateApplySpec.Labels

open GenerateApplySpec

/-- `[A-Za-z0-9._-]`, the characters a label keeps. -/
def keeps (c : Nat) : Bool := isAlpha c || isDigit c || c == 46 || c == 95 || c == 45

/-- `clean` with whether the unit before was replaced. -/
def cleanFrom : Bool → Str → Str
  | _, [] => []
  | replaced, c :: cs =>
    if keeps c then c :: cleanFrom false cs
    else if replaced then cleanFrom true cs
    else 45 :: cleanFrom true cs

/-- `clean`: each run of other characters becomes one `-`. -/
def clean (text : Str) : Str := cleanFrom false text

/-- `slug`: the cleaned text, after `s-` unless it starts with a letter or `_`. -/
def slug (text : Str) : Str :=
  let cleaned := clean text
  match cleaned with
  | c :: _ => if isAlpha c || c == 95 then cleaned else [115, 45] ++ cleaned
  | [] => [115, 45]

/-- One matrix assignment: its names and values. -/
abbrev Variant := List (Str × Str)

/-- The assignment in the order of its names, as `Object.keys(variant).sort(compare)` gives them. -/
def sortedVariant (variant : Variant) : Variant := variant.mergeSort fun a b => !decide (b.1 < a.1)

/-- `variantSuffix`: `--value` for each value, cleaned. -/
def variantSuffix (variant : Variant) : Str :=
  (sortedVariant variant).flatMap fun pair => [45, 45] ++ clean pair.2

/-- `variantKey`: the assignment as JSON, equal only for equal variants. -/
def variantKey (variant : Variant) : Str :=
  [91] ++ joinWith [44] ((sortedVariant variant).map fun pair =>
    [91] ++ jsonQuote pair.1 ++ [44] ++ jsonQuote pair.2 ++ [93]) ++ [93]

/-- `shardOf(text, 0x1_0000_0000)`: 32-bit FNV-1a over the code units. -/
def fnv1a (text : Str) : Nat := text.foldl (fun hash c => (hash ^^^ c) * 0x01000193 % 0x100000000) 0x811c9dc5

/-- `maximumLabelLength` of `@smthrs/targets`. -/
def maximumLabelLength : Nat := 512

/-- The longest name: the limit less the `//:` an exact reference starts with. -/
def maximumName : Nat := maximumLabelLength - 3

/-- `__proto__`. -/
def proto : Str := [95, 95, 112, 114, 111, 116, 111, 95, 95]

/-- `_repository`, the label of the file group large graphs share. -/
def repositoryLabel : Str := [95, 114, 101, 112, 111, 115, 105, 116, 111, 114, 121]

#guard proto == lit "__proto__"
#guard repositoryLabel == lit "_repository"

/-- The labels taken before any step is given one, in lower case. -/
def reserved : List Str := [repositoryLabel, proto]

/-- True when the loop goes on: the label is too long, or taken in some case. -/
def blocked (taken : List Str) (label : Str) : Bool :=
  decide (maximumName < label.length) || taken.contains (lowerStr label)

/-- The label tried after `attempt` failures more than one: the base, cut to leave room for a hash of the identity. -/
def suffixed (base identity : Str) (attempt : Nat) : Str :=
  let hashed := fnv1a (if attempt = 0 then identity else identity ++ [10] ++ decimal attempt)
  let suffix := [45] ++ hexOf hashed
  base.take (maximumName - suffix.length) ++ suffix

/-- The loop of `uniqueLabel`, with a bound. -/
def search (taken : List Str) (base identity : Str) : Nat → Nat → Str → Option Str
  | 0, _, _ => none
  | fuel + 1, attempt, label =>
    if blocked taken label then search taken base identity fuel (attempt + 1) (suffixed base identity attempt)
    else some label

/-- How many labels the loop tries before the specification gives up. -/
def fuel : Nat := 4096

/-- `uniqueLabel`: the label of a step's variant, given the labels taken so far. -/
def uniqueLabel (taken : List Str) (id : Str) (variant : Variant) : Option Str :=
  let base := slug id ++ variantSuffix variant
  search taken base (id ++ [10] ++ variantKey variant) fuel 0 base

/-- The labels of a batch of steps, each taken before the next is chosen. -/
def allocateFrom : List Str → List (Str × Variant) → Option (List Str)
  | _, [] => some []
  | taken, step :: rest =>
    match uniqueLabel taken step.1 step.2 with
    | none => none
    | some label =>
      match allocateFrom (lowerStr label :: taken) rest with
      | none => none
      | some labels => some (label :: labels)

/-- The labels `planSteps` gives a batch of steps, in the order it reaches them. -/
def allocate (batch : List (Str × Variant)) : Option (List Str) := allocateFrom reserved batch

end GenerateApplySpec.Labels

import CapabilitySpec.Pattern

/-!
# Ordered policy rules

Matching rules are last-match-wins across every ruleset and the default is `ask`. The first ruleset is the configured
policy: its own last match, when it is `deny`, is a veto no later ruleset lifts. A request the matcher cannot decide
is `deny`.
-/

namespace CapabilitySpec

inductive Effect where
  | allow | deny | ask
  deriving DecidableEq, Repr

structure Rule where
  effect : Effect
  pattern : Pattern
  deriving DecidableEq, Repr

/-- The wide reading a `deny` or an `ask` takes: the rule selects any form of the resource. -/
def restricts (rule : Rule) (capability : Capability) (texts : List Text) : Bool :=
  rule.pattern.action.selects capability.action && texts.any (matchesResource rule.pattern.resource)

/-- Private network access is opt-in: an `allow` reaches it only by naming `net:private` exactly. -/
def skipped (rule : Rule) (capability : Capability) : Bool :=
  capability.action = .netPrivate ∧ rule.effect = .allow ∧ rule.pattern.action ≠ .exact .netPrivate

/-- The rule decides this request. An `allow` must select every form; a `deny` or `ask` any form. -/
def applies (capability : Capability) (texts : List Text) (rule : Rule) : Bool :=
  !skipped rule capability &&
    (if rule.effect = .allow then selected rule.pattern capability else restricts rule capability texts)

/-- The effect of the last rule that applies, starting from `start`. -/
def lastEffect (capability : Capability) (texts : List Text) (start : Effect) (rules : List Rule) : Effect :=
  rules.foldl (fun effect rule => if applies capability texts rule then rule.effect else effect) start

/-- `evaluate`. -/
def evaluate (rulesets : List (List Rule)) (capability : Capability) : Effect :=
  match forms (.exact capability.action) capability.resource with
  | none => .deny
  | some texts =>
    if rulesets.flatten.any (fun rule => !withinMatchBudget rule.pattern capability) then .deny
    else if lastEffect capability texts .ask (rulesets.headD []) = .deny then .deny
    else lastEffect capability texts .ask rulesets.flatten

end CapabilitySpec

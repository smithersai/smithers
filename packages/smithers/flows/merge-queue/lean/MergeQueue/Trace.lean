import MergeQueue.Policy
import MergeQueue.Predict

/-!
# The trace format

The reference binary and the TypeScript kernel both read this format and print
this rendering. The differential tests compare the two outputs line by line,
so the rendering shows every field of the state and everything the policy
derives from it.

Input, one item per line:

```
config required=1,2 maxAttempts=2 maxBatch=4 maxRuns=2 window=5 defaultDuration=60
enqueue <id> <priority>
withdraw <id>
result <run> <check> pass|fail <duration>
fixed <id> <attempt>
gaveup <id> <attempt> <detail to end of line>
foreign <id>
start <count>
push <run>
probe <id>
land <run>
blame <run>
cancel <run>
plan
```

`plan` applies the policy's next decision, if it has one.
-/

namespace MergeQueue.Trace

def list (xs : List String) : String := ",".intercalate xs

def part (p : Part) : String := s!"{p.id}.{p.rev}"

def tree (t : Tree) : String := list (t.map part)

def verdict : Verdict → String
  | .pass => "p"
  | .fail => "f"

def results (rs : List (CheckId × Verdict)) : String :=
  list (rs.map fun r => s!"{r.1}{verdict r.2}")

def checks (cs : List CheckId) : String := "+".intercalate (cs.map toString)

def reasonKind : ReasonKind → String
  | .attemptsExhausted => "attemptsExhausted"
  | .agentVerdict => "agentVerdict"

def status : Status → String
  | .queued => "queued"
  | .fixing run => s!"fixing({run})"
  | .merged => "merged"
  | .unmergeable r => s!"unmergeable({reasonKind r.kind};{checks r.failures};{r.attempts};{r.detail})"
  | .withdrawn => "withdrawn"

def change (c : Change) : String :=
  s!"{c.id}:p{c.priority}:s{c.seq}:r{c.rev}:a{c.attempts}:{status c.status}"

def run (r : Run) : String := s!"{r.id}:{tree r.base}/{tree r.batch}:{results r.results}"

def landing (l : Landing) : String :=
  if l.foreign then s!"foreign:{tree l.base}/{tree l.batch}" else s!"{l.run}:{tree l.base}/{tree l.batch}:{results l.results}"

def event : Event → String
  | .enqueue id priority => s!"enqueue {id} {priority}"
  | .withdraw id => s!"withdraw {id}"
  | .result r check v duration => s!"result {r} {check} {match v with | .pass => "pass" | .fail => "fail"} {duration}"
  | .fixed id attempt => s!"fixed {id} {attempt}"
  | .gaveUp id attempt detail => s!"gaveup {id} {attempt} {detail}"
  | .foreign id => s!"foreign {id}"
  | .push r => s!"push {r}"
  | .probe id => s!"probe {id}"
  | .start count => s!"start {count}"
  | .land r => s!"land {r}"
  | .blame r => s!"blame {r}"
  | .cancel r => s!"cancel {r}"

def brief (b : FixBrief) : String :=
  let ahead := "+".intercalate (b.ahead.map fun a => s!"{a.id}{if a.fixing then "f" else "q"}")
  s!"{b.id}.{b.rev}#{b.attempt}:{checks b.failures}:{ahead}"

/-- One line for the whole state and everything derived from it. -/
def state (cfg : Config) (s : State) : String :=
  let planned := match plan cfg s with
    | some e => event e
    | none => "wait"
  let ci := list ((s.runs.filter (s.wantsCi cfg)).map fun r =>
    s!"{r.id}@{eta cfg s.history r.results}:{checks (remaining cfg s.history r.results)}")
  " | ".intercalate
    [ s!"main={tree s.main}",
      s!"changes={";".intercalate (s.changes.map change)}",
      s!"runs={";".intercalate (s.runs.map run)}",
      s!"next={s.nextRun},{s.nextSeq}",
      s!"pushing={match s.pushing with | some r => toString r | none => "-"}",
      s!"landed={";".intercalate (s.landed.map landing)}",
      s!"history={list (s.history.map fun h => s!"{h.1}:{h.2}")}",
      s!"ready={list (s.ready.map fun c => toString c.id)}",
      s!"plan={planned}",
      s!"ci={ci}",
      s!"fix={";".intercalate (s.fixBriefs.map brief)}" ]

/-! ## Reading -/

def nats (text : String) : Option (List Nat) :=
  if text = "" then some [] else (text.splitOn ",").mapM String.toNat?

def setting (cfg : Config) (item : String) : Option Config :=
  match item.splitOn "=" with
  | ["required", v] => (nats v).map fun r => { cfg with required := r }
  | ["maxAttempts", v] => v.toNat?.map fun n => { cfg with maxAttempts := n }
  | ["maxBatch", v] => v.toNat?.map fun n => { cfg with maxBatch := n }
  | ["maxRuns", v] => v.toNat?.map fun n => { cfg with maxRuns := n }
  | ["window", v] => v.toNat?.map fun n => { cfg with window := n }
  | ["defaultDuration", v] => v.toNat?.map fun n => { cfg with defaultDuration := n }
  | _ => none

def config (words : List String) : Option Config :=
  words.foldlM setting
    { required := [], maxAttempts := 0, maxBatch := 1, maxRuns := 1, window := 1, defaultDuration := 0 }

/-- One input line: a new config, an event, or `plan`. -/
inductive Line where
  | config (cfg : Config)
  | event (e : Event)
  | plan

def line (text : String) : Option Line :=
  match text.splitOn " " with
  | "config" :: words => (config words).map .config
  | ["enqueue", id, priority] => do pure (.event (.enqueue (← id.toNat?) (← priority.toNat?)))
  | ["withdraw", id] => do pure (.event (.withdraw (← id.toNat?)))
  | ["result", r, check, "pass", d] => do pure (.event (.result (← r.toNat?) (← check.toNat?) .pass (← d.toNat?)))
  | ["result", r, check, "fail", d] => do pure (.event (.result (← r.toNat?) (← check.toNat?) .fail (← d.toNat?)))
  | ["fixed", id, attempt] => do pure (.event (.fixed (← id.toNat?) (← attempt.toNat?)))
  | "gaveup" :: id :: attempt :: detail =>
    do pure (.event (.gaveUp (← id.toNat?) (← attempt.toNat?) (" ".intercalate detail)))
  | ["foreign", id] => do pure (.event (.foreign (← id.toNat?)))
  | ["push", r] => do pure (.event (.push (← r.toNat?)))
  | ["probe", id] => do pure (.event (.probe (← id.toNat?)))
  | ["start", count] => do pure (.event (.start (← count.toNat?)))
  | ["land", r] => do pure (.event (.land (← r.toNat?)))
  | ["blame", r] => do pure (.event (.blame (← r.toNat?)))
  | ["cancel", r] => do pure (.event (.cancel (← r.toNat?)))
  | ["plan"] => some .plan
  | _ => none

/-- Run one line. A `config` line restarts the queue from empty. -/
def apply (cfg : Config) (s : State) : Line → Config × State
  | .config next => (next, State.empty)
  | .event e => (cfg, step cfg s e)
  | .plan =>
    match MergeQueue.plan cfg s with
    | some e => (cfg, step cfg s e)
    | none => (cfg, s)

end MergeQueue.Trace

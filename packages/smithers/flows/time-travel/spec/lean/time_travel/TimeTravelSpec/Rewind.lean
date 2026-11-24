import TimeTravelSpec.Lineage

/-!
# Rewind: archive and truncate

`archiveAndTruncate` of the memory store. A rewind of `root` to frame `seq` removes the root's records above the
frame and every record of an attached descendant, archives what it removed under the generation each run had, and
then advances the generation of every run it truncated. It commits only while the caller still owns the root and
every attached descendant that is not finished.
-/

namespace TimeTravelSpec

/-- A record the rewind removes. -/
def dead (root : String) (seq : Nat) (ids : List String) (record : Record) : Bool :=
  (decide (record.run = root) && decide (seq < record.seq)) || ids.contains record.run

/-- The state after the rewind commits. -/
def truncate (s : State) (root : String) (seq : Nat) : State :=
  let ids := attachedIds s.edges root seq
  let doomed := s.records.filter (dead root seq ids)
  { s with
    records := s.records.filter (fun record => !dead root seq ids record)
    archived := s.archived ++ doomed.map (fun record => (record, s.generation record.run))
    bumps := s.bumps ++ root :: ids
    edges := s.edges.filter (fun edge => !ids.contains edge.child) }

/-- An attached child is safe to truncate: it is unknown, finished, or owned by the caller's claim on it. -/
def fenced (s : State) (childOwners : List (String × Owner)) (child : String) : Bool :=
  match lookup child s.statuses with
  | none => true
  | some true => true
  | some false =>
    match lookup child childOwners, lookup child s.owners with
    | some expected, some actual => decide (expected = actual)
    | _, _ => false

structure Rewound where
  state : State
  /-- How many records were archived. -/
  archived : Nat
  /-- The detached descendants the rewind crossed and left alone. -/
  orphaned : List Edge

def rewind (s : State) (root lineage : String) (seq : Nat) (owner : Owner) (childOwners : List (String × Owner)) :
    Except String Rewound :=
  if lineage = "" then .error "invalid"
  else if lookup root s.owners ≠ some owner then .error "fence_lost"
  else if !(attachedIds s.edges root seq).all (fenced s childOwners) then .error "fence_lost"
  else
    .ok {
      state := truncate s root seq
      archived := (s.records.filter (dead root seq (attachedIds s.edges root seq))).length
      orphaned := (descendants s.edges root seq).detached }

/-- Whether the archive holds a record of `run` at `seq`, in any generation or in exactly one. -/
def archivedAt (s : State) (run : String) (seq : Nat) (generation : Option Nat) : Bool :=
  s.archived.any (fun entry =>
    decide (entry.1.run = run) && decide (entry.1.seq = seq) &&
      (match generation with
        | none => true
        | some wanted => decide (entry.2 = wanted)))

end TimeTravelSpec

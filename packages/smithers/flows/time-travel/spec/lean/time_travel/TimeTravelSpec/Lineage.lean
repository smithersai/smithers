import TimeTravelSpec.Basic

/-!
# The descendants a rewind crosses

`src/internal/LineageTree.ts`. Only the root's edges above the frame start the walk. Attached children are walked
transitively; a detached child is reported and its subtree is not walked. One child is one descendant, and the root
is never its own descendant.
-/

namespace TimeTravelSpec

structure Walk where
  attached : List Edge
  detached : List Edge
  /-- The attached children whose own edges are still to be read. -/
  queue : List String

def Walk.empty : Walk := { attached := [], detached := [], queue := [] }

/-- Reports one edge's child, once, unless the child is the root. -/
def visit (root : String) (walk : Walk) (edge : Edge) : Walk :=
  if edge.child = root then walk
  else if edge.attached then
    if walk.attached.any (fun seen => decide (seen.child = edge.child)) then walk
    else { walk with attached := walk.attached ++ [edge], queue := walk.queue ++ [edge.child] }
  else if walk.detached.any (fun seen => decide (seen.child = edge.child)) then walk
  else { walk with detached := walk.detached ++ [edge] }

/--
Reads the edges of each queued child in turn, for at most `fuel` turns. A child is queued once, so a walk queues at
most one child per edge; the oracle reports whether the queue was drained, and the differential test requires it.
-/
def drain (edges : List Edge) (root : String) : Nat → Walk → Walk
  | 0, walk => walk
  | fuel + 1, walk =>
    match walk.queue with
    | [] => walk
    | parent :: rest =>
      drain edges root fuel
        ((edges.filter (fun edge => decide (edge.parent = parent))).foldl (visit root) { walk with queue := rest })

/-- The root's own edges above the frame. -/
def crossed (edges : List Edge) (root : String) (seq : Nat) : List Edge :=
  edges.filter (fun edge => decide (edge.parent = root) && decide (seq < edge.parentSeq))

def descendants (edges : List Edge) (root : String) (seq : Nat) : Walk :=
  drain edges root (edges.length + 1) ((crossed edges root seq).foldl (visit root) Walk.empty)

/-- The runs a rewind of `root` to `seq` truncates besides the root. -/
def attachedIds (edges : List Edge) (root : String) (seq : Nat) : List String :=
  (descendants edges root seq).attached.map (·.child)

end TimeTravelSpec

/-
Reference specification of the two graph walks the plan is made from: Turborepo's task graph
(`packages/ci/src/decompose/Turbo.vibe`, `walk`) and the order the jobs of one working tree run in
(`packages/ci/src/contract/Inventory.vibe`, `treeOrder`), with the two sets of steps `Plan.vibe` derives from that
order (`followed`, `preceded`).
-/
import DecomposeSpec.Workspace

namespace DecomposeSpec

open Text
open Workspace (Package search unseenCount unseenCount_lt)

/-- True when a literal path would be interpreted as glob syntax. -/
def globMagic (path : Str) : Bool :=
  path.any (fun char => "*?[]{}\\".toList.contains char) ||
    ["@(", "+(", "!("].any (fun marker => contains marker.toList path) ||
    path.head? = some '!' || path.head? = some '#'

namespace Turbo

/-- One task definition, reduced to what the splitter reads. -/
structure Task where
  dependsOn : List Str
  inputs : List Str
  extendsDependsOn : Bool
  companions : List Str
  extendsCompanions : Bool
  extendsInputs : Bool
  deriving DecidableEq, Repr

/-- The root configuration's tasks and each package's own, keyed by package name. -/
structure Config where
  tasks : List (Str × Task)
  packages : List (Str × List (Str × Task))

/-- What running tasks for one package through Turborepo reaches. -/
structure Walk where
  /-- The packages whose scripts run, by name. -/
  packages : List Str
  /-- Each script that runs: its package and its name. -/
  scripts : List (Str × Str)
  globs : List Str
  /-- True when a task of the root package runs. -/
  root : Bool
  deriving DecidableEq, Repr

def rootMarker : Str := "$TURBO_ROOT$/".toList

/-- Rooted or escaping positive inputs widen the package's read set. Keep glob syntax before traversal so
joining the path does not hide a wildcard the planner cannot represent. -/
def extraInput (directory input : Str) : Option Str := do
  if input.head? = some '!' then none else
    let rooted := dropPrefix rootMarker input
    let relative := rooted.getD input
    let parent := (splitOn '/' relative).reverse.span (· ≠ "..".toList)
    let glob ← match parent.2 with
      | _ :: before =>
        if globMagic (joinWith "/".toList before.reverse) then some relative
        else Workspace.join (if rooted.isSome then [] else directory) relative
      | [] => if rooted.isSome then Workspace.join [] relative else none
    if glob.isEmpty then none else some glob

/-- The definition Turborepo uses for one package's task: the package's own file, then the root's `package#task`,
then the root's `task`. -/
def definitionOf (config : Config) (owner task : Str) : Option Task :=
  let root := (config.tasks.lookup (owner ++ '#' :: task)).orElse fun _ => config.tasks.lookup task
  match (config.packages.lookup owner).bind (·.lookup task) with
  | none => root
  | some own =>
    some {
      dependsOn := (if own.extendsDependsOn then (root.map (·.dependsOn)).getD [] else []) ++ own.dependsOn
      inputs := (if own.extendsInputs then (root.map (·.inputs)).getD [] else []) ++ own.inputs
      companions := (if own.extendsCompanions then (root.map (·.companions)).getD [] else []) ++ own.companions
      extendsCompanions := false
      extendsDependsOn := false
      extendsInputs := false
    }

/-- The text before the first `#` and the text after it, when there is one. -/
def splitHash (entry : Str) : Option (Str × Str) :=
  match entry.span (· ≠ '#') with
  | (before, _ :: after) => some (before, after)
  | _ => none

/-- A task of one package: what the walk goes through. -/
abbrev Node := Str × Str

def named (packages : List Package) (name : Str) : Option Package := packages.reverse.find? (·.name = name)

/-- The tasks one `dependsOn` entry of a package's task names: `task` stays in the package, `^task` goes to each
package it declares, and `package#task` names its package. `//#task` is the root package's, which is not walked. -/
def entryTargets (packages : List Package) (owner : Package) (entry : Str) : List Node :=
  match entry with
  | '^' :: task => (owner.dependencies.filterMap (named packages)).map fun dependency => (dependency.name, task)
  | _ =>
    match splitHash entry with
    | none => [(owner.name, entry)]
    | some (name, task) =>
      if "//#".toList.isPrefixOf entry then []
      else match named packages name with
        | some target => [(target.name, task)]
        | none => []

/-- True when an entry names a task of the root package. -/
def namesRoot (entry : Str) : Bool := entry.head? ≠ some '^' && "//#".toList.isPrefixOf entry

def edges (config : Config) (packages : List Package) : Node → List Node
  | (owner, task) =>
    match named packages owner, definitionOf config owner task with
    | some package, some definition => (definition.dependsOn ++ definition.companions).flatMap (entryTargets packages package)
    | _, _ => []

/-- Every task name a walk can come to: those it starts from and those a `dependsOn` entry names. -/
def taskNames (config : Config) (tasks : List Str) : List Str :=
  let named := fun (definitions : List (Str × Task)) =>
    definitions.flatMap fun (_, task) => (task.dependsOn ++ task.companions).flatMap fun entry =>
      match entry with
      | '^' :: task => [task]
      | _ => match splitHash entry with
        | none => [entry]
        | some (_, task) => [task]
  tasks ++ named config.tasks ++ config.packages.flatMap fun (_, own) => named own

/-- Follows `dependsOn` from the given tasks of one package, to a fixed point. A task whose package has no script
of that name runs nothing, and its own `dependsOn` is still followed. Only a task that runs reads its inputs: one
under `$TURBO_ROOT$/` is read from the root, and one that starts with `../` from the package's directory. -/
def walk (config : Config) (packages : List Package) (start : Str) (tasks : List Str) : Walk :=
  let names := taskNames config tasks
  let domain : List Node := (start :: packages.map (·.name)).flatMap fun name => names.map fun task => (name, task)
  -- The implementation takes the last task first.
  let visited := search domain (edges config packages) (tasks.reverse.map fun task => (start, task)) []
  let defined : List (Package × Str × Task) := visited.filterMap fun (owner, task) =>
    match named packages owner, definitionOf config owner task with
    | some package, some definition => some (package, task, definition)
    | _, _ => none
  let running := defined.filter fun (package, task, _) => package.scripts.contains task
  let globs := running.flatMap fun (package, _, definition) => definition.inputs.filterMap (extraInput package.directory)
  {
    packages := distinct (running.map (·.1.name))
    scripts := running.map fun (package, task, _) => (package.name, task)
    globs := jsSort (distinct globs)
    root := defined.any fun (_, _, definition) => (definition.dependsOn ++ definition.companions).any namesRoot
  }

end Turbo

namespace Plan

/-- The joint ends the preceding AND-OR chain. -/
def separates : Shell.Joint → Bool
  | .first | .semi => true
  | _ => false

/-- A directory change can be followed in a straight list or immediately after a `cd` in an AND chain. An
OR arm after a `cd` may run either in the old or new directory. This tracks directories only. -/
def directoryList : List Shell.Command → Str → Bool → Bool → Option (List (Shell.Command × Str))
  | [], _, _, _ => some []
  | command :: rest, cwd, previousCd, chainHasCd => do
    if chainHasCd && command.joint = .or then none else
      let separator := separates command.joint
      if command.words.head?.map (·.text) = some "cd".toList then
        match command.words with
        | [head, path] =>
          if (separator || (previousCd && command.joint = .and)) && head.literal && path.literal &&
              !command.conditional && !command.piped && !command.background && command.joint ≠ .pipe &&
              path.text.head? ≠ some '/' && path.text.head? ≠ some '~' && path.text ≠ ['-'] then
            let next ← Workspace.join cwd path.text
            directoryList rest next true true
          else none
        | _ => none
      else ((command, cwd) :: ·) <$> directoryList rest cwd false (chainHasCd && !separator)

def everything : Str := "**".toList

def stripSuffix (suffix path : Str) : Option Str := (dropPrefix suffix.reverse path.reverse).map List.reverse

/-- A contract glob is `*`, `**`, a literal repository path, or such a path with a final `/*` or `/**`. -/
def contractGlob (glob : Str) : Bool :=
  if glob = ['*'] || glob = everything then true else
    let path := ((stripSuffix "/**".toList glob).orElse (fun _ => stripSuffix "/*".toList glob)).getD glob
    !path.isEmpty && !globMagic path && Workspace.join [] path = some path

/-- Combines the reached package directories, single files, and the extra globs with the inputs outside the
workspace packages. An unrepresentable input widens the read set to the whole tree. -/
def inputsOf (outside : List Str) (reaches : List Workspace.Reach) (globs : List Str) : List Str :=
  let directories := reaches.flatMap (·.packages)
  let files := reaches.flatMap (·.files)
  if outside.contains everything || globs.contains everything || globs.any (!contractGlob ·) ||
      (directories ++ files).any globMagic then [everything]
  else
    let whole := (outside.filter fun glob => (stripSuffix "/**".toList glob).isSome) ++
      directories.map (· ++ "/**".toList)
    let covered := fun path => whole.any fun glob => glob ≠ path && (glob.take (glob.length - 2)).isPrefixOf path
    jsSort ((distinct (outside ++ whole ++ files ++ globs)).filter (!covered ·))

/-- One CI job, by what the order is computed from. `tree` is the working tree it shares with the jobs that name
the same one, or `none` for a job that gets a checkout of its own, as a GitHub Actions job does. -/
structure Job where
  id : Str
  needs : List Str
  tree : Option Str
  /-- True for a GitHub Actions job. -/
  github : Bool := false
  /-- How many steps it has. -/
  steps : Nat := 0
  deriving DecidableEq, Repr

/-- What the run has left to do: go into a job, or list a job whose needs are all done. -/
inductive Frame where
  | visit (job : Job) (tree : Str)
  | emit (job : Job) (tree : Str)
  deriving DecidableEq, Repr

/-- The job with an id. A later job of the same id stands for it, as in a `Map`. -/
def byId (jobs : List Job) (id : Str) : Option Job := jobs.reverse.find? (·.id = id)

/-- The needs of a job that run in its tree, in the order it lists them. -/
def needsIn (jobs : List Job) (job : Job) (tree : Str) : List Job :=
  job.needs.filterMap fun id =>
    match byId jobs id with
    | some need => if need.tree = some tree then some need else none
    | none => none

/-- Runs the frames: a job not yet seen is marked, then its needs are gone into, then it is listed. The jobs come
out in the order they are listed, each with its tree. A job is gone into once, so a cycle ends. -/
def run (jobs : List Job) (stack : List Frame) (seen : List Str) (out : List (Str × Job)) : List (Str × Job) :=
  match stack with
  | [] => out.reverse
  | .emit job tree :: rest => run jobs rest seen ((tree, job) :: out)
  | .visit job tree :: rest =>
    if job.id ∈ seen then run jobs rest seen out
    else if _ : job.id ∈ jobs.map (·.id) then
      run jobs ((needsIn jobs job tree).map (Frame.visit · tree) ++ .emit job tree :: rest) (job.id :: seen) out
    else run jobs rest seen out
termination_by (unseenCount (jobs.map (·.id)) seen, stack.length)
decreasing_by
  · exact Prod.Lex.right _ (by simp)
  · exact Prod.Lex.right _ (by simp)
  · exact Prod.Lex.left _ _ (unseenCount_lt _ seen job.id (by assumption) (by assumption))
  · exact Prod.Lex.right _ (by simp)

/-- Where a run starts: at the jobs no other job needs, then at every job, so the jobs of a cycle run too. -/
def starts (jobs : List Job) : List Frame :=
  let needed := jobs.flatMap (·.needs)
  (jobs.filter (fun job => !needed.contains job.id) ++ jobs).filterMap fun job =>
    job.tree.map (Frame.visit job ·)

/-- The jobs of every shared tree in the order they run, each with its tree. -/
def listed (jobs : List Job) : List (Str × Job) := run jobs (starts jobs) [] []

/-- The order the jobs of each shared tree run in, by job id: what a job needs in the order it lists them, each
job once, then the job. The trees come in the order their first job is listed. -/
def treeOrder (jobs : List Job) : List (Str × List Str) :=
  let all := listed jobs
  (distinct (all.map (·.1))).map fun tree => (tree, (all.filter (·.1 = tree)).map (·.2.id))

/-- Where a job stands in the run of its working tree, given the order of every tree: first, last, both for a job
with a checkout of its own. -/
def placeOf (order : List (Str × List Str)) (job : Job) : Bool × Bool :=
  match order.find? (·.2.contains job.id) with
  | some (_, ids) => (ids.head? = some job.id, ids.getLast? = some job.id)
  | none => (true, true)

/-- The steps a later step relies on, each by its job's place in the list and its own place in the job: every
step but a job's last, and the last step of a job that another job runs after in the same working tree. -/
def followed (jobs : List Job) : List (Nat × Nat) :=
  let order := treeOrder jobs
  jobs.zipIdx.flatMap fun (job, index) =>
    let needed := !(placeOf order job).2 || jobs.any fun other => !other.github && other.needs.contains job.id
    ((List.range job.steps).filter fun step => needed || step + 1 < job.steps).map (index, ·)

/-- The steps that follow another step in one working tree: every step but a job's first, and every step of a job
that runs after another in a tree they share. -/
def preceded (jobs : List Job) : List (Nat × Nat) :=
  let order := treeOrder jobs
  jobs.zipIdx.flatMap fun (job, index) =>
    let after := !(placeOf order job).1 || (!job.github && !job.needs.isEmpty)
    ((List.range job.steps).filter fun step => after || step > 0).map (index, ·)

end Plan
end DecomposeSpec

/-
The oracle: reads one JSON request per line from standard input, answers it with the reference specification, and
writes one JSON response per line to standard output, `{"ok": …}` or `{"error": "…"}`.

Everything here only carries values between JSON and the specification. A `package.json` arrives parsed, as the
JSON value `JSON.parse` gave; `manifestOf` takes from it what `Script.decide` reads.
-/
import Lean.Data.Json
import DecomposeSpec

open Lean (Json toJson)
open DecomposeSpec

abbrev Decode := Except String

def text (value : Str) : Json := Json.str (String.ofList value)

def texts (values : List Str) : Json := Json.arr (values.map text).toArray

def list (values : List Json) : Json := Json.arr values.toArray

def orNull (encode : α → Json) : Option α → Json
  | some value => encode value
  | none => Json.null

def asText (value : Json) : Decode Str := do return (← value.getStr?).toList

def asList (decode : Json → Decode α) (value : Json) : Decode (List α) := do (← value.getArr?).toList.mapM decode

def asPair (first : Json → Decode α) (second : Json → Decode β) (value : Json) : Decode (α × β) := do
  match (← value.getArr?).toList with
  | [left, right] => return (← first left, ← second right)
  | _ => throw "a pair expected"

def field (decode : Json → Decode α) (value : Json) (key : String) : Decode α := do decode (← value.getObjVal? key)

/-- A field that may be absent or `null`. -/
def fieldOptional (decode : Json → Decode α) (value : Json) (key : String) : Decode (Option α) :=
  match value.getObjVal? key with
  | .ok Json.null => pure none
  | .ok found => some <$> decode found
  | .error _ => pure none

/-! ## Shell -/

def jointText : Shell.Joint → String
  | .first => "first"
  | .semi => ";"
  | .and => "&&"
  | .or => "||"
  | .pipe => "|"
  | .amp => "&"

def wordJson (word : Shell.Word) : Json :=
  Json.mkObj [("text", text word.text), ("literal", Json.bool word.literal)]

def commandJson (script : Str) (command : Shell.Command) : Json :=
  let offset := orNull fun (place : Nat) => toJson (Text.utf16Offset script place)
  Json.mkObj [
    ("assignments", list (command.assignments.map fun (name, value) => list [text name, wordJson value])),
    ("words", list (command.words.map wordJson)),
    ("start", offset command.start),
    ("end", offset command.stop),
    ("joint", Json.str (jointText command.joint)),
    ("piped", Json.bool command.piped),
    ("background", Json.bool command.background),
    ("conditional", Json.bool command.conditional)
  ]

/-! ## Script -/

/-- The own entries of a JSON value that hold text, by name: an object's, and an array's by index. -/
def textEntries : Json → Script.Scripts
  | .obj entries =>
    entries.foldl (init := []) fun out key value =>
      match value with
      | .str body => out ++ [(key.toList, body.toList)]
      | _ => out
  | .arr items =>
    items.toList.zipIdx.filterMap fun (value, index) =>
      match value with
      | .str body => some ((toString index).toList, body.toList)
      | _ => none
  | _ => []

/-- What `Script.decide` reads of a parsed `package.json`; `none` when the value is not a JSON object. -/
def manifestOf : Json → Option Script.Manifest
  | .obj entries =>
    let scripts := (entries.get? "scripts").map textEntries
    let manager := match entries.get? "packageManager" with
      | some (.str name) => some name.toList
      | _ => none
    some (scripts.getD [], manager)
  | _ => none

def asFile : Json → Decode Script.File
  | Json.null => pure .unreadable
  | value => do
    let body ← field asText value "text"
    let manifest := match value.getObjVal? "json" with
      | .ok parsed => manifestOf parsed
      | .error _ => none
    return .readable body manifest

def asStep (request : Json) : Decode Script.Step := do
  return {
    command := ← field asText request "command"
    cwd := ← field asText request "cwd"
    env := ← field (asList asText) request "env"
    runner := ← fieldOptional asText request "runner"
    leads := ← field (·.getBool?) request "leads"
  }

def decisionJson : Script.Decision → Json
  | .none => Json.mkObj [("kind", "none")]
  | .whole feature detail =>
    Json.mkObj [("kind", "whole"), ("why", Json.mkObj [("feature", Json.str feature), ("detail", text detail)])]
  | .links links =>
    Json.mkObj [("kind", "links"),
      ("links", list (links.map fun (name, command) => Json.mkObj [("name", text name), ("command", text command)]))]

/-! ## Workspace, Turbo and Plan -/

def asPackage (value : Json) : Decode Workspace.Package := do
  return {
    name := ← field asText value "name"
    directory := ← field asText value "directory"
    dependencies := ← field (asList asText) value "dependencies"
    scripts := ← field (asList asText) value "scripts"
  }

def asMentions (value : Json) : Decode Workspace.Mentions := do
  return {
    names := ← field (asList asText) value "names"
    relative := ← field (asList asText) value "relative"
    rooted := ← field (asList asText) value "rooted"
  }

def asNode (value : Json) : Decode Workspace.Node := do
  match ← fieldOptional asText value "package" with
  | some name => return .package name
  | none => return .file (← field asText value "file")

def asTask (value : Json) : Decode Turbo.Task := do
  return {
    dependsOn := ← field (asList asText) value "dependsOn"
    inputs := ← field (asList asText) value "inputs"
    companions := ← field (asList asText) value "companions"
    extendsCompanions := ← field (·.getBool?) value "extendsCompanions"
    extendsDependsOn := ← field (·.getBool?) value "extendsDependsOn"
    extendsInputs := ← field (·.getBool?) value "extendsInputs"
  }

def asConfig (value : Json) : Decode Turbo.Config := do
  let tasks := asList (asPair asText asTask)
  return { tasks := ← field tasks value "tasks", packages := ← field (asList (asPair asText tasks)) value "packages" }

def asJob (value : Json) : Decode Plan.Job := do
  let github ← field (·.getBool?) value "github"
  let file ← field asText value "file"
  return {
    id := ← field asText value "id"
    needs := ← field (asList asText) value "needs"
    tree := if github then none else some file
    github
    steps := ← field (·.getNat?) value "steps"
  }

def places (found : List (Nat × Nat)) : Json := list (found.map fun (job, step) => list [toJson job, toJson step])

/-! ## Requests -/

def answer (request : Json) : Decode Json := do
  match ← field (·.getStr?) request "op" with
  | "echo" => return text (← field asText request "text")
  | "shell.quote" => return text (Shell.quote (← field asText request "word"))
  | "shell.commands" =>
    let script ← field asText request "script"
    return orNull (fun found => list (found.map (commandJson script))) (Shell.commands script)
  | "script.commands" =>
    return Json.mkObj [
      ("pnpm", texts Script.pnpmCommands), ("yarn", texts Script.yarnCommands),
      ("pnpmOwn", texts Script.pnpmOwnCommands), ("yarnOwn", texts Script.yarnOwnCommands)]
  | "script.runOf" =>
    let run := Script.runOf (← field (asList asText) request "words")
    return orNull (fun (run : Script.Run) => Json.mkObj [
      ("manager", text run.manager.name), ("script", text run.script), ("rest", texts run.rest)]) run
  | "script.filesOf" =>
    return texts (Script.filesOf (← field asText request "command") (← field asText request "cwd"))
  | "script.decide" =>
    let files ← field (asList (asPair asText asFile)) request "files"
    return decisionJson (Script.decide (← asStep request) files)
  | "workspace.join" =>
    return orNull text (Workspace.join (← field asText request "directory") (← field asText request "relative"))
  | "workspace.packageDirectories" =>
    return orNull texts (Workspace.packageDirectories (← field (asList asText) request "patterns")
      (← field (asList asText) request "files"))
  | "workspace.resolveFile" =>
    return orNull text (Workspace.resolveFile (← field asText request "path")
      (← field (asList asText) request "files"))
  | "workspace.reach" =>
    let facts : Workspace.Facts := {
      packages := ← field (asList asPackage) request "packages"
      files := ← field (asList asText) request "files"
      mentions := ← field (asList (asPair asText asMentions)) request "mentions"
      unknown := (← fieldOptional (asList asText) request "unknown").getD []
    }
    let reach := facts.reachOf (← field asNode request "start")
    let owner := match ← fieldOptional asText request "owner" with
      | some path => orNull text ((facts.ownerOf path).map (·.name))
      | none => Json.null
    return Json.mkObj [("packages", texts reach.packages), ("files", texts reach.files), ("owner", owner)]
  | "turbo.walk" =>
    let walk := Turbo.walk (← field asConfig request "config") (← field (asList asPackage) request "packages")
      (← field asText request "start") (← field (asList asText) request "tasks")
    return Json.mkObj [
      ("packages", texts walk.packages),
      ("scripts", list (walk.scripts.map fun (owner, script) => texts [owner, script])),
      ("globs", texts walk.globs),
      ("root", Json.bool walk.root)]
  | "plan.treeOrder" =>
    let order := Plan.treeOrder (← field (asList asJob) request "jobs")
    return list (order.map fun (tree, ids) => list [text tree, texts ids])
  | "plan.followed" => return places (Plan.followed (← field (asList asJob) request "jobs"))
  | "plan.preceded" => return places (Plan.preceded (← field (asList asJob) request "jobs"))
  | other => throw s!"unknown op {other}"

partial def serve (input output : IO.FS.Stream) : IO Unit := do
  let line ← input.getLine
  if line.isEmpty then return
  let response :=
    match Json.parse line >>= answer with
    | .ok value => Json.mkObj [("ok", value)]
    | .error problem => Json.mkObj [("error", Json.str problem)]
  output.putStrLn response.compress
  output.flush
  serve input output

def main : IO Unit := do serve (← IO.getStdin) (← IO.getStdout)

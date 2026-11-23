/-
The oracle of the differential tests: one JSON request a line on standard input, one JSON answer a line on
standard output, each answered by the reference specification. A string travels as the array of its UTF-16
code units, so a lone surrogate arrives as it left.
-/
import Lean.Data.Json
import ReportReplaySpec

open Lean ReportReplaySpec

def strOf (json : Json) : Except String Str := do
  (← json.getArr?).toList.mapM fun item => item.getNat?

def strJson (s : Str) : Json := Json.arr (s.toArray.map fun unit => toJson unit)

def natsJson (values : List Nat) : Json := strJson values

def natField (json : Json) (name : String) : Except String Nat := do (← json.getObjVal? name).getNat?

def strField (json : Json) (name : String) : Except String Str := do strOf (← json.getObjVal? name)

/-- A field that may be missing or `null`. -/
def optionalField (json : Json) (name : String) : Option Json :=
  match json.getObjVal? name with
  | .ok .null => none
  | .ok value => some value
  | .error _ => none

def whyText : Why → String
  | .notPlain => "not a plain file"
  | .notNamed => "not a named result"
  | .tooLarge => "larger than a result is"
  | .twice => "listed more than once"

def mismatchOf (json : Json) : Except String Mismatch := do
  let mode ← (← json.getObjVal? "mode").getStr?
  let cause ← match optionalField json "cause" with
    | none => pure none
    | some value => some <$> strOf value
  pure { mode := if mode == "normal" then .normal else .fast, cause }

def commitOf (json : Json) : Except String Commit := do
  pure { mismatches := ← (← json.getArr?).toList.mapM mismatchOf }

def entryOf (json : Json) : Except String ProcessEntry := do
  match ← (← json.getArr?).toList.mapM (·.getNat?) with
  | [pid, parent, cpuMs] => pure { pid, parent, cpuMs }
  | _ => throw "a process entry is [pid, parent, cpuMs]"

def answer (request : Json) : Except String Json := do
  match ← (← request.getObjVal? "op").getStr? with
  | "escape" => pure (strJson (escape (← strField request "s")))
  | "clean" => pure (strJson (clean (← strField request "s")))
  | "duration" => pure (strJson (duration (← natField request "ms")))
  | "times" => pure (strJson (times (← natField request "b") (← natField request "m")))
  | "speedup" => pure (strJson (speedup (← natField request "b") (← natField request "m")))
  | "cpuTime" =>
    let fast ← match optionalField request "f" with
      | none => pure none
      | some value => some <$> value.getNat?
    pure (strJson (cpuTime (← natField request "b") (← natField request "n") fast))
  | "speedupCommits" =>
    let commits ← (← (← request.getObjVal? "commits").getArr?).toList.mapM commitOf
    let declared ← match optionalField request "declared" with
      | none => pure none
      | some value => some <$> value.getNat?
    let report : Report := { commits, declared }
    pure (Json.mkObj [("covered", toJson (speedupCommits report)), ("differs", toJson (normalDiffers report))])
  | "withoutCredentials" => pure (strJson (withoutCredentials (← strField request "s")))
  | "errorLine" => pure (strJson (errorLine (← strField request "s")))
  | "bytesOf" => pure (natsJson (bytesOf (← strField request "s")))
  | "gitQuote" => pure (strJson (gitQuote (← strField request "s")))
  | "treeOf" =>
    let table ← (← (← request.getObjVal? "table").getArr?).toList.mapM entryOf
    let tree := treeOf table (← natField request "root")
    pure (Json.mkObj
      [("cpuMs", toJson tree.cpuMs), ("pids", natsJson tree.pids), ("leaves", natsJson tree.leaves)])
  | "sift" =>
    let sifted := sift (← strField request "s")
    pure (Json.mkObj
      [ ("keep", Json.arr (sifted.keep.toArray.map fun entry =>
          Json.mkObj [("path", strJson entry.path), ("name", strJson entry.name), ("bytes", toJson entry.bytes)])),
        ("drop", Json.arr (sifted.drop.toArray.map fun dropped =>
          Json.mkObj [("path", strJson dropped.path), ("why", Json.str (whyText dropped.why))])) ])
  | other => throw s!"no such op: {other}"

partial def serve (input output : IO.FS.Stream) : IO Unit := do
  let line ← input.getLine
  if line.isEmpty then return
  let reply := match Json.parse line >>= answer with
    | .ok value => Json.mkObj [("ok", value)]
    | .error message => Json.mkObj [("error", Json.str message)]
  output.putStrLn reply.compress
  output.flush
  serve input output

def main : IO Unit := do serve (← IO.getStdin) (← IO.getStdout)

import Lean.Data.Json
import CronSpec

/-!
# The oracle: the specification over JSON lines

Reads one JSON request per line from standard input and writes one JSON response per line to standard output, so a
test starts the program once and asks it thousands of questions. A request is `{"op": …, …}`; the response is
`{"ok": …}` or `{"error": …}`.

An expression is a JSON string. A schedule is an object of its six sets and its `and` flag. An instant is a whole
number of milliseconds from the epoch, and an absent occurrence is `null`.
-/

open Lean CronSpec

abbrev Decode := Except String

def field (json : Json) (name : String) : Decode Json := json.getObjVal? name

def nats (json : Json) : Decode (List Nat) := do
  (← json.getArr?).toList.mapM Json.getNat?

def cronOf (json : Json) : Decode Cron := do
  pure {
    seconds := ← nats (← field json "seconds")
    minutes := ← nats (← field json "minutes")
    hours := ← nats (← field json "hours")
    days := ← nats (← field json "days")
    months := ← nats (← field json "months")
    weekdays := ← nats (← field json "weekdays")
    both := ← (← field json "and").getBool? }

def ofCron (cron : Cron) : List (String × Json) :=
  [("seconds", toJson cron.seconds), ("minutes", toJson cron.minutes), ("hours", toJson cron.hours),
    ("days", toJson cron.days), ("months", toJson cron.months), ("weekdays", toJson cron.weekdays),
    ("and", toJson cron.both)]

def ofOccurrence : Option Int → Json
  | some instant => toJson instant
  | none => Json.null

def answer (op : String) (request : Json) : Decode Json := do
  match op with
  | "parse" =>
    match parse (← (← field request "expression").getStr?) with
    | .error message => pure (Json.mkObj [("invalid", Json.str message)])
    | .ok cron => pure (Json.mkObj (ofCron cron ++ [("satisfiable", toJson (satisfiable cron))]))
  | "format" =>
    pure (Json.str (format (← cronOf (← field request "cron")) (← (← field request "includeSeconds").getBool?)))
  | "match" => pure (toJson (firesAt (← cronOf (← field request "cron")) (← (← field request "at").getInt?)))
  | "next" => pure (ofOccurrence (next (← cronOf (← field request "cron")) (← (← field request "from").getInt?)))
  | "previous" =>
    pure (ofOccurrence (previous (← cronOf (← field request "cron")) (← (← field request "at").getInt?)))
  | "between" =>
    pure (toJson (between (← cronOf (← field request "cron")) (← (← field request "to").getInt?)
      (← (← field request "limit").getNat?) (← (← field request "from").getInt?)))
  | "civil" =>
    let date := civil (← (← field request "day").getInt?)
    pure (Json.arr #[toJson date.year, toJson date.month, toJson date.day, toJson date.weekday])
  | other => throw s!"unknown op {other}"

def respond (line : String) : Json :=
  match Json.parse line with
  | .error message => Json.mkObj [("error", Json.str message)]
  | .ok request =>
    match (do answer (← (← field request "op").getStr?) request) with
    | .ok result => Json.mkObj [("ok", result)]
    | .error message => Json.mkObj [("error", Json.str message)]

partial def serve (input output : IO.FS.Stream) : IO Unit := do
  let line ← input.getLine
  if line.isEmpty then return
  output.putStrLn (respond line).compress
  output.flush
  serve input output

def main : IO Unit := do
  serve (← IO.getStdin) (← IO.getStdout)

import Lean.Data.Json
import ChainSpec

/-!
# The oracle: the specification over JSON lines

Reads one JSON request per line from standard input and writes one JSON response per line to standard output, so a
test starts the program once and asks it thousands of questions. A request is `{"op": …, …}`; the response is
`{"ok": …}` or `{"error": …}`.

A text is an array of UTF-16 code units, so a lone surrogate survives the trip. A number is the decimal text of the
64 bits of its double, so `-0`, an infinity and a NaN arrive exactly.

A JavaScript value is `null`, `true`, `false`, `"u"` (undefined), `"x"` (a function, symbol or bigint), `"c"` (a
reference to a container the walk is inside), `["n", bits]`, `["s", units]`, `["r", unit, count]` (a string of
one repeated unit), `["a", items]` or `["o", plain, [[key, value], …]]`.
-/

open Lean ChainSpec

abbrev Decode := Except String

def field (json : Json) (name : String) : Decode Json := json.getObjVal? name

def listOf {α : Type} (decode : Json → Decode α) (json : Json) : Decode (List α) := do
  (← json.getArr?).toList.mapM decode

def item (json : Json) (index : Nat) : Decode Json := do
  match (← json.getArr?)[index]? with
  | some value => pure value
  | none => throw s!"no item {index}"

def text (json : Json) : Decode Text := listOf Json.getNat? json

def optionalText (json : Json) : Decode (Option Text) :=
  match json with
  | Json.null => pure none
  | other => do pure (some (← text other))

def bits (json : Json) : Decode Nat := do
  match (← json.getStr?).toNat? with
  | some value => pure value
  | none => throw "bits are not a decimal number"

partial def value (json : Json) : Decode Js := do
  match json with
  | Json.null => pure .null
  | Json.bool flag => pure (.bool flag)
  | Json.str "u" => pure .undefined
  | Json.str "x" => pure .exotic
  | Json.str "c" => pure .cycle
  | other =>
    match ← (← item other 0).getStr? with
    | "n" => pure (.num (← bits (← item other 1)))
    | "s" => pure (.str (← text (← item other 1)))
    | "r" => pure (.str (List.replicate (← (← item other 2).getNat?) (← (← item other 1).getNat?)))
    | "a" => pure (.arr (Items.ofList (← listOf value (← item other 1))))
    | "o" =>
      let fields ← listOf (fun entry => do pure (← text (← item entry 0), ← value (← item entry 1))) (← item other 2)
      pure (.obj (← (← item other 1).getBool?) (Fields.ofList fields))
    | tag => throw s!"unknown value tag {tag}"

def ofList {α : Type} (encode : α → Json) (values : List α) : Json := Json.arr (values.map encode).toArray

def ofText (value : Text) : Json := ofList (fun (unit : Nat) => toJson unit) value

def ofOption {α : Type} (encode : α → Json) : Option α → Json
  | some value => encode value
  | none => Json.null

mutual
  partial def ofValue : Js → Json
    | .undefined => Json.str "u"
    | .exotic => Json.str "x"
    | .cycle => Json.str "c"
    | .null => Json.null
    | .bool flag => Json.bool flag
    | .num bits => Json.arr #[Json.str "n", Json.str (toString bits)]
    | .str units => Json.arr #[Json.str "s", ofText units]
    | .arr items => Json.arr #[Json.str "a", Json.arr (ofItems items).toArray]
    | .obj plain fields => Json.arr #[Json.str "o", Json.bool plain, Json.arr (ofFields fields).toArray]

  partial def ofItems : Items → List Json
    | .nil => []
    | .cons head tail => ofValue head :: ofItems tail

  partial def ofFields : Fields → List Json
    | .nil => []
    | .cons key value tail => Json.arr #[ofText key, ofValue value] :: ofFields tail
end

def ofOutcome : Outcome → Json
  | .done value => Json.arr #[Json.str "Done", ofValue value]
  | .to script => Json.arr #[Json.str "To", ofText script]
  | .park code message => Json.arr #[Json.str "Park", ofText code, ofText message]

def effect (json : Json) : Decode Effect := do
  match ← json.getStr? with
  | "allow" => pure .allow
  | "deny" => pure .deny
  | "ask" => pure .ask
  | other => throw s!"unknown effect {other}"

def rule (json : Json) : Decode Rule := do
  pure { effect := ← effect (← item json 0), pattern := ⟨← text (← item json 1), ← text (← item json 2)⟩ }

def ofDecision : Decision → Json
  | .allowed => Json.arr #[Json.str "allowed"]
  | .approvalRequired claim => Json.arr #[Json.str "approval_required", ofText claim]
  | .denied claim => Json.arr #[Json.str "denied", ofText claim]

def callKey (json : Json) : Decode CallKey := do
  pure {
    link := ← (← item json 0).getNat?
    scriptDigest := ← text (← item json 1)
    ordinal := ← (← item json 2).getNat?
    entryDigest := ← text (← item json 3) }

def ofCallKey (key : CallKey) : Json :=
  Json.arr #[toJson key.link, ofText key.scriptDigest, toJson key.ordinal, ofText key.entryDigest]

def event (json : Json) : Decode Event := do
  let chain ← text (← item json 1)
  match ← (← item json 0).getStr? with
  | "started" => pure (.chainStarted chain (← text (← item json 2)) (← optionalText (← item json 3)))
  | "authored" => pure (.linkAuthored chain (← (← item json 2).getNat?) (← text (← item json 3)))
  | "settled" =>
    pure (.callSettled chain (← (← item json 2).getNat?) {
      key := ← callKey (← item json 3)
      name := ← text (← item json 4)
      payload := ← text (← item json 5)
      result := ← text (← item json 6) })
  | "rejected" => pure (.gateRejected chain (← (← item json 2).getNat?) (← (← item json 3).getNat?))
  | "ended" => pure (.linkEnded chain (← (← item json 2).getNat?) (← (← item json 3).getBool?))
  | "steered" => pure (.steeringDrained chain (← (← item json 2).getNat?) (← (← item json 3).getNat?))
  | other => throw s!"unknown event {other}"

def ofSettled (call : Settled) : Json :=
  Json.arr #[ofCallKey call.key, ofText call.name, ofText call.payload, ofText call.result]

def ofDivergence : Divergence → Json
  | .identity => Json.str "identity"
  | .name => Json.str "name"
  | .payload => Json.str "payload"
  | .declaration => Json.str "declaration"

def ofStep : Step → Json
  | .replayed result => Json.arr #[Json.str "replayed", ofText result]
  | .live key => Json.arr #[Json.str "live", ofCallKey key]
  | .diverged reason => Json.arr #[Json.str "diverged", ofDivergence reason]
  | .unlisted => Json.arr #[Json.str "unlisted"]

def ofRun : Run → Json
  | .startDiverged => Json.arr #[Json.str "startDiverged"]
  | .finished fresh => Json.arr #[Json.str "finished", Json.bool fresh]
  | .unscripted fresh link => Json.arr #[Json.str "unscripted", Json.bool fresh, toJson link]
  | .scripted fresh link scriptDigest steps =>
    Json.arr #[Json.str "scripted", Json.bool fresh, toJson link, ofText scriptDigest, ofList ofStep steps]

/-- The catalog as a lookup: the first entry under a name. -/
def catalog (entries : List (Text × Text)) (name : Text) : Option Text :=
  (entries.find? fun entry => entry.1 == name).map Prod.snd

def answer (op : String) (request : Json) : Decode Json := do
  match op with
  | "isWellFormed" => pure (Json.bool (isWellFormed (← text (← field request "text"))))
  | "jsonBoundary" =>
    let copied := jsonBoundary (← value (← field request "value"))
    let verdictOnly := ((request.getObjVal? "verdictOnly").toOption.bind fun flag => flag.getBool?.toOption).getD false
    pure (match copied with
      | none => Json.null
      | some copy => Json.mkObj [("copy", if verdictOnly then Json.bool true else ofValue copy)])
  | "decodeOutcome" => pure (ofOption ofOutcome (decodeOutcome (← value (← field request "value"))))
  | "claimPattern" =>
    pure (ofOption (fun (pattern : Pattern) => Json.arr #[ofText pattern.action, ofText pattern.resource])
      (claimPattern (← text (← field request "claim"))))
  | "authorize" =>
    pure (ofDecision (authorize (← listOf rule (← field request "rules")) (← listOf text (← field request "claims"))))
  | "callKey" =>
    let chain ← text (← field request "chain")
    let link ← (← field request "link").getNat?
    let ordinal ← (← field request "ordinal").getNat?
    let key : CallKey := ⟨link, ← text (← field request "scriptDigest"), ordinal, ← text (← field request "entryDigest")⟩
    pure (Json.mkObj [
      ("key", ofCallKey key),
      ("boundary", ofText (boundaryKey chain link ordinal)),
      ("child", ofText (childScope chain link ordinal))])
  | "settled" =>
    let events ← listOf event (← field request "events")
    let chain ← text (← field request "chain")
    let link ← (← field request "link").getNat?
    let calls := (settledOrdinals chain link events).filterMap fun ordinal =>
      (settled chain link events ordinal).map fun call => Json.arr #[toJson ordinal, ofSettled call]
    let ordinals := (events.filterMap fun (event : Event) =>
      match event with
      | .callSettled _ _ call => some call.key.ordinal
      | .gateRejected _ _ ordinal => some ordinal
      | _ => none).eraseDups
    pure (Json.mkObj [
      ("settled", Json.arr calls.toArray),
      ("rejected", ofList (fun (ordinal : Nat) => toJson ordinal) (ordinals.filter (rejected chain link events))),
      ("started", Json.bool (startedWith chain events).isSome),
      ("linkCount", toJson (linkCount chain events)),
      ("authored", ofOption ofText (authored chain link events)),
      ("terminal", Json.bool (isTerminal chain events))])
  | "replay" =>
    let entries ← listOf (fun entry => do pure (← text (← item entry 0), ← text (← item entry 1)))
      (← field request "catalog")
    let calls ← listOf (fun entry => do pure ({ name := ← text (← item entry 0), payload := ← text (← item entry 1) } : Call))
      (← field request "calls")
    pure (ofRun (run (catalog entries) (← listOf event (← field request "events")) (← text (← field request "chain"))
      (← text (← field request "goal")) (← optionalText (← field request "envelope")) calls))
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

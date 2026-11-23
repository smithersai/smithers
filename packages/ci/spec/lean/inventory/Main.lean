/-
The reference as a program: one JSON request a line on standard input, one JSON answer a line on standard output.

A test starts it once and asks it thousands of questions. Values travel in a form that keeps what JSON drops: a
number is `{"n": bits}` with its 64 bits in hexadecimal, a list is `{"a": items, "i": identity}` and a mapping is
`{"o": [[name, value], ...], "i": identity}` with its fields in order.
-/
import Lean.Data.Json
import InventorySpec

open Lean InventorySpec

/-- The 64 bits of a number in hexadecimal. Every `NaN` is written as one. -/
def bitsText (x : Float) : String :=
  String.ofList (hexDigits (if x.isNaN then nan.toBits.toNat else x.toBits.toNat) 16)

partial def encodeValue : Value → Json
  | .null => Json.null
  | .bool b => Json.bool b
  | .num x => Json.mkObj [("n", Json.str (bitsText x))]
  | .str s => Json.str s
  | .arr id items => Json.mkObj [("a", Json.arr (items.map encodeValue).toArray), ("i", toJson id)]
  | .obj id fields =>
    Json.mkObj [
      ("o", Json.arr (fields.map fun (key, item) => Json.arr #[Json.str key, encodeValue item]).toArray),
      ("i", toJson id)]

def field (json : Json) (name : String) : Except String Json := json.getObjVal? name

def text (json : Json) (name : String) : Except String String := field json name >>= (·.getStr?)

def flag (json : Json) (name : String) : Except String Bool := field json name >>= (·.getBool?)

def items (json : Json) (name : String) : Except String (List Json) :=
  field json name >>= (·.getArr?) |>.map (·.toList)

def pair (json : Json) : Except String (Json × Json) :=
  match json with
  | .arr #[first, second] => .ok (first, second)
  | _ => .error "expected a pair"

partial def decodeValue : Json → Except String Value
  | .null => .ok .null
  | .bool b => .ok (.bool b)
  | .str s => .ok (.str s)
  | json => do
    match json.getObjVal? "n" with
    | .ok bits =>
      let digits ← bits.getStr?
      match digitsValue? 16 digits.toList with
      | some n => pure (.num (Float.ofBits n.toUInt64))
      | none => throw "expected the bits of a number"
    | .error _ =>
      let id ← field json "i" >>= (·.getNat?)
      match json.getObjVal? "a" with
      | .ok _ => return .arr id (← (← items json "a").mapM decodeValue)
      | .error _ =>
        let fields ← (← items json "o").mapM fun entry => do
          let (key, item) ← pair entry
          pure (← key.getStr?, ← decodeValue item)
        pure (.obj id fields)

def operators : List Operator := [.lt, .le, .gt, .ge, .eq, .ne, .and, .or]

partial def encodeResidual : Residual → Json
  | .literal held => Json.mkObj [("kind", "literal"), ("value", encodeValue held)]
  | .var read =>
    Json.mkObj [("kind", "variable"), ("variable", Json.mkObj [
      ("id", read.id), ("name", read.name), ("nullable", read.nullable), ("typed", read.typed)])]
  | .not operand => Json.mkObj [("kind", "not"), ("operand", encodeResidual operand)]
  | .binary operator left right =>
    Json.mkObj [("kind", "binary"), ("operator", operator.text), ("left", encodeResidual left),
      ("right", encodeResidual right)]
  | .call name args => Json.mkObj [("kind", "call"), ("name", name), ("args", Json.arr (args.map encodeResidual).toArray)]

partial def decodeResidual (json : Json) : Except String Residual := do
  match ← text json "kind" with
  | "literal" => return .literal (← field json "value" >>= decodeValue)
  | "variable" =>
    let read ← field json "variable"
    return .var { id := ← text read "id", name := ← text read "name", nullable := ← flag read "nullable",
                  typed := ← flag read "typed" }
  | "not" => return .not (← field json "operand" >>= decodeResidual)
  | "binary" =>
    let written ← text json "operator"
    match operators.find? (·.text == written) with
    | some operator =>
      return .binary operator (← field json "left" >>= decodeResidual) (← field json "right" >>= decodeResidual)
    | none => throw "expected an operator"
  | "call" => return .call (← text json "name") (← (← items json "args").mapM decodeResidual)
  | _ => throw "expected a residual"

partial def decodeContext (json : Json) : Except String Context := do
  match ← text json "k" with
  | "value" => return .value (← field json "v" >>= decodeValue)
  | "residual" => return .residual (← field json "r" >>= decodeResidual)
  | "unknown" => return .unknown (← text json "why")
  | "secret" => return .secret (← text json "name")
  | "fields" =>
    let entries ← (← items json "entries").mapM fun entry => do
      let (name, context) ← pair entry
      pure (← name.getStr?, ← decodeContext context)
    return .fields (← flag json "exact") entries
  | _ => throw "expected a context"

def decodeScope (json : Json) : Except String Scope := do
  let contexts ← (← items json "contexts").mapM fun entry => do
    let (name, context) ← pair entry
    pure (← name.getStr?, ← decodeContext context)
  let status ← match ← field json "status" with
    | .null => pure none
    | .arr #[.bool success, .bool always, .bool cancelled, .bool failure] =>
      pure (some { success, always, cancelled, failure : Status })
    | _ => throw "expected a status"
  let hashFiles ← match ← field json "hash" with
    | .null => pure none
    | .str "echo" => pure (some HashFiles.echo)
    | context => pure (some (.fixed (← decodeContext context)))
  pure { contexts, status, hashFiles }

def encodeEvaluated : Evaluated → Json
  | .ok residual => Json.mkObj [("kind", "ok"), ("residual", encodeResidual residual)]
  | .problem why => Json.mkObj [("kind", "problem"), ("why", why)]
  | .secret name => Json.mkObj [("kind", "secret"), ("name", name)]

def encodeOption {α : Type} (encode : α → Json) : Option α → Json
  | some held => encode held
  | none => Json.null

def strings (held : List String) : Json := Json.arr (held.map Json.str).toArray

def encodeAssignment (types : Bool) (assignment : Assignment) : Json :=
  Json.arr (assignment.map fun (key, held) => Json.arr #[Json.str key, Json.str (if types then held.1 else held.2)]).toArray

def texts (json : Json) (name : String) : Except String (List String) := do
  (← items json name).mapM (·.getStr?)

def answer (request : Json) : Except String Json := do
  match ← text request "op" with
  | "evaluate" => return encodeEvaluated (evaluate (← text request "text") (← field request "scope" >>= decodeScope))
  | "finish" =>
    let knownValues ← (← items request "known").mapM fun entry => do
      let (id, held) ← pair entry
      pure (← id.getStr?, ← decodeValue held)
    match finish (← field request "residual" >>= decodeResidual) (fun read => (knownValues.lookup read.id).getD .null) with
    | .ok held => return Json.mkObj [("kind", "ok"), ("value", encodeValue held)]
    | .problem why => return Json.mkObj [("kind", "problem"), ("why", why)]
  | "settled" => return encodeOption Json.bool (settled (← field request "residual" >>= decodeResidual))
  | "variablesOf" =>
    return strings ((variablesOf (← field request "residual" >>= decodeResidual)).map (·.id))
  | "toNumber" => return encodeValue (.num (toNumber (← field request "value" >>= decodeValue)))
  | "toText" => return Json.str (toText (← field request "value" >>= decodeValue))
  | "truthy" => return Json.bool (truthy (← field request "value" >>= decodeValue))
  | "formatPieces" =>
    return encodeOption (fun pieces => Json.arr (pieces.map fun piece =>
      match piece with
      | Piece.text held => Json.str held
      | Piece.index number => encodeValue (.num number)).toArray) (formatPieces (← text request "text"))
  | "split" =>
    let (pieces, rest) := split (← text request "text")
    return Json.mkObj [
      ("pieces", Json.arr (pieces.map fun piece => strings [piece.before, piece.expression, piece.written]).toArray),
      ("rest", rest)]
  | "whole" => return encodeOption Json.str (whole (← text request "text") (← flag request "bare"))
  | "fill" =>
    match fill (← text request "text") (← field request "scope" >>= decodeScope) with
    | .ok parts =>
      return Json.mkObj [("kind", "ok"), ("parts", Json.arr (parts.map fun part =>
        match part with
        | Part.text held => Json.str held
        | Part.residual residual written =>
          Json.mkObj [("residual", encodeResidual residual), ("written", written)]).toArray)]
    | .problem why => return Json.mkObj [("kind", "problem"), ("why", why)]
    | .secret name => return Json.mkObj [("kind", "secret"), ("name", name)]
  | "matrix" =>
    let raw ← match request.getObjVal? "raw" with
      | .ok raw => (decodeValue raw).map some
      | .error _ => pure none
    let secrets ← (← items request "secrets").mapM fun entry => do
      let (name, held) ← pair entry
      pure (← name.getStr?, ← held.getStr?)
    let matrix := expandMatrix (fun name held => secrets.contains (name, held)) raw
    return Json.mkObj [("variants", Json.arr (matrix.variants.map (encodeAssignment false)).toArray),
      ("types", Json.arr (matrix.variants.map (encodeAssignment true)).toArray),
      ("keys", strings matrix.keys), ("problem", encodeOption Json.str matrix.problem)]
  | "regexOf" => return encodeOption Json.str (regexOf (← text request "pattern"))
  | "filesOf" =>
    return encodeOption (fun files => Json.mkObj <|
      [("take", strings files.take), ("leave", strings files.leave)] ++
      (if (files.order.dropWhile (· >= 0)).any (· >= 0) then [("order", toJson files.order)] else []))
      (filesOf (← texts request "patterns"))
  | "globMatches" =>
    let pattern ← text request "pattern"
    return Json.arr ((← texts request "paths").map fun path => encodeOption Json.bool (globMatches pattern path)).toArray
  | "filesMatch" =>
    let patterns ← texts request "patterns"
    return Json.arr ((← texts request "paths").map fun path => encodeOption Json.bool (filesMatch patterns path)).toArray
  | op => throw ("no such question: " ++ op)

partial def serve (input output : IO.FS.Stream) : IO Unit := do
  let line ← input.getLine
  if line.isEmpty then return
  let reply := match Json.parse line >>= answer with
    | .ok held => Json.mkObj [("ok", held)]
    | .error why => Json.mkObj [("error", why)]
  output.putStrLn reply.compress
  output.flush
  serve input output

def main : IO Unit := do
  serve (← IO.getStdin) (← IO.getStdout)

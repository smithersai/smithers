import McpProtocolSpec.Json

/-!
# JSON-RPC envelopes and correlation

`classify` is `Rpc.classify` and `replyOf` is `Rpc.replyOf`, over a parsed object. A message with a `method` is the
server's own request or notification; anything else must be a reply. A reply's id is normalized to the whole number
this client sent: a number as it is, a string only in canonical decimal.

`deliver` is what the stdio reader does with a classified message and the ids of the requests still waiting. A
reply settles the waiting request with its id and no other; a server request is answered under the server's id and
settles nothing, even when the ids are equal, because the two directions number independently.
-/

namespace McpProtocolSpec

/-- The value of the first member with a key: `Object.hasOwn` and the read in one. -/
def lookup (key : Text) : Members → Option Json
  | .nil => none
  | .cons key' value rest => if key' = key then some value else lookup key rest

/-- True for an object that is not an array. -/
def isRecord : Json → Bool
  | .obj _ => true
  | _ => false

/-- `Rpc.parse` keeps a parsed line: an object, not an array, with an own `jsonrpc`. -/
def accepts : Json → Bool
  | .obj members => (lookup (ascii "jsonrpc") members).isSome
  | _ => false

-- Ids -----------------------------------------------------------------------------------------------------------------

def isDigit (unit : Nat) : Bool := 48 ≤ unit && unit ≤ 57

/-- The number a run of digits spells. -/
def valueOf (text : Text) : Nat := text.foldl (fun total unit => total * 10 + (unit - 48)) 0

/-- `/^(0|[1-9][0-9]*)$/` and its value: canonical decimal, so one id has one spelling. -/
def parseDecimal : Text → Option Nat
  | [] => none
  | [48] => some 0
  | first :: rest => if 49 ≤ first && first ≤ 57 && rest.all isDigit then some (valueOf (first :: rest)) else none

/-- `String(id)` for an id this client sends: its decimal digits, most significant first. -/
def digits (value : Nat) : Text :=
  if _h : value < 10 then [48 + value] else digits (value / 10) ++ [48 + value % 10]
decreasing_by omega

/-- The whole number a reply's id stands for, when it is a safe integer or spells one. -/
def idOf : Json → Option Int
  | .num (.int value) => if isSafe value then some value else none
  | .str text =>
    match parseDecimal text with
    | some value => if value ≤ maxSafe then some (value : Int) else none
    | none => none
  | _ => none

/-- A server request's id, kept exactly as the server wrote it. -/
inductive RequestId where
  | text (value : Text)
  | number (value : Int)
  deriving DecidableEq

-- Classification ------------------------------------------------------------------------------------------------------

/-- `Rpc.Classification`. -/
inductive Classification where
  | notification
  | request (id : RequestId) (method : Text) (params : Option Json)
  | result (id : Int) (result : Json)
  | error (id : Int) (code : Int) (message : Text) (data : Option Json)
  | uncorrelatedError (code : Int) (message : Text) (data : Option Json)
  | malformed (reason : String)

/-- `Rpc.replyOf`: a reply, validated and with its id normalized. -/
def replyOf (message : Members) : Classification :=
  match lookup (ascii "id") message with
  | none => .malformed "a reply carried no id"
  | some rawId =>
    let id := idOf rawId
    let isNull := match rawId with
      | .null => true
      | _ => false
    if !isNull && id.isNone then .malformed "a reply id must be a JSON-RPC integer"
    else
      match lookup (ascii "result") message, lookup (ascii "error") message with
      | none, none => .malformed "a reply carried neither result nor error"
      | some _, some _ => .malformed "a reply carried both result and error"
      | some result, none =>
        match id with
        | some id => .result id result
        | none => .malformed "a reply id must be a JSON-RPC integer"
      | none, some (.obj error) =>
        match lookup (ascii "code") error, lookup (ascii "message") error with
        | some (.num (.int code)), some (.str text) =>
          match id with
          | some id => .error id code text (lookup (ascii "data") error)
          | none => .uncorrelatedError code text (lookup (ascii "data") error)
        | _, _ => .malformed "a reply carried a malformed error object"
      | none, some _ => .malformed "a reply carried a malformed error object"

/-- `Rpc.classify`: what one parsed JSON-RPC object is to the reader. -/
def classify (message : Members) : Classification :=
  match lookup (ascii "jsonrpc") message with
  | some (.str version) =>
    if version != ascii "2.0" then .malformed "a JSON-RPC message must carry jsonrpc \"2.0\""
    else
      match lookup (ascii "method") message with
      | none => replyOf message
      | some (.str method) =>
        if (lookup (ascii "result") message).isSome || (lookup (ascii "error") message).isSome then
          .malformed "a method-bearing message cannot also carry result or error"
        else
          match lookup (ascii "params") message, lookup (ascii "id") message with
          | some (.obj _), none => .notification
          | none, none => .notification
          | some (.obj params), some (.str id) => .request (.text id) method (some (.obj params))
          | none, some (.str id) => .request (.text id) method none
          | some (.obj params), some (.num (.int id)) =>
            if isSafe id then .request (.number id) method (some (.obj params))
            else .malformed "a server request id must be a string or safe integer"
          | none, some (.num (.int id)) =>
            if isSafe id then .request (.number id) method none
            else .malformed "a server request id must be a string or safe integer"
          | some (.obj _), some _ => .malformed "a server request id must be a string or safe integer"
          | none, some _ => .malformed "a server request id must be a string or safe integer"
          | some _, _ => .malformed "MCP method params must be an object"
      | some _ => .malformed "a method must be a string"
  | _ => .malformed "a JSON-RPC message must carry jsonrpc \"2.0\""

-- Correlation ---------------------------------------------------------------------------------------------------------

/-- What the reader does with one message. -/
inductive Action where
  /-- Nothing: a notification, or a reply no request waits for. -/
  | ignore
  /-- The request with this id succeeds with the reply's result. -/
  | resolve (id : Int) (result : Json)
  /-- The request with this id fails with the server's error. -/
  | reject (id : Int) (code : Int)
  /-- An error no request can be found for is reported and settles nothing. -/
  | report (code : Int)
  /-- The server's request is answered under its own id: an empty result for `ping`, else method-not-found. -/
  | respond (id : RequestId) (pong : Bool)
  /-- A malformed message closes the connection, which fails every waiting request. -/
  | close (reason : String)
  /-- A message past a JSON limit closes the connection the same way. -/
  | refuse (issue : Issue)

/-- One classified message against the ids of the waiting requests: the ids still waiting, and what was done. -/
def deliver (pending : List Int) : Classification → List Int × Action
  | .notification => (pending, .ignore)
  | .request id method _ => (pending, .respond id (method == ascii "ping"))
  | .result id result =>
    if pending.contains id then (pending.filter (· != id), .resolve id result) else (pending, .ignore)
  | .error id code _ _ =>
    if pending.contains id then (pending.filter (· != id), .reject id code) else (pending, .ignore)
  | .uncorrelatedError code _ _ => (pending, .report code)
  | .malformed reason => ([], .close reason)

/--
One parsed line against the ids of the waiting requests, as the stdio reader takes it: a line that does not claim
JSON-RPC is noise, a claimed message is held to the JSON limits before it is classified, and only then delivered.
-/
def read (pending : List Int) : Json → List Int × Action
  | .obj members =>
    if accepts (.obj members) then
      match checkParsed (.obj members) with
      | some issue => ([], .refuse issue)
      | none => deliver pending (classify members)
    else (pending, .ignore)
  | _ => (pending, .ignore)

/-- True for an action that closes the connection. -/
def Action.closes : Action → Bool
  | .close _ => true
  | .refuse _ => true
  | _ => false

/-- The reader over parsed lines in order, until one closes the connection: the ids still waiting and what was done. -/
def readAll : List Int → List Json → List Int × List Action
  | pending, [] => (pending, [])
  | pending, line :: rest =>
    if (read pending line).2.closes then ([], [(read pending line).2])
    else ((readAll (read pending line).1 rest).1, (read pending line).2 :: (readAll (read pending line).1 rest).2)

end McpProtocolSpec

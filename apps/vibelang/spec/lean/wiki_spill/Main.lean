import Lean.Data.Json
import WikiSpillSpec

/-!
# The oracle: the specification over JSON lines

Reads one JSON request per line from standard input and writes one JSON response per line to standard output, so a
test starts the program once and asks it many questions. A request is `{"op": …, …}`; the response is `{"ok": …}`
or `{"error": …}`.

A text is an array of UTF-16 code units, so a lone surrogate survives the trip. An item of the array is one unit,
or `[unit, count]` for a run of one unit, which keeps a megabyte of filler short. Answers write every run of two
or more units as `[unit, count]`.

The specification leaves the digest of a spilled text abstract. The oracle supplies the implementation's: the
hexadecimal SHA-256 of `new TextEncoder().encode(text)`. `TextEncoder` writes every lone surrogate as U+FFFD, so
the digest tells well-formed texts apart and no others; `DurableText` admits only well-formed text to the journal.
-/

open Lean WikiSpillSpec

-- --- the digest ------------------------------------------------------------------------------------------------------

def sha256Constants : Array UInt32 := #[
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]

def rotateRight (value : UInt32) (count : UInt32) : UInt32 := (value >>> count) ||| (value <<< (32 - count))

/-- SHA-256 (FIPS 180-4). -/
def sha256 (data : ByteArray) : ByteArray := Id.run do
  let mut message := data.push 0x80
  while message.size % 64 != 56 do
    message := message.push 0
  let bits : UInt64 := data.size.toUInt64 * 8
  for index in [0:8] do
    message := message.push (bits >>> (56 - 8 * index).toUInt64).toUInt8
  let mut state : Array UInt32 :=
    #[0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
  let mut words : Array UInt32 := Array.replicate 64 0
  for block in [0:message.size / 64] do
    for index in [0:16] do
      let offset := block * 64 + index * 4
      words := words.set! index
        ((message[offset]!.toUInt32 <<< 24) ||| (message[offset + 1]!.toUInt32 <<< 16)
          ||| (message[offset + 2]!.toUInt32 <<< 8) ||| message[offset + 3]!.toUInt32)
    for index in [16:64] do
      let early := words[index - 15]!
      let late := words[index - 2]!
      let small0 := rotateRight early 7 ^^^ rotateRight early 18 ^^^ (early >>> 3)
      let small1 := rotateRight late 17 ^^^ rotateRight late 19 ^^^ (late >>> 10)
      words := words.set! index (words[index - 16]! + small0 + words[index - 7]! + small1)
    let mut a := state[0]!
    let mut b := state[1]!
    let mut c := state[2]!
    let mut d := state[3]!
    let mut e := state[4]!
    let mut f := state[5]!
    let mut g := state[6]!
    let mut h := state[7]!
    for index in [0:64] do
      let big1 := rotateRight e 6 ^^^ rotateRight e 11 ^^^ rotateRight e 25
      let choice := (e &&& f) ^^^ ((~~~ e) &&& g)
      let first := h + big1 + choice + sha256Constants[index]! + words[index]!
      let big0 := rotateRight a 2 ^^^ rotateRight a 13 ^^^ rotateRight a 22
      let majority := (a &&& b) ^^^ (a &&& c) ^^^ (b &&& c)
      let second := big0 + majority
      h := g
      g := f
      f := e
      e := d + first
      d := c
      c := b
      b := a
      a := first + second
    state := #[state[0]! + a, state[1]! + b, state[2]! + c, state[3]! + d,
      state[4]! + e, state[5]! + f, state[6]! + g, state[7]! + h]
  let mut out := ByteArray.empty
  for word in state do
    out := (((out.push (word >>> 24).toUInt8).push (word >>> 16).toUInt8).push (word >>> 8).toUInt8).push word.toUInt8
  return out

/-- The UTF-8 bytes of one code point. -/
def pushCodePoint (bytes : ByteArray) (point : Nat) : ByteArray :=
  if point < 0x80 then bytes.push point.toUInt8
  else if point < 0x800 then (bytes.push (0xC0 + point / 64).toUInt8).push (0x80 + point % 64).toUInt8
  else if point < 0x10000 then
    ((bytes.push (0xE0 + point / 4096).toUInt8).push (0x80 + point / 64 % 64).toUInt8).push (0x80 + point % 64).toUInt8
  else
    (((bytes.push (0xF0 + point / 262144).toUInt8).push (0x80 + point / 4096 % 64).toUInt8).push
      (0x80 + point / 64 % 64).toUInt8).push (0x80 + point % 64).toUInt8

/-- `new TextEncoder().encode(text)`: a lone surrogate becomes U+FFFD. -/
def utf8From (bytes : ByteArray) : Text → ByteArray
  | [] => bytes
  | [unit] => pushCodePoint bytes (if isHigh unit || isLow unit then 0xFFFD else unit)
  | unit :: next :: tail =>
    if isHigh unit && isLow next then
      utf8From (pushCodePoint bytes (0x10000 + (unit - 0xD800) * 1024 + (next - 0xDC00))) tail
    else utf8From (pushCodePoint bytes (if isHigh unit || isLow unit then 0xFFFD else unit)) (next :: tail)

/-- The bytes a text is digested as. -/
def digestInput (text : Text) : ByteArray := utf8From ByteArray.empty text

def hexDigit (value : UInt8) : Nat := if value < 10 then 48 + value.toNat else 87 + value.toNat

/-- The digest `Wiki.vibe` names a spilled text by: 64 hexadecimal characters. -/
def digest (text : Text) : Text :=
  (sha256 (digestInput text)).toList.flatMap fun byte => [hexDigit (byte / 16), hexDigit (byte % 16)]

-- --- the wire --------------------------------------------------------------------------------------------------------

abbrev Decode := Except String

def field (json : Json) (name : String) : Decode Json := json.getObjVal? name

def present (json : Json) (name : String) : Option Json :=
  match json.getObjVal? name with
  | .ok Json.null => none
  | .ok value => some value
  | .error _ => none

def listOf {α : Type} (decode : Json → Decode α) (json : Json) : Decode (List α) := do
  (← json.getArr?).toList.mapM decode

def item (json : Json) (index : Nat) : Decode Json := do
  match (← json.getArr?)[index]? with
  | some value => pure value
  | none => throw s!"no item {index}"

def unit (json : Json) : Decode Nat := do
  let value ← json.getNat?
  if value < 65536 then pure value else throw s!"{value} is not a UTF-16 code unit"

/-- A text: units, and `[unit, count]` runs. -/
def text (json : Json) : Decode Text := do
  let mut units : Array Nat := #[]
  for entry in ← json.getArr? do
    match entry with
    | .arr run =>
      match run[0]?, run[1]? with
      | some value, some count => units := units ++ Array.replicate (← count.getNat?) (← unit value)
      | _, _ => throw "a run is [unit, count]"
    | single => units := units.push (← unit single)
  pure units.toList

def ofText (value : Text) : Json := Id.run do
  let mut out : Array Json := #[]
  let mut current := 0
  let mut count := 0
  for next in value do
    if count != 0 && next == current then count := count + 1
    else
      if count == 1 then out := out.push (toJson current)
      else if count > 1 then out := out.push (Json.arr #[toJson current, toJson count])
      current := next
      count := 1
  if count == 1 then out := out.push (toJson current)
  else if count > 1 then out := out.push (Json.arr #[toJson current, toJson count])
  return Json.arr out

def ofList {α : Type} (encode : α → Json) (values : List α) : Json := Json.arr (values.map encode).toArray

def ofOption {α : Type} (encode : α → Json) : Option α → Json
  | some value => encode value
  | none => Json.null

def optionalOf {α : Type} (decode : Json → Decode α) (json : Json) (name : String) : Decode (Option α) :=
  match present json name with
  | some value => do pure (some (← decode value))
  | none => pure none

def state (json : Json) : Decode State := do
  let pages ← listOf (fun entry => do
    pure ({ id := ← text (← item entry 0), source := ← text (← item entry 1), revision := ← text (← item entry 2) }
      : Page)) (← field json "pages")
  let draft ← optionalOf (fun entry => do
    pure ({ page := ← text (← item entry 0), text := ← text (← item entry 1) } : Draft)) json "draft"
  pure {
    seq := ← (← field json "seq").getNat?
    pages := pages
    review := ← optionalOf text json "review"
    draft := draft
    role := ← optionalOf text json "role"
    stale := ← optionalOf Json.getNat? json "stale" }

def ofState (value : State) : Json :=
  Json.mkObj [
    ("seq", toJson value.seq),
    ("pages", ofList (fun (page : Page) => Json.arr #[ofText page.id, ofText page.source, ofText page.revision])
      value.pages),
    ("review", ofOption ofText value.review),
    ("draft", ofOption (fun (draft : Draft) => Json.arr #[ofText draft.page, ofText draft.text]) value.draft),
    ("role", ofOption ofText value.role),
    ("stale", ofOption (fun (stale : Nat) => toJson stale) value.stale)]

/-- Storage as a request gives it: `[[digest, [chunk, …]], …]`. -/
def store (json : Json) : Decode Store := do
  let entries ← listOf (fun entry => do pure (← text (← item entry 0), ← listOf text (← item entry 1))) json
  pure fun key => (entries.find? fun entry => entry.1 == key).map (·.2)

def threshold (request : Json) : Decode Nat :=
  match present request "threshold" with
  | some value => value.getNat?
  | none => pure blobThreshold

def ofTier : Tier → Json
  | .first => "first"
  | .compact => "compact"
  | .minimal => "minimal"

def answer (op : String) (request : Json) : Decode Json := do
  match op with
  | "jsonBytes" => pure (toJson (jsonBytes (← text (← field request "text"))))
  | "wellFormed" => pure (Json.bool (wellFormed (← text (← field request "text"))))
  | "digest" => pure (ofText (digest (← text (← field request "text"))))
  | "escape" => pure (ofText (escape (← text (← field request "text"))))
  | "unescape" => pure (ofOption ofText (unescape (← text (← field request "wire"))))
  | "chunk" =>
    pure (ofList ofText (splitChunks (← (← field request "size").getNat?) (← text (← field request "text"))))
  | "reassemble" => pure (ofText (reassemble (← listOf text (← field request "chunks"))))
  | "encode" =>
    let value ← text (← field request "text")
    let limit ← threshold request
    let encoded := encode digest limit value
    pure (Json.mkObj [
      ("value", ofText encoded.value),
      ("encoded", Json.bool encoded.encoded),
      ("bytes", toJson (jsonBytes value)),
      ("chunks", if jsonBytes value ≤ limit then Json.null else ofList ofText (splitChunks chunkSize value))])
  | "decode" =>
    pure (ofOption ofText (decode (← store (← field request "store")) (← text (← field request "wire"))))
  | "stateBytes" => pure (toJson (stateBytes (← state (← field request "state"))))
  | "dehydrate" =>
    match dehydrate digest (← state (← field request "state")) with
    | none => pure (Json.mkObj [("tier", "unavailable")])
    | some compacted =>
      pure (Json.mkObj [
        ("tier", ofTier compacted.tier),
        ("encoded", Json.bool compacted.encoded),
        ("bytes", toJson (stateBytes compacted.state)),
        ("state", ofState compacted.state)])
  | "hydrate" =>
    pure (ofOption ofState (hydrate (← store (← field request "store")) (← state (← field request "state"))))
  | "retain" =>
    let retained := retain digest (← text (← field request "text"))
    pure (Json.mkObj [("text", ofText retained.text), ("blob", Json.bool retained.blob)])
  | "recall" =>
    pure (ofOption ofText (recall (← store (← field request "store"))
      { text := ← text (← field request "text"), blob := ← (← field request "blob").getBool? }))
  | "limits" =>
    pure (Json.mkObj [
      ("blobThreshold", toJson blobThreshold),
      ("compactThreshold", toJson compactThreshold),
      ("stateTotalLimit", toJson stateTotalLimit),
      ("draftInlineLimit", toJson draftInlineLimit),
      ("chunkSize", toJson chunkSize),
      ("maxEntryBytes", toJson maxEntryBytes)])
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

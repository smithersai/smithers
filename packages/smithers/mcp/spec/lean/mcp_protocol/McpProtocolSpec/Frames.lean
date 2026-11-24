/-!
# Framing: bytes into lines

`Transport.lines` turns a stream of byte chunks into lines. A line ends at LF, and a CR just before that LF is
dropped; with `cr`, as server-sent events require, a lone CR also ends a line, and an LF right after it ends nothing
new. A line longer than `max` bytes fails the stream. What is left when the stream ends is a last line.

`scan` reads one chunk as the implementation does. It holds the bytes of the open line from earlier chunks (`rev`)
and the run of this chunk's bytes since the last line end (`piece`), both newest first, and it checks the size only
when a run ends: at a line end and at the end of the chunk. A CR that ends a run may be half of a CRLF, so it is not
counted until more of the line follows.

A line is its bytes; decoding them as UTF-8 is the engine's and is the same for any split.
-/

namespace McpProtocolSpec

/-- The line still open between chunks. -/
structure Partial where
  /-- Its bytes so far, newest first. -/
  rev : List Nat
  /-- The last byte read was a CR that ended a line, so an LF next ends nothing. -/
  skipLf : Bool
  deriving DecidableEq

/-- The reader between chunks: the open line and the lines completed so far, newest first. -/
structure Reader where
  line : Partial
  out : List (List Nat)
  deriving DecidableEq

/-- A reader that has read nothing. -/
def Reader.start : Reader := { line := { rev := [], skipLf := false }, out := [] }

/-- Adds a run to the open line, or fails when the line is then over the cap. An empty run is not checked. -/
def append (max : Nat) (rev piece : List Nat) : Option (List Nat) :=
  match piece with
  | [] => some rev
  | last :: _ =>
    if rev.length + piece.length - (if last = 13 then 1 else 0) > max then none else some (piece ++ rev)

/-- A completed line, oldest byte first, without the CR it ends with. -/
def decode : List Nat → List Nat
  | 13 :: rest => rest.reverse
  | other => other.reverse

/-- Reads the rest of a chunk. `skip` is true right after a CR that ended a line. -/
def scan (cr : Bool) (max : Nat) : Bool → List Nat → List Nat → List (List Nat) → List Nat → Option Reader
  | skip, rev, piece, out, [] =>
    match append max rev piece with
    | none => none
    | some whole => some { line := { rev := whole, skipLf := skip }, out }
  | skip, rev, piece, out, byte :: rest =>
    if skip && byte = 10 then scan cr max false rev piece out rest
    else if byte = 10 then
      match append max rev piece with
      | none => none
      | some line => scan cr max false [] [] (decode line :: out) rest
    else if cr && byte = 13 then
      match append max rev piece with
      | none => none
      | some line => scan cr max true [] [] (decode line :: out) rest
    else scan cr max false rev (byte :: piece) out rest

/-- Reads one chunk. -/
def step (cr : Bool) (max : Nat) (reader : Reader) (chunk : List Nat) : Option Reader :=
  scan cr max reader.line.skipLf reader.line.rev [] reader.out chunk

/-- Reads the chunks in order; the first chunk that fails fails them all. -/
def feed (cr : Bool) (max : Nat) : Reader → List (List Nat) → Option Reader
  | reader, [] => some reader
  | reader, chunk :: rest =>
    match step cr max reader chunk with
    | none => none
    | some next => feed cr max next rest

/-- The lines of a finished stream, oldest first: an open line with any bytes is the last line. -/
def finish (reader : Reader) : List (List Nat) :=
  (if reader.line.rev.isEmpty then reader.out else decode reader.line.rev :: reader.out).reverse

/-- `Transport.lines` over a whole stream: its lines, or none when a line is over the cap. -/
def lines (cr : Bool) (max : Nat) (chunks : List (List Nat)) : Option (List (List Nat)) :=
  (feed cr max .start chunks).map finish

end McpProtocolSpec

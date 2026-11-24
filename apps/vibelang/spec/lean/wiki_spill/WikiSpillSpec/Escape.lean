/-!
# Wiki text on the wire: literal escaping and blob references

The reference specification of `apps/vibelang/worker/Wiki.vibe`'s journal encoding of a wiki text
(`encodeWikiText`, `decodeWikiText`).

A text is a list of UTF-16 code units, exactly a JavaScript string: a lone surrogate is a text like any other.

A journaled text takes one of three forms:

* a text that does not start with NUL is written verbatim;
* a short text that starts with NUL is written after `"\u0000lit:"`;
* a spilled text is written as `"\u0000blob:"` followed by the digest of its content.

So every wire text that starts with NUL names its form, and no text is mistaken for a reference.
-/

namespace WikiSpillSpec

/-- A JavaScript string: its UTF-16 code units. -/
abbrev Text := List Nat

/-- A high (leading) surrogate, `0xD800..0xDBFF`. -/
def isHigh (unit : Nat) : Bool := 0xD800 ≤ unit && unit ≤ 0xDBFF

/-- A low (trailing) surrogate, `0xDC00..0xDFFF`. -/
def isLow (unit : Nat) : Bool := 0xDC00 ≤ unit && unit ≤ 0xDFFF

/-- `"\u0000lit:"`. -/
def litPrefix : Text := [0, 108, 105, 116, 58]

/-- `"\u0000blob:"`. -/
def blobPrefix : Text := [0, 98, 108, 111, 98, 58]

/-- `value.startsWith("\u0000")`. -/
def startsNul : Text → Bool
  | 0 :: _ => true
  | _ => false

/-- The wire form of a text kept inline: verbatim, or after `litPrefix` when it starts with NUL. -/
def escape (text : Text) : Text := if startsNul text then litPrefix ++ text else text

/-- The wire form of a spilled text: `blobPrefix` and the digest of its content. -/
def blobRef (digest : Text) : Text := blobPrefix ++ digest

/-- What a wire text says it is. -/
inductive Wire where
  /-- An inline text. -/
  | text (value : Text)
  /-- A reference to the chunks stored under `digest`. -/
  | blob (digest : Text)
  /-- A NUL-prefixed text that is neither a literal nor a reference: `decodeWikiText` refuses it. -/
  | invalid
  deriving Repr, DecidableEq

/-- Reads a wire text as `decodeWikiText` does, before any storage is read. -/
def classify : Text → Wire
  | 0 :: 108 :: 105 :: 116 :: 58 :: rest => .text rest
  | 0 :: 98 :: 108 :: 111 :: 98 :: 58 :: rest => .blob rest
  | 0 :: _ => .invalid
  | other => .text other

/-- The inline text a wire text holds, when it holds one. -/
def unescape (wire : Text) : Option Text :=
  match classify wire with
  | .text value => some value
  | _ => none

/-- A well-formed UTF-16 text: every high surrogate is followed by a low one, and every low one follows a high
one (`String.prototype.isWellFormed`). -/
def wellFormed : Text → Bool
  | [] => true
  | unit :: rest =>
    if isHigh unit then
      match rest with
      | next :: tail => isLow next && wellFormed tail
      | [] => false
    else !isLow unit && wellFormed rest

end WikiSpillSpec

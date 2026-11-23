/-!
# SHA-256

`ObservedReads.ts` names file contents, directory listings, variable values and record ids by their SHA-256
digest. The reference specification computes the same digests, so that every state it prints is byte-equal to
the one the implementation prints. FIPS 180-4, executable; the differential suite compares it with Node's.
-/
namespace ObservedReadsSpec.Sha256

/-- The round constants: the first 32 bits of the fractional parts of the cube roots of the first 64 primes. -/
def roundConstants : Array UInt32 := #[
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]

/-- The eight working words. -/
structure State where
  a : UInt32
  b : UInt32
  c : UInt32
  d : UInt32
  e : UInt32
  f : UInt32
  g : UInt32
  h : UInt32

/-- The initial hash value: the fractional parts of the square roots of the first eight primes. -/
def initial : State :=
  ⟨0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19⟩

@[inline] def rotr (x : UInt32) (n : UInt32) : UInt32 := (x >>> n) ||| (x <<< (32 - n))

/-- The message with its padding: a `1` bit, zeros to 56 bytes modulo 64, and the bit length in 8 bytes. -/
def pad (message : ByteArray) : ByteArray :=
  let bits : UInt64 := message.size.toUInt64 * 8
  let marked := message.push 0x80
  let zeros := (120 - marked.size % 64) % 64
  let filled := (List.range zeros).foldl (fun bytes _ => bytes.push 0) marked
  (List.range 8).foldl (fun bytes i => bytes.push (bits >>> (56 - 8 * i.toUInt64)).toUInt8) filled

/-- The 64 words of a block's message schedule. -/
def schedule (bytes : ByteArray) (offset : Nat) : Array UInt32 :=
  let word (i : Nat) : UInt32 :=
    (bytes.get! (offset + 4 * i)).toUInt32 <<< 24 ||| (bytes.get! (offset + 4 * i + 1)).toUInt32 <<< 16 |||
      (bytes.get! (offset + 4 * i + 2)).toUInt32 <<< 8 ||| (bytes.get! (offset + 4 * i + 3)).toUInt32
  let first := (List.range 16).foldl (fun words i => words.push (word i)) (Array.mkEmpty 64)
  (List.range 48).foldl (fun words j =>
    let i := j + 16
    let w15 := words[i - 15]!
    let w2 := words[i - 2]!
    let s0 := rotr w15 7 ^^^ rotr w15 18 ^^^ (w15 >>> 3)
    let s1 := rotr w2 17 ^^^ rotr w2 19 ^^^ (w2 >>> 10)
    words.push (words[i - 16]! + s0 + words[i - 7]! + s1)) first

/-- One round of the compression function. -/
def round (s : State) (k w : UInt32) : State :=
  let s1 := rotr s.e 6 ^^^ rotr s.e 11 ^^^ rotr s.e 25
  let ch := (s.e &&& s.f) ^^^ ((~~~s.e) &&& s.g)
  let t1 := s.h + s1 + ch + k + w
  let s0 := rotr s.a 2 ^^^ rotr s.a 13 ^^^ rotr s.a 22
  let maj := (s.a &&& s.b) ^^^ (s.a &&& s.c) ^^^ (s.b &&& s.c)
  ⟨t1 + s0 + maj, s.a, s.b, s.c, s.d + t1, s.e, s.f, s.g⟩

/-- Folds one 64-byte block into the hash value. -/
def compress (s : State) (bytes : ByteArray) (offset : Nat) : State :=
  let words := schedule bytes offset
  let t := (List.range 64).foldl (fun t i => round t roundConstants[i]! words[i]!) s
  ⟨s.a + t.a, s.b + t.b, s.c + t.c, s.d + t.d, s.e + t.e, s.f + t.f, s.g + t.g, s.h + t.h⟩

/-- The hash value of a message. -/
def digest (message : ByteArray) : State :=
  let padded := pad message
  (List.range (padded.size / 64)).foldl (fun s block => compress s padded (64 * block)) initial

/-- A hexadecimal digit, in lower case. -/
def hexDigit (n : Nat) : Char := if n < 10 then Char.ofNat (48 + n) else Char.ofNat (87 + n)

/-- The eight hexadecimal digits of a word. -/
def hexWord (w : UInt32) : List Char :=
  let n := w.toNat
  [hexDigit (n / 0x10000000 % 16), hexDigit (n / 0x1000000 % 16), hexDigit (n / 0x100000 % 16),
    hexDigit (n / 0x10000 % 16), hexDigit (n / 0x1000 % 16), hexDigit (n / 0x100 % 16), hexDigit (n / 0x10 % 16),
    hexDigit (n % 16)]

/-- The 64 hexadecimal digits of a hash value. -/
def State.hex (s : State) : List Char :=
  hexWord s.a ++ hexWord s.b ++ hexWord s.c ++ hexWord s.d ++ hexWord s.e ++ hexWord s.f ++ hexWord s.g ++
    hexWord s.h

/-- Every digest is 64 characters long. -/
theorem State.hex_length (s : State) : s.hex.length = 64 := by
  simp [State.hex, hexWord]

end Sha256

/-- The digest of a byte string, as `createHash("sha256").update(bytes).digest("hex")` prints it. -/
def sha256Bytes (bytes : ByteArray) : String := String.ofList (Sha256.digest bytes).hex

/-- The digest of a text's UTF-8 bytes. -/
def sha256Hex (text : String) : String := sha256Bytes text.toUTF8

/-- Every digest is 64 characters long, so no digest is another one followed by `:x`. -/
theorem sha256Hex_length (text : String) : (sha256Hex text).toList.length = 64 := by
  simp [sha256Hex, sha256Bytes, Sha256.State.hex_length]

end ObservedReadsSpec

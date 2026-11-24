import WikiSpillSpec.Escape

/-!
# Chunks of a spilled text

A spilled text is stored as chunks of `chunkSize` code units. A chunk takes one more unit when its last unit is a
high surrogate, so in a well-formed text no chunk boundary falls inside a surrogate pair. Reading joins the chunks
in order.
-/

namespace WikiSpillSpec

/-- `WIKI_BLOB_CHUNK`: 32 KiB of UTF-16 code units. -/
def chunkSize : Nat := 32 * 1024

/-- The length of the first chunk of a non-empty `text`: `size` units, one more when unit `size - 1` is a high
surrogate, or all of a text of at most `size` units. -/
def cut (size : Nat) (text : Text) : Nat :=
  if size < text.length then
    match text[size - 1]? with
    | some last => if isHigh last then size + 1 else size
    | none => size
  else text.length

theorem cut_le (size : Nat) (text : Text) : cut size text ≤ text.length := by
  unfold cut
  split
  · split
    · split <;> omega
    · omega
  · omega

theorem cut_le_succ (size : Nat) (text : Text) : cut size text ≤ max (size + 1) text.length := by
  unfold cut
  split
  · split
    · split <;> omega
    · omega
  · omega

theorem cut_pos {size : Nat} {text : Text} (nonEmpty : text ≠ []) (positive : size ≠ 0) : 0 < cut size text := by
  have : 0 < text.length := List.length_pos_iff.mpr nonEmpty
  unfold cut
  split
  · split
    · split <;> omega
    · omega
  · omega

/-- The chunks of `text`, in order. The implementation's size is never 0; here a size of 0 keeps the text whole. -/
def splitChunks (size : Nat) (text : Text) : List Text :=
  if _empty : text = [] then []
  else if _zero : size = 0 then [text]
  else text.take (cut size text) :: splitChunks size (text.drop (cut size text))
termination_by text.length
decreasing_by
  have := cut_pos _empty _zero
  have : 0 < text.length := List.length_pos_iff.mpr _empty
  simp only [List.length_drop]
  omega

/-- The text its chunks hold: `parts.join("")`. -/
def reassemble (chunks : List Text) : Text := chunks.flatten

end WikiSpillSpec

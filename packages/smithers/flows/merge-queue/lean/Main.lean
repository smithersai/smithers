import MergeQueue.Trace

/-!
The executable reference. It reads a trace on stdin (`MergeQueue/Trace.lean`)
and prints the state after every line. A line it cannot read prints `error`.
-/

open MergeQueue

partial def loop (input : IO.FS.Stream) (output : IO.FS.Stream) (cfg : Config) (s : State) : IO Unit := do
  let text ← input.getLine
  if text.isEmpty then return
  let trimmed := (text.dropEndWhile fun c => c == '\n' || c == '\r').toString
  match Trace.line trimmed with
  | none =>
    output.putStrLn "error"
    loop input output cfg s
  | some parsed =>
    let (cfg, s) := Trace.apply cfg s parsed
    output.putStrLn (Trace.state cfg s)
    loop input output cfg s

def main : IO Unit := do
  let input ← IO.getStdin
  let output ← IO.getStdout
  loop input output
    { required := [], maxAttempts := 0, maxBatch := 1, maxRuns := 1, window := 1, defaultDuration := 0 }
    State.empty

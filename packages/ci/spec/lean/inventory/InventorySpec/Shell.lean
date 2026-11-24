namespace InventorySpec

/-- Shell option processing separates the command string, script path and standard input. -/
def shellInput (input : String) : List String → Bool → Bool → Option String
  | [], command, _ => if command then none else some input
  | "--" :: args, command, stdin =>
    if command then args.head? else if stdin || args.isEmpty then some input else none
  | opt :: args, command, stdin =>
    if ["--rcfile", "--init-file"].contains opt then
      match args with
      | [] => if command then none else some input
      | _ :: rest => shellInput input rest command stdin
    else if opt.length > 1 && (opt.startsWith "-" || opt.startsWith "+") then
      let short := (opt.toList.drop 1).all Char.isAlpha
      let flags := opt.startsWith "-" && short
      let values := if short then (opt.toList.filter (fun c => c == 'o' || c == 'O')).length else 0
      shellInput input (args.drop values) (command || (flags && opt.contains 'c')) (stdin || (flags && opt.contains 's'))
    else if command then some opt else if stdin then some input else none
termination_by args _ _ => args.length
decreasing_by all_goals simp_wf <;> omega

theorem shellInput_after_terminator (input command : String) (rest : List String) (stdin : Bool) :
    shellInput input ("--" :: command :: rest) true stdin = some command := by
  simp [shellInput]

end InventorySpec

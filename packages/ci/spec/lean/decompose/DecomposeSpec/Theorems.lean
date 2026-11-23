/-
Machine-checked properties of the reference specification. Every statement here is proved in full, from no
axiom beyond Lean's own.
-/
import DecomposeSpec.Shell
import DecomposeSpec.Workspace
import DecomposeSpec.Plan
import DecomposeSpec.Script

namespace DecomposeSpec

/-! ## Shell: the quoter -/

namespace Shell

open Text

/-- `quote` never gives the empty text: a word is always one word to the shell, the empty word `''`. -/
theorem quote_ne_nil (word : Str) : quote word ≠ [] := by
  unfold quote
  split
  · rename_i safe
    cases word with
    | nil => simp at safe
    | cons head tail => simp
  · simp

/-- A character `quote` leaves bare differs from every character it does not. -/
theorem ne_of_isSafe {c d : Char} (safe : isSafe c = true) (other : isSafe d = false) : c ≠ d := by
  intro same
  subst same
  simp [safe] at other

theorem isWordEnd_of_isSafe {c : Char} (safe : isSafe c = true) : isWordEnd c = false := by
  have h1 := ne_of_isSafe safe (d := ' ') (by decide)
  have h2 := ne_of_isSafe safe (d := '\t') (by decide)
  have h3 := ne_of_isSafe safe (d := '\n') (by decide)
  have h4 := ne_of_isSafe safe (d := ';') (by decide)
  have h5 := ne_of_isSafe safe (d := '&') (by decide)
  have h6 := ne_of_isSafe safe (d := '|') (by decide)
  have h7 := ne_of_isSafe safe (d := '<') (by decide)
  have h8 := ne_of_isSafe safe (d := '>') (by decide)
  simp [isWordEnd, h1, h2, h3, h4, h5, h6, h7, h8]

theorem isRefusedBare_of_isSafe {c : Char} (safe : isSafe c = true) : isRefusedBare c = false := by
  have h1 := ne_of_isSafe safe (d := '`') (by decide)
  have h2 := ne_of_isSafe safe (d := '(') (by decide)
  have h3 := ne_of_isSafe safe (d := ')') (by decide)
  have h4 := ne_of_isSafe safe (d := '{') (by decide)
  have h5 := ne_of_isSafe safe (d := '}') (by decide)
  have h6 := ne_of_isSafe safe (d := '*') (by decide)
  have h7 := ne_of_isSafe safe (d := '?') (by decide)
  have h8 := ne_of_isSafe safe (d := '~') (by decide)
  simp [isRefusedBare, h1, h2, h3, h4, h5, h6, h7, h8]

/-- The reader reads a word of safe characters as itself. -/
theorem readWordLoop_safe (word : Str) (safe : word.all isSafe = true) :
    ∀ (fuel : Nat) (state : WordState), word.length < fuel →
      readWordLoop fuel word state = some ({ state with value := state.value ++ word }, []) := by
  induction word with
  | nil =>
    intro fuel state enough
    cases fuel with
    | zero => omega
    | succ fuel => simp [readWordLoop]
  | cons c rest ih =>
    intro fuel state enough
    simp only [List.all_cons, Bool.and_eq_true] at safe
    cases fuel with
    | zero => omega
    | succ fuel =>
      have h1 := isWordEnd_of_isSafe safe.1
      have h2 := isRefusedBare_of_isSafe safe.1
      have h3 := ne_of_isSafe safe.1 (d := '\'') (by decide)
      have h4 := ne_of_isSafe safe.1 (d := '"') (by decide)
      have h5 := ne_of_isSafe safe.1 (d := '\\') (by decide)
      have h6 := ne_of_isSafe safe.1 (d := '$') (by decide)
      have h7 := ne_of_isSafe safe.1 (d := '[') (by decide)
      have h8 := ne_of_isSafe safe.1 (d := ']') (by decide)
      have step := ih safe.2 fuel { state with value := state.value ++ [c] } (by simp at enough ⊢; omega)
      simp [readWordLoop, h1, h2, h3, h4, h5, h6, h7, h8, step]

/-- The reader, inside single quotes, reads what `quote` wrote there back as the word. -/
theorem readWordLoop_quoted (word : Str) :
    ∀ (fuel : Nat) (state : WordState) (before : Str), (word.flatMap escapeQuote).length < fuel →
      (match readSingle (word.flatMap escapeQuote ++ ['\'']) with
        | none => none
        | some (inside, after) =>
          readWordLoop fuel after { state with value := state.value ++ (before ++ inside), quoted := true }) =
        some ({ state with value := state.value ++ (before ++ word), quoted := true }, []) := by
  induction word with
  | nil =>
    intro fuel state before enough
    cases fuel with
    | zero => simp at enough
    | succ fuel => simp [readSingle, readWordLoop]
  | cons c rest ih =>
    intro fuel state before enough
    by_cases isQuote : c = '\''
    · subst isQuote
      simp only [List.flatMap_cons, escapeQuote, if_true, List.length_append, List.length_cons,
        List.length_nil] at enough
      obtain ⟨fuel, rfl⟩ : ∃ less, fuel = less + 2 := ⟨fuel - 2, by omega⟩
      have step := ih fuel
        { state with value := state.value ++ (before ++ ['\'']), quoted := true } [] (by omega)
      simp only [List.nil_append] at step
      simp [escapeQuote, readSingle, readWordLoop, isWordEnd]
      cases found : readSingle (rest.flatMap escapeQuote ++ ['\'']) with
      | none => simp [found] at step
      | some pair =>
        obtain ⟨inside, after⟩ := pair
        simp only [found] at step
        simpa using step
    · have step := ih fuel state (before ++ [c]) (by
        simp only [List.flatMap_cons, escapeQuote, if_neg isQuote, List.length_append, List.length_cons,
          List.length_nil] at enough
        omega)
      simp only [List.flatMap_cons, escapeQuote, if_neg isQuote, List.cons_append, List.nil_append, readSingle]
      cases found : readSingle (rest.flatMap escapeQuote ++ ['\'']) with
      | none => simp [found] at step
      | some pair =>
        obtain ⟨inside, after⟩ := pair
        simp only [found] at step
        simpa using step

/-- A single quote opens a run the reader takes whole, up to the quote that closes it. -/
theorem readWordLoop_quote (fuel : Nat) (rest : Str) (state : WordState) :
    readWordLoop (fuel + 1) ('\'' :: rest) state =
      match readSingle rest with
      | none => none
      | some (inside, after) =>
        readWordLoop fuel after { state with value := state.value ++ inside, quoted := true } := by
  simp [readWordLoop, isWordEnd]
  rfl

/-- `quote` preserves the word: the reader reads what `quote` wrote back as one word of the same text, with no
variable in it and nothing left over. -/
theorem quote_read_back (word : Str) :
    ∃ state, readWordLoop ((quote word).length + 1) (quote word) {} = some (state, []) ∧
      state.value = word ∧ state.literal = true := by
  unfold quote
  split
  · rename_i safe
    simp only [Bool.and_eq_true] at safe
    exact ⟨_, readWordLoop_safe word safe.2 _ {} (by omega), by simp, rfl⟩
  · have read := readWordLoop_quoted word ((word.flatMap escapeQuote).length + 2) {} [] (by omega)
    refine ⟨{ value := word, quoted := true }, ?_, rfl, rfl⟩
    have size : ('\'' :: (word.flatMap escapeQuote ++ ['\''])).length + 1 =
        ((word.flatMap escapeQuote).length + 2) + 1 := by simp
    rw [size, readWordLoop_quote]
    simpa using read

/-! ### A trailing operator is refused -/

/-- An operator that needs a command after it: `&&`, `||` and `|`. -/
def Operator.dangles : Operator → Bool
  | .and | .or | .pipe => true
  | .semi | .amp => false

def Token.dangles : Token → Bool
  | .op operator => operator.dangles
  | _ => false

/-- The tokens end with an operator that needs a command after it. -/
def EndsOpen (tokens : List Token) : Prop := ∃ last, tokens.getLast? = some last ∧ last.dangles = true

theorem EndsOpen.not_nil : ¬ EndsOpen [] := by
  intro ⟨last, isLast, _⟩
  cases isLast

/-- Taking a token that is no such operator from the front leaves tokens that still end with one. -/
theorem EndsOpen.rest {token : Token} {rest : List Token} (endsOpen : EndsOpen (token :: rest))
    (closed : token.dangles = false) : EndsOpen rest := by
  obtain ⟨last, isLast, dangling⟩ := endsOpen
  cases rest with
  | nil =>
    simp only [List.getLast?_singleton, Option.some.injEq] at isLast
    subst isLast
    simp [closed] at dangling
  | cons next more => exact ⟨last, by simpa [List.getLast?_cons_cons] using isLast, dangling⟩

theorem EndsOpen.dropSemis {tokens : List Token} (endsOpen : EndsOpen tokens) :
    EndsOpen (tokens.dropWhile isSemi) := by
  induction tokens with
  | nil => exact endsOpen
  | cons token rest ih =>
    by_cases semi : isSemi token = true
    · have closed : token.dangles = false := by
        cases token with
        | op operator => cases operator <;> simp_all [isSemi, Token.dangles, Operator.dangles]
        | word _ => rfl
        | redirect => rfl
      simpa [List.dropWhile, semi] using ih (endsOpen.rest closed)
    · simpa [List.dropWhile, semi] using endsOpen

theorem EndsOpen.simpleLoop {tokens : List Token} (endsOpen : EndsOpen tokens) :
    ∀ state : SimpleState, EndsOpen (simpleLoop tokens state).2 := by
  induction tokens with
  | nil => exact absurd endsOpen EndsOpen.not_nil
  | cons token rest ih =>
    intro state
    cases token with
    | op operator => simpa [Shell.simpleLoop] using endsOpen
    | redirect => simpa [Shell.simpleLoop] using ih (endsOpen.rest rfl) _
    | word token =>
      simp only [Shell.simpleLoop]
      split <;> exact ih (endsOpen.rest rfl) _

theorem EndsOpen.readSimple {tokens rest : List Token} {joint : Joint} {conditional : Bool} {command : Command}
    (endsOpen : EndsOpen tokens) (read : readSimple tokens joint conditional = some (command, rest)) :
    EndsOpen rest := by
  have loop := endsOpen.simpleLoop {}
  unfold Shell.readSimple at read
  split at read
  rename_i state left pair
  rw [pair] at loop
  split at read
  · cases read
  · cases read
    exact loop

/-- After a keyword, the tokens still end with the operator. -/
theorem EndsOpen.afterKeyword {tokens : List Token} {keyword : Str} (endsOpen : EndsOpen tokens)
    (isKeyword : atKeyword keyword tokens = true) : EndsOpen (tokens.drop 1) := by
  cases tokens with
  | nil => exact absurd endsOpen EndsOpen.not_nil
  | cons token rest =>
    cases token with
    | word _ => exact endsOpen.rest rfl
    | op _ => simp [atKeyword, bareWord] at isKeyword
    | redirect => simp [atKeyword, bareWord] at isKeyword

theorem EndsOpen.dropOne {tokens : List Token} (endsOpen : EndsOpen tokens) :
    tokens.drop 1 = [] ∨ EndsOpen (tokens.drop 1) := by
  cases tokens with
  | nil => exact Or.inl rfl
  | cons token rest =>
    cases rest with
    | nil => exact Or.inl rfl
    | cons next more =>
      obtain ⟨last, isLast, dangling⟩ := endsOpen
      exact Or.inr ⟨last, by simpa [List.getLast?_cons_cons] using isLast, dangling⟩

/-- Inside an `if`, the end of the tokens is never the end of a list. -/
theorem readList_nil_inside (fuel remaining : Nat) (conditional : Bool) (joint : Joint) (out : List Command) :
    readList fuel remaining true conditional joint [] out = none := by
  cases fuel <;> simp [readList]

/-- With nothing after `&&`, `||` or `|`, there is no list. -/
theorem readList_nil_dangling (fuel remaining : Nat) (stops conditional : Bool) (operator : Operator)
    (out : List Command) (dangling : operator.dangles = true) :
    readList fuel remaining stops conditional (jointOf operator) [] out = none := by
  cases fuel with
  | zero => simp [readList]
  | succ fuel => cases operator <;> simp_all [readList, jointOf, Joint.complete, Operator.dangles]

/-- Neither a list nor an `if` takes a trailing `&&`, `||` or `|`: whatever is read, the tokens left over still
end with it. -/
theorem endsOpen_left (fuel : Nat) :
    (∀ remaining stops conditional joint tokens out rest read, EndsOpen tokens →
      readList fuel remaining stops conditional joint tokens out = some (rest, read) → EndsOpen rest) ∧
    (∀ remaining conditional tokens out isOpen certain rest read, EndsOpen tokens →
      readIf fuel remaining conditional tokens out isOpen certain = some (rest, read) → EndsOpen rest) := by
  induction fuel with
  | zero =>
    constructor
    · intro remaining stops conditional joint tokens out rest read _ result
      simp [readList] at result
    · intro remaining conditional tokens out isOpen certain rest read _ result
      simp [readIf] at result
  | succ fuel ih =>
    obtain ⟨list, branch⟩ := ih
    constructor
    · intro remaining stops conditional joint tokens out rest read endsOpen result
      have dropped := endsOpen.dropSemis
      simp only [readList] at result
      split at result
      · rename_i none
        rw [none] at dropped
        exact absurd dropped EndsOpen.not_nil
      · rename_i token more some
        rw [some] at dropped
        split at result
        · split at result
          · cases result
            exact dropped
          · cases result
        · split at result
          · cases result
          · split at result
            · split at result
              · cases result
              · split at result
                · cases result
                · rename_i after afterOut inner
                  have afterOpen := branch _ _ _ _ _ _ _ _ dropped inner
                  split at result
                  · exact absurd afterOpen EndsOpen.not_nil
                  · split at result
                    · exact list _ _ _ _ _ _ _ _ afterOpen result
                    · cases result
            · split at result
              · cases result
              · rename_i command operator after simple
                have simpleOpen := dropped.readSimple simple
                cases after with
                | nil =>
                  obtain ⟨last, isLast, dangling⟩ := simpleOpen
                  simp only [List.getLast?_singleton, Option.some.injEq] at isLast
                  subst isLast
                  rw [readList_nil_dangling fuel remaining stops conditional operator _ dangling] at result
                  cases result
                | cons next others =>
                  obtain ⟨last, isLast, dangling⟩ := simpleOpen
                  exact list _ _ _ _ _ _ _ _ ⟨last, by simpa [List.getLast?_cons_cons] using isLast, dangling⟩ result
              · rename_i command after _ simple
                exact list _ _ _ _ _ _ _ _ (dropped.readSimple simple) result
    · intro remaining conditional tokens out isOpen certain rest read endsOpen result
      simp only [readIf] at result
      split at result
      · cases result
      · rename_i afterCondition condition readCondition
        have conditionOpen : EndsOpen afterCondition := by
          cases endsOpen.dropOne with
          | inl nothing =>
            rw [nothing, readList_nil_inside] at readCondition
            cases readCondition
          | inr stillOpen => exact list _ _ _ _ _ _ _ _ stillOpen readCondition
        split at result
        · cases result
        · rename_i isThen
          have thenOpen : EndsOpen (afterCondition.drop 1) :=
            conditionOpen.afterKeyword (keyword := keywordThen) (by simpa using isThen)
          split at result
          · cases result
          · rename_i afterBody body readBody
            have bodyOpen : EndsOpen afterBody := list _ _ _ _ _ _ _ _ thenOpen readBody
            split at result
            · exact branch _ _ _ _ _ _ _ _ bodyOpen result
            · split at result
              · cases result
              · rename_i afterElse elseOut otherwise
                have elseOpen : EndsOpen afterElse := by
                  split at otherwise
                  · rename_i isElse
                    split at otherwise
                    · cases otherwise
                    · rename_i afterBranch branchOut readElse
                      cases otherwise
                      exact list _ _ _ _ _ _ _ _ (bodyOpen.afterKeyword isElse) readElse
                  · cases otherwise
                    exact bodyOpen
                split at result
                · rename_i isFi
                  cases result
                  exact elseOpen.afterKeyword isFi
                · cases result

/-- A trailing `&&`, `||` or `|` is refused: tokens that end with one are no script. -/
theorem parse_trailing_operator (tokens : List Token) (operator : Operator) (dangling : operator.dangles = true) :
    parse (tokens ++ [.op operator]) = none := by
  have endsOpen : EndsOpen (tokens ++ [.op operator]) := ⟨.op operator, by simp, dangling⟩
  unfold parse
  split
  · rename_i out result
    exact absurd ((endsOpen_left _).1 _ _ _ _ _ _ _ _ endsOpen result) EndsOpen.not_nil
  · rfl

/-- A script whose last token is `&&`, `||` or `|` is refused. -/
theorem commands_trailing_operator (script : Str) (tokens : List Token) (operator : Operator)
    (lexed : lex script = some (tokens ++ [.op operator])) (dangling : operator.dangles = true) :
    commands script = none := by
  simp [commands, lexed, parse_trailing_operator tokens operator dangling]

/-- The reader is a function: one script has one reading. -/
theorem commands_deterministic (script : Str) (first second : Option (List Command))
    (readFirst : commands script = first) (readSecond : commands script = second) : first = second :=
  readFirst.symm.trans readSecond

/-- CI expressions are refused before the shell reader considers quoting. -/
theorem commands_ci_expression (script : Str) (expression : contains "${{".toList script = true) :
    commands script = none := by simp only [commands, expression, if_true]

/-- Once the nesting budget is spent, a further `if` cannot be read. -/
theorem readList_if_at_limit (fuel : Nat) (stops conditional : Bool) (joint : Joint) (tokens : List Token)
    (out : List Command) (isIf : bareWord (tokens.dropWhile isSemi).head? = some keywordIf) :
    readList fuel 0 stops conditional joint tokens out = none := by
  cases fuel with
  | zero => rfl
  | succ fuel =>
    cases h : tokens.dropWhile isSemi with
    | nil => simp [h, bareWord] at isIf
    | cons token rest =>
      simp only [h, List.head?_cons] at isIf
      simp [readList, h, isIf, branchKeywords, refusedKeywords, keywordIf, keywordThen, keywordElif,
        keywordElse, keywordFi]

end Shell

namespace Plan

open Text

/-- A non-`cd` command in the AND chain preserves the ambiguity of the subsequent OR arm. -/
theorem directoryList_and_before_or (cwd : Str) (command fallback : Shell.Command) (rest : List Shell.Command)
    (previousCd : Bool)
    (andJoint : command.joint = .and) (notCd : command.words.head?.map (·.text) ≠ some "cd".toList)
    (orJoint : fallback.joint = .or) :
    directoryList (command :: fallback :: rest) cwd previousCd true = none := by
  simp only [directoryList, separates, andJoint, notCd, orJoint]
  simp

/-- A non-`cd` command can fail, so another `cd` after it in the AND chain cannot fix the working directory. -/
theorem directoryList_and_before_cd (cwd : Str) (command change : Shell.Command) (rest : List Shell.Command)
    (andJoint : command.joint = .and) (notCd : command.words.head?.map (·.text) ≠ some "cd".toList)
    (changeJoint : change.joint = .and) (isCd : change.words.head?.map (·.text) = some "cd".toList) :
    directoryList (command :: change :: rest) cwd true true = none := by
  simp only [directoryList, separates, andJoint, notCd, changeJoint, isCd]
  cases change.words with
  | nil => simp
  | cons head tail =>
    cases tail with
    | nil => simp
    | cons path tail => cases tail <;> simp

/-- Even an extra glob that might later be dropped as covered forces a full read if it is unsupported. -/
theorem inputsOf_unsupported (outside : List Str) (reaches : List Workspace.Reach) (globs : List Str)
    (glob : Str) (present : glob ∈ globs) (unsupported : contractGlob glob = false) :
    inputsOf outside reaches globs = [everything] := by
  have invalid : globs.any (!contractGlob ·) = true := List.any_eq_true.mpr ⟨glob, present, by simp [unsupported]⟩
  simp [inputsOf, invalid]

end Plan

/-! ## Workspace: wildcards -/

namespace Workspace

/-- A pattern with no star matches a subject exactly when it is the subject. -/
theorem wild_literal [DecidableEq α] (isStar : α → Bool) (pattern : List α)
    (noStar : ∀ token ∈ pattern, isStar token = false) :
    ∀ subject : List α, wild isStar (fun left right => decide (left = right)) pattern subject =
      decide (pattern = subject) := by
  induction pattern with
  | nil =>
    intro subject
    cases subject <;> simp [wild]
  | cons token rest ih =>
    intro subject
    have plain : isStar token = false := noStar token List.mem_cons_self
    have restPlain : ∀ other ∈ rest, isStar other = false := fun other inRest =>
      noStar other (List.mem_cons_of_mem _ inRest)
    cases subject with
    | nil => simp [wild, plain]
    | cons item more => simp [wild, plain, ih restPlain more]

/-- A name with no `*` in it matches only itself. -/
theorem wildName_literal (segment name : Str) (noStar : '*' ∉ segment) :
    wildName segment name = decide (segment = name) := by
  unfold wildName
  refine wild_literal _ segment ?_ name
  intro token inSegment
  simp only [decide_eq_false_iff_not]
  intro isStar
  exact noStar (isStar ▸ inSegment)

/-! ## Workspace: reach -/

/-- What a search can come to: an item it starts from, or an item one it came to leads to. Only items of the
domain count. -/
inductive Reaches (domain : List α) (edges : α → List α) (starts : List α) : α → Prop where
  | start {item : α} : item ∈ starts → item ∈ domain → Reaches domain edges starts item
  | step {item next : α} : Reaches domain edges starts item → next ∈ edges item → next ∈ domain →
      Reaches domain edges starts next

theorem Reaches.inDomain {domain : List α} {edges : α → List α} {starts : List α} {item : α}
    (reached : Reaches domain edges starts item) : item ∈ domain := by
  cases reached with
  | start _ inDomain => exact inDomain
  | step _ _ inDomain => exact inDomain

/-- What is reached from some starts is reached from any starts that reach them. -/
theorem Reaches.rebase {domain : List α} {edges : α → List α} {source target : List α} {item : α}
    (covers : ∀ start ∈ source, start ∈ domain → Reaches domain edges target start)
    (reached : Reaches domain edges source item) : Reaches domain edges target item := by
  induction reached with
  | start inStarts inDomain => exact covers _ inStarts inDomain
  | step _ isEdge inDomain ih => exact .step ih isEdge inDomain

/-- What a search gives, at any point of it: everything seen so far, everything on the stack, nothing that is not
seen or reached from the stack, and with each new item everything it leads to. -/
theorem search_spec [DecidableEq α] (domain : List α) (edges : α → List α) (stack seen : List α) :
    (∀ x ∈ seen, x ∈ search domain edges stack seen) ∧
    (∀ x ∈ stack, x ∈ domain → x ∈ search domain edges stack seen) ∧
    (∀ x ∈ search domain edges stack seen, x ∈ seen ∨ Reaches domain edges stack x) ∧
    (∀ x ∈ search domain edges stack seen, x ∉ seen →
      ∀ y ∈ edges x, y ∈ domain → y ∈ search domain edges stack seen) := by
  fun_induction search domain edges stack seen with
  | case1 seen =>
    refine ⟨fun x known => List.mem_reverse.mpr known, ?_,
      fun x found => Or.inl (List.mem_reverse.mp found), ?_⟩
    · intro x onStack
      cases onStack
    · intro x found fresh
      exact absurd (List.mem_reverse.mp found) fresh
  | case2 seen item rest known ih =>
    obtain ⟨keeps, takes, sound, closed⟩ := ih
    refine ⟨keeps, fun x onStack inDomain => ?_, fun x found => ?_, closed⟩
    · cases onStack with
      | head => exact keeps _ known
      | tail _ inRest => exact takes x inRest inDomain
    · exact (sound x found).imp id
        (Reaches.rebase fun start inRest inDomain => .start (List.mem_cons_of_mem _ inRest) inDomain)
  | case3 seen item rest fresh inDomain ih =>
    obtain ⟨keeps, takes, sound, closed⟩ := ih
    refine ⟨fun x known => keeps x (List.mem_cons_of_mem _ known), fun x onStack xInDomain => ?_,
      fun x found => ?_, fun x found xFresh y isEdge yInDomain => ?_⟩
    · cases onStack with
      | head => exact keeps _ List.mem_cons_self
      | tail _ inRest => exact takes x (List.mem_append_right _ inRest) xInDomain
    · cases sound x found with
      | inl known =>
        cases known with
        | head => exact Or.inr (.start List.mem_cons_self inDomain)
        | tail _ known => exact Or.inl known
      | inr reached =>
        refine Or.inr (reached.rebase fun start onStack startInDomain => ?_)
        cases List.mem_append.mp onStack with
        | inl isEdge =>
          exact .step (.start List.mem_cons_self inDomain) (List.mem_reverse.mp isEdge) startInDomain
        | inr inRest => exact .start (List.mem_cons_of_mem _ inRest) startInDomain
    · by_cases same : x = item
      · subst same
        exact takes y (List.mem_append_left _ (List.mem_reverse.mpr isEdge)) yInDomain
      · refine closed x found (fun known => ?_) y isEdge yInDomain
        cases known with
        | head => exact same rfl
        | tail _ known => exact xFresh known
  | case4 seen item rest fresh outside ih =>
    obtain ⟨keeps, takes, sound, closed⟩ := ih
    refine ⟨keeps, fun x onStack inDomain => ?_, fun x found => ?_, closed⟩
    · cases onStack with
      | head => exact absurd inDomain outside
      | tail _ inRest => exact takes x inRest inDomain
    · exact (sound x found).imp id
        (Reaches.rebase fun start inRest inDomain => .start (List.mem_cons_of_mem _ inRest) inDomain)

/-- A search gives exactly what its starts reach: it is sound and complete. -/
theorem mem_search_iff [DecidableEq α] (domain : List α) (edges : α → List α) (starts : List α) (item : α) :
    item ∈ search domain edges starts [] ↔ Reaches domain edges starts item := by
  obtain ⟨_, takes, sound, closed⟩ := search_spec domain edges starts []
  constructor
  · intro found
    cases sound item found with
    | inl known => cases known
    | inr reached => exact reached
  · intro reached
    induction reached with
    | start inStarts inDomain => exact takes _ inStarts inDomain
    | step _ isEdge inDomain ih => exact closed _ ih List.not_mem_nil _ isEdge inDomain

/-- Reflexive: a search reaches each item it starts from. -/
theorem search_self [DecidableEq α] (domain : List α) (edges : α → List α) (starts : List α) (item : α)
    (isStart : item ∈ starts) (inDomain : item ∈ domain) : item ∈ search domain edges starts [] :=
  (mem_search_iff domain edges starts item).mpr (.start isStart inDomain)

/-- A fixed point: what a search gives leads nowhere new. -/
theorem search_closed [DecidableEq α] (domain : List α) (edges : α → List α) (starts : List α) (item next : α)
    (found : item ∈ search domain edges starts []) (isEdge : next ∈ edges item) (inDomain : next ∈ domain) :
    next ∈ search domain edges starts [] :=
  (mem_search_iff domain edges starts next).mpr
    (.step ((mem_search_iff domain edges starts item).mp found) isEdge inDomain)

/-- Monotone in where it starts: more starts reach no less. -/
theorem search_monotone [DecidableEq α] (domain : List α) (edges : α → List α) (fewer more : List α)
    (included : ∀ start ∈ fewer, start ∈ more) (item : α) (found : item ∈ search domain edges fewer []) :
    item ∈ search domain edges more [] :=
  (mem_search_iff domain edges more item).mpr
    (((mem_search_iff domain edges fewer item).mp found).rebase fun start isStart inDomain =>
      .start (included start isStart) inDomain)

theorem Reaches.moreEdges {domain : List α} {fewer more : α → List α} {starts : List α} {item : α}
    (included : ∀ item, ∀ next ∈ fewer item, next ∈ more item) (reached : Reaches domain fewer starts item) :
    Reaches domain more starts item := by
  induction reached with
  | start isStart inDomain => exact .start isStart inDomain
  | step _ isEdge inDomain ih => exact .step ih (included _ _ isEdge) inDomain

/-- Monotone in the graph: more edges reach no less. -/
theorem search_monotone_edges [DecidableEq α] (domain : List α) (fewer more : α → List α) (starts : List α)
    (included : ∀ item, ∀ next ∈ fewer item, next ∈ more item) (item : α)
    (found : item ∈ search domain fewer starts []) : item ∈ search domain more starts [] :=
  (mem_search_iff domain more starts item).mpr
    (((mem_search_iff domain fewer starts item).mp found).moreEdges included)

/-- Idempotent: searching again from what a search gave gives the same items. -/
theorem search_idempotent [DecidableEq α] (domain : List α) (edges : α → List α) (starts : List α) (item : α) :
    item ∈ search domain edges (search domain edges starts []) [] ↔ item ∈ search domain edges starts [] := by
  constructor
  · intro found
    exact (mem_search_iff domain edges starts item).mpr
      (((mem_search_iff domain edges _ item).mp found).rebase fun start isStart _ =>
        (mem_search_iff domain edges starts start).mp isStart)
  · intro found
    exact search_self domain edges _ item found ((mem_search_iff domain edges starts item).mp found).inDomain

/-- Self-reach: a package, or a file, reaches itself. -/
theorem Facts.reached_self (facts : Facts) (start : Node) : start ∈ facts.reached start :=
  search_self _ _ _ start List.mem_cons_self List.mem_cons_self

/-- What a package reaches is closed: whatever a reached package or file leads to is reached too. -/
theorem Facts.reached_closed (facts : Facts) (start node next : Node) (found : node ∈ facts.reached start)
    (isEdge : next ∈ facts.edges node) (inDomain : next ∈ facts.domain start) : next ∈ facts.reached start :=
  search_closed _ _ _ node next found isEdge inDomain

end Workspace

/-! ## Turbo: the walk is a fixed point -/

namespace Turbo

/-- The tasks a walk goes through are closed under `dependsOn`: a task one of them names, of a package and a
name the walk can come to, is gone through too. -/
theorem walk_closed (config : Config) (packages : List Workspace.Package) (domain starts : List Node)
    (task next : Node) (found : task ∈ Workspace.search domain (edges config packages) starts [])
    (isEdge : next ∈ edges config packages task) (inDomain : next ∈ domain) :
    next ∈ Workspace.search domain (edges config packages) starts [] :=
  Workspace.search_closed _ _ _ task next found isEdge inDomain

end Turbo

/-! ## Plan: the order of a tree's jobs -/

namespace Text

theorem mem_foldl_distinct [DecidableEq α] (values : List α) : ∀ (out : List α) (value : α),
    value ∈ values.foldl (fun out value => if value ∈ out then out else out ++ [value]) out ↔
      value ∈ out ∨ value ∈ values := by
  induction values with
  | nil =>
    intro out value
    simp
  | cons head tail ih =>
    intro out value
    simp only [List.foldl_cons, ih, List.mem_cons]
    by_cases known : head ∈ out
    · simp only [if_pos known]
      constructor
      · rintro (h | h)
        · exact Or.inl h
        · exact Or.inr (Or.inr h)
      · rintro (h | h | h)
        · exact Or.inl h
        · exact Or.inl (h ▸ known)
        · exact Or.inr h
    · simp only [if_neg known, List.mem_append, List.mem_singleton]
      constructor
      · rintro ((h | h) | h)
        · exact Or.inl h
        · exact Or.inr (Or.inl h)
        · exact Or.inr (Or.inr h)
      · rintro (h | h | h)
        · exact Or.inl (Or.inl h)
        · exact Or.inl (Or.inr h)
        · exact Or.inr h

/-- `distinct` keeps every value. -/
theorem mem_distinct [DecidableEq α] (values : List α) (value : α) : value ∈ distinct values ↔ value ∈ values := by
  simp [distinct, mem_foldl_distinct]

end Text

namespace Plan

open Text

/-- The ids of listed jobs. -/
abbrev ids (out : List (Str × Job)) : List Str := out.map (·.2.id)

/-- The ids of the jobs that wait on the stack to be listed. -/
def emitIds : List Frame → List Str
  | [] => []
  | .emit job _ :: rest => job.id :: emitIds rest
  | .visit _ _ :: rest => emitIds rest

def Frame.job : Frame → Job
  | .visit job _ => job
  | .emit job _ => job

theorem emitIds_visits (needs : List Job) (tree : Str) (rest : List Frame) :
    emitIds (needs.map (Frame.visit · tree) ++ rest) = emitIds rest := by
  induction needs with
  | nil => rfl
  | cons head tail ih => simpa [emitIds] using ih

theorem mem_emitIds {stack : List Frame} {id : Str} :
    id ∈ emitIds stack → ∃ job tree, Frame.emit job tree ∈ stack ∧ job.id = id := by
  induction stack with
  | nil => intro waits; cases waits
  | cons frame rest ih =>
    intro waits
    cases frame with
    | visit job tree =>
      obtain ⟨found, itsTree, onRest, same⟩ := ih waits
      exact ⟨found, itsTree, List.mem_cons_of_mem _ onRest, same⟩
    | emit job tree =>
      cases waits with
      | head => exact ⟨job, tree, List.mem_cons_self, rfl⟩
      | tail _ waits =>
        obtain ⟨found, itsTree, onRest, same⟩ := ih waits
        exact ⟨found, itsTree, List.mem_cons_of_mem _ onRest, same⟩

/-- Every job marked as seen is listed already, or waits on the stack to be listed. -/
def Accounted (stack : List Frame) (seen : List Str) (out : List (Str × Job)) : Prop :=
  ∀ id ∈ seen, id ∈ ids out ∨ id ∈ emitIds stack

theorem Accounted.emit {job : Job} {tree : Str} {rest : List Frame} {seen : List Str} {out : List (Str × Job)}
    (accounted : Accounted (.emit job tree :: rest) seen out) : Accounted rest seen ((tree, job) :: out) := by
  intro id known
  cases accounted id known with
  | inl isListed => exact Or.inl (List.mem_cons_of_mem _ isListed)
  | inr waits =>
    cases waits with
    | head => exact Or.inl List.mem_cons_self
    | tail _ waits => exact Or.inr waits

theorem Accounted.skip {job : Job} {tree : Str} {rest : List Frame} {seen : List Str} {out : List (Str × Job)}
    (accounted : Accounted (.visit job tree :: rest) seen out) : Accounted rest seen out :=
  accounted

theorem Accounted.enter {jobs : List Job} {job : Job} {tree : Str} {rest : List Frame} {seen : List Str}
    {out : List (Str × Job)} (accounted : Accounted (.visit job tree :: rest) seen out) :
    Accounted ((needsIn jobs job tree).map (Frame.visit · tree) ++ .emit job tree :: rest) (job.id :: seen) out := by
  intro id known
  rw [emitIds_visits]
  cases known with
  | head => exact Or.inr List.mem_cons_self
  | tail _ known => exact (accounted id known).imp (fun isListed => isListed) (List.mem_cons_of_mem _)

theorem ids_mono {out later : List (Str × Job)} (kept : ∀ entry ∈ out, entry ∈ later) {id : Str}
    (isListed : id ∈ ids out) : id ∈ ids later := by
  obtain ⟨entry, inOut, same⟩ := List.mem_map.mp isListed
  exact List.mem_map.mpr ⟨entry, kept entry inOut, same⟩

/-- A run lists everything listed before it, every job waiting on its stack, and every job it is to go into. -/
theorem run_keeps (jobs : List Job) (stack : List Frame) (seen : List Str) (out : List (Str × Job)) :
    Accounted stack seen out →
      (∀ entry ∈ out, entry ∈ run jobs stack seen out) ∧
      (∀ job tree, Frame.emit job tree ∈ stack → (tree, job) ∈ run jobs stack seen out) ∧
      (∀ job tree, Frame.visit job tree ∈ stack → job.id ∈ jobs.map (·.id) →
        job.id ∈ ids (run jobs stack seen out)) := by
  fun_induction run jobs stack seen out with
  | case1 seen out =>
    intro _
    refine ⟨fun entry inOut => List.mem_reverse.mpr inOut, ?_, ?_⟩
    · intro job tree onStack
      cases onStack
    · intro job tree onStack
      cases onStack
  | case2 seen out job tree rest ih =>
    intro accounted
    obtain ⟨keeps, emits, visits⟩ := ih accounted.emit
    refine ⟨fun entry inOut => keeps entry (List.mem_cons_of_mem _ inOut), ?_, ?_⟩
    · intro other itsTree onStack
      cases onStack with
      | head => exact keeps _ List.mem_cons_self
      | tail _ onRest => exact emits other itsTree onRest
    · intro other itsTree onStack inJobs
      cases onStack with
      | tail _ onRest => exact visits other itsTree onRest inJobs
  | case3 seen out job tree rest known ih =>
    intro accounted
    obtain ⟨keeps, emits, visits⟩ := ih accounted.skip
    refine ⟨keeps, ?_, ?_⟩
    · intro other itsTree onStack
      cases onStack with
      | tail _ onRest => exact emits other itsTree onRest
    · intro other itsTree onStack inJobs
      cases onStack with
      | head =>
        cases accounted.skip job.id known with
        | inl isListed => exact ids_mono keeps isListed
        | inr waits =>
          obtain ⟨found, foundTree, onRest, same⟩ := mem_emitIds waits
          exact List.mem_map.mpr ⟨(foundTree, found), emits found foundTree onRest, same⟩
      | tail _ onRest => exact visits other itsTree onRest inJobs
  | case4 seen out job tree rest fresh inJobs ih =>
    intro accounted
    obtain ⟨keeps, emits, visits⟩ := ih accounted.enter
    refine ⟨keeps, ?_, ?_⟩
    · intro other itsTree onStack
      cases onStack with
      | tail _ onRest => exact emits other itsTree (List.mem_append_right _ (List.mem_cons_of_mem _ onRest))
    · intro other itsTree onStack otherInJobs
      cases onStack with
      | head =>
        exact List.mem_map.mpr ⟨(tree, job), emits job tree (List.mem_append_right _ List.mem_cons_self), rfl⟩
      | tail _ onRest =>
        exact visits other itsTree (List.mem_append_right _ (List.mem_cons_of_mem _ onRest)) otherInJobs
  | case5 seen out job tree rest fresh outside ih =>
    intro accounted
    obtain ⟨keeps, emits, visits⟩ := ih accounted.skip
    refine ⟨keeps, ?_, ?_⟩
    · intro other itsTree onStack
      cases onStack with
      | tail _ onRest => exact emits other itsTree onRest
    · intro other itsTree onStack inJobs
      cases onStack with
      | head => exact absurd inJobs outside
      | tail _ onRest => exact visits other itsTree onRest inJobs

theorem visit_mem_starts (jobs : List Job) (job : Job) (tree : Str) (inJobs : job ∈ jobs)
    (shared : job.tree = some tree) : Frame.visit job tree ∈ starts jobs := by
  unfold starts
  exact List.mem_filterMap.mpr ⟨job, List.mem_append_right _ inJobs, by simp [shared]⟩

/-- Every job of a shared tree is listed: the order leaves no job out, in a cycle or not. -/
theorem listed_all (jobs : List Job) (job : Job) (tree : Str) (inJobs : job ∈ jobs)
    (shared : job.tree = some tree) : job.id ∈ ids (listed jobs) :=
  (run_keeps jobs (starts jobs) [] [] (fun _ known => nomatch known)).2.2 job tree
    (visit_mem_starts jobs job tree inJobs shared) (List.mem_map.mpr ⟨job, inJobs, rfl⟩)

/-- The order of one tree is the jobs listed for it, in the order they are listed. -/
theorem treeOrder_entry (jobs : List Job) (tree : Str) (order : List Str)
    (isEntry : (tree, order) ∈ treeOrder jobs) :
    order = ((listed jobs).filter (·.1 = tree)).map (·.2.id) := by
  obtain ⟨found, _, same⟩ := List.mem_map.mp isEntry
  cases same
  rfl

/-- `treeOrder` preserves every job: each job of a shared tree is in the order of some tree. -/
theorem treeOrder_all (jobs : List Job) (job : Job) (tree : Str) (inJobs : job ∈ jobs)
    (shared : job.tree = some tree) : ∃ entry ∈ treeOrder jobs, job.id ∈ entry.2 := by
  obtain ⟨⟨listedTree, listedJob⟩, isListed, same⟩ := List.mem_map.mp (listed_all jobs job tree inJobs shared)
  refine ⟨(listedTree, ((listed jobs).filter (·.1 = listedTree)).map (·.2.id)), ?_, ?_⟩
  · exact List.mem_map.mpr
      ⟨listedTree, (mem_distinct _ _).mpr (List.mem_map.mpr ⟨_, isListed, rfl⟩), rfl⟩
  · exact List.mem_map.mpr ⟨(listedTree, listedJob), List.mem_filter.mpr ⟨isListed, by simp⟩, same⟩

/-! ### Needs come first -/

/-- A job to go into ranks below every job that waits under it on the stack: it is not one of them. -/
def Good (rank : Str → Nat) : List Frame → Prop
  | [] => True
  | .emit _ _ :: rest => Good rank rest
  | .visit job _ :: rest => (∀ id ∈ emitIds rest, rank job.id < rank id) ∧ Good rank rest

/-- Each need of a job that waits on the stack is listed (`done`) or is above it on the stack (`above`). -/
def Waiting (jobs : List Job) (done : List Str) : List Str → List Frame → Prop
  | _, [] => True
  | above, .visit job _ :: rest => Waiting jobs done (job.id :: above) rest
  | above, .emit job tree :: rest =>
    (∀ need ∈ needsIn jobs job tree, need.id ∈ done ∨ need.id ∈ above) ∧ Waiting jobs done (job.id :: above) rest

/-- Listed jobs, the latest first: each job's needs were listed before it. -/
def Ordered (jobs : List Job) : List (Str × Job) → Prop
  | [] => True
  | (tree, job) :: older => (∀ need ∈ needsIn jobs job tree, need.id ∈ ids older) ∧ Ordered jobs older

theorem Waiting.mono {jobs : List Job} {done later : List Str} (kept : ∀ id ∈ done, id ∈ later) :
    ∀ (stack : List Frame) (above higher : List Str), (∀ id ∈ above, id ∈ later ∨ id ∈ higher) →
      Waiting jobs done above stack → Waiting jobs later higher stack := by
  intro stack
  induction stack with
  | nil => intro _ _ _ _; trivial
  | cons frame rest ih =>
    intro above higher moved waiting
    have next : ∀ (id : Str) (top : Str), id ∈ top :: above → id ∈ later ∨ id ∈ top :: higher := by
      intro id top inAbove
      cases inAbove with
      | head => exact Or.inr List.mem_cons_self
      | tail _ inAbove => exact (moved id inAbove).imp (fun isLater => isLater) (List.mem_cons_of_mem _)
    cases frame with
    | visit job tree => exact ih _ _ (fun id => next id job.id) waiting
    | emit job tree =>
      refine ⟨fun need isNeed => ?_, ih _ _ (fun id => next id job.id) waiting.2⟩
      cases waiting.1 need isNeed with
      | inl isDone => exact Or.inl (kept _ isDone)
      | inr isAbove => exact moved _ isAbove

theorem Waiting.visits {jobs : List Job} {done : List Str} (needs : List Job) (tree : Str) (stack : List Frame) :
    ∀ above : List Str, Waiting jobs done ((needs.map (·.id)).reverse ++ above) stack →
      Waiting jobs done above (needs.map (Frame.visit · tree) ++ stack) := by
  induction needs with
  | nil => intro above waiting; simpa using waiting
  | cons head tail ih =>
    intro above waiting
    refine ih (head.id :: above) ?_
    simpa using waiting

theorem Good.visits {rank : Str → Nat} (needs : List Job) (tree : Str) (stack : List Frame)
    (below : ∀ need ∈ needs, ∀ id ∈ emitIds stack, rank need.id < rank id) (good : Good rank stack) :
    Good rank (needs.map (Frame.visit · tree) ++ stack) := by
  induction needs with
  | nil => exact good
  | cons head tail ih =>
    refine ⟨?_, ih fun need isNeed => below need (List.mem_cons_of_mem _ isNeed)⟩
    change ∀ id ∈ emitIds (tail.map (Frame.visit · tree) ++ stack), rank head.id < rank id
    rw [emitIds_visits]
    exact below head List.mem_cons_self

theorem byId_mem (jobs : List Job) (id : Str) (job : Job) (found : byId jobs id = some job) : job ∈ jobs :=
  List.mem_reverse.mp (List.mem_of_find?_eq_some found)

theorem needsIn_mem (jobs : List Job) (job : Job) (tree : Str) (need : Job)
    (isNeed : need ∈ needsIn jobs job tree) : need ∈ jobs := by
  obtain ⟨id, _, found⟩ := List.mem_filterMap.mp isNeed
  cases lookup : byId jobs id with
  | none => simp [lookup] at found
  | some candidate =>
    simp only [lookup] at found
    split at found
    · cases found
      exact byId_mem jobs id _ lookup
    · cases found

theorem Ordered.older {jobs : List Job} (newer older : List (Str × Job))
    (ordered : Ordered jobs (newer ++ older)) : Ordered jobs older := by
  induction newer with
  | nil => exact ordered
  | cons head tail ih => exact ih ordered.2

/-- When no job needs itself through any chain of needs — some rank falls along every need — a run lists each
job after everything it needs in its tree. -/
theorem run_ordered (jobs : List Job) (rank : Str → Nat)
    (acyclic : ∀ job ∈ jobs, ∀ tree, ∀ need ∈ needsIn jobs job tree, rank need.id < rank job.id)
    (stack : List Frame) (seen : List Str) (out : List (Str × Job)) :
    (∀ frame ∈ stack, frame.job ∈ jobs) → Accounted stack seen out → Good rank stack →
      Waiting jobs (ids out) [] stack → Ordered jobs out → Ordered jobs (run jobs stack seen out).reverse := by
  fun_induction run jobs stack seen out with
  | case1 seen out =>
    intro _ _ _ _ ordered
    simpa using ordered
  | case2 seen out job tree rest ih =>
    intro members accounted good waiting ordered
    refine ih (fun frame onRest => members frame (List.mem_cons_of_mem _ onRest)) accounted.emit good ?_ ?_
    · refine Waiting.mono (fun id isDone => List.mem_cons_of_mem _ isDone) rest _ _ ?_ waiting.2
      intro id isAbove
      cases isAbove with
      | head => exact Or.inl List.mem_cons_self
      | tail _ isAbove => cases isAbove
    · exact ⟨fun need isNeed => (waiting.1 need isNeed).resolve_right List.not_mem_nil, ordered⟩
  | case3 seen out job tree rest known ih =>
    intro members accounted good waiting ordered
    have isListed : job.id ∈ ids out := by
      cases accounted job.id known with
      | inl isListed => exact isListed
      | inr waits => exact absurd (good.1 job.id waits) (Nat.lt_irrefl _)
    refine ih (fun frame onRest => members frame (List.mem_cons_of_mem _ onRest)) accounted.skip good.2 ?_ ordered
    refine Waiting.mono (fun id isDone => isDone) rest _ _ ?_ waiting
    intro id isAbove
    cases isAbove with
    | head => exact Or.inl isListed
    | tail _ isAbove => cases isAbove
  | case4 seen out job tree rest fresh inJobs ih =>
    intro members accounted good waiting ordered
    have jobIn : job ∈ jobs := members (.visit job tree) List.mem_cons_self
    refine ih ?_ accounted.enter ?_ ?_ ordered
    · intro frame onStack
      cases List.mem_append.mp onStack with
      | inl isNeed =>
        obtain ⟨need, inNeeds, same⟩ := List.mem_map.mp isNeed
        cases same
        exact needsIn_mem jobs job tree need inNeeds
      | inr onRest =>
        cases onRest with
        | head => exact jobIn
        | tail _ onRest => exact members frame (List.mem_cons_of_mem _ onRest)
    · refine Good.visits _ tree _ ?_ good.2
      intro need isNeed id waits
      cases waits with
      | head => exact acyclic job jobIn tree need isNeed
      | tail _ waits => exact Nat.lt_trans (acyclic job jobIn tree need isNeed) (good.1 id waits)
    · refine Waiting.visits _ tree _ [] ⟨fun need isNeed => Or.inr ?_, ?_⟩
      · simpa using ⟨need, isNeed, rfl⟩
      · refine Waiting.mono (fun id isDone => isDone) rest _ _ ?_ waiting
        intro id isAbove
        cases isAbove with
        | head => exact Or.inr List.mem_cons_self
        | tail _ isAbove => cases isAbove
  | case5 seen out job tree rest fresh outside ih =>
    intro members _ _ _ _
    exact absurd (List.mem_map.mpr ⟨job, members (.visit job tree) List.mem_cons_self, rfl⟩) outside

theorem starts_visits (jobs : List Job) :
    ∀ frame ∈ starts jobs, ∃ job tree, frame = Frame.visit job tree ∧ job ∈ jobs := by
  intro frame isStart
  obtain ⟨job, inList, made⟩ := List.mem_filterMap.mp isStart
  have inJobs : job ∈ jobs := by
    cases List.mem_append.mp inList with
    | inl isRoot => exact (List.mem_filter.mp isRoot).1
    | inr inJobs => exact inJobs
  cases shared : job.tree with
  | none => simp [shared] at made
  | some tree =>
    simp only [shared, Option.map_some, Option.some.injEq] at made
    exact ⟨job, tree, made.symm, inJobs⟩

/-- A stack that only goes into jobs has none waiting: it is `Good`, and nothing on it has needs to wait for. -/
theorem visits_only (jobs : List Job) (rank : Str → Nat) (done : List Str) (stack : List Frame)
    (onlyVisits : ∀ frame ∈ stack, ∃ job tree, frame = Frame.visit job tree) :
    emitIds stack = [] ∧ Good rank stack ∧ ∀ above, Waiting jobs done above stack := by
  induction stack with
  | nil => exact ⟨rfl, trivial, fun _ => trivial⟩
  | cons frame rest ih =>
    obtain ⟨none, good, waiting⟩ := ih fun other onRest => onlyVisits other (List.mem_cons_of_mem _ onRest)
    obtain ⟨job, tree, same⟩ := onlyVisits frame List.mem_cons_self
    subst same
    refine ⟨none, ⟨?_, good⟩, fun above => waiting _⟩
    intro id waits
    rw [none] at waits
    cases waits

/-- On a graph of needs with no cycle, `treeOrder` places dependencies before dependents: wherever a job is
listed, every job it needs in its tree is listed before it. `rank` is the witness that no chain of needs comes
back to its start. -/
theorem listed_needs_first (jobs : List Job) (rank : Str → Nat)
    (acyclic : ∀ job ∈ jobs, ∀ tree, ∀ need ∈ needsIn jobs job tree, rank need.id < rank job.id)
    (before after : List (Str × Job)) (tree : Str) (job : Job)
    (split : listed jobs = before ++ (tree, job) :: after) :
    ∀ need ∈ needsIn jobs job tree, need.id ∈ ids before := by
  obtain ⟨_, good, waiting⟩ := visits_only jobs rank (ids []) (starts jobs) fun frame isStart =>
    let ⟨job, tree, same, _⟩ := starts_visits jobs frame isStart
    ⟨job, tree, same⟩
  have members : ∀ frame ∈ starts jobs, frame.job ∈ jobs := by
    intro frame isStart
    obtain ⟨found, itsTree, same, inJobs⟩ := starts_visits jobs frame isStart
    subst same
    exact inJobs
  have ordered : Ordered jobs (listed jobs).reverse :=
    run_ordered jobs rank acyclic (starts jobs) [] [] members (fun _ known => nomatch known) good (waiting [])
      trivial
  rw [split] at ordered
  simp only [List.reverse_append, List.reverse_cons, List.append_assoc, List.singleton_append] at ordered
  intro need isNeed
  have found := (Ordered.older _ _ ordered).1 need isNeed
  simpa [ids] using found

end Plan

/-! ## Script: cycles and hooks -/

namespace Script

/-- A script that is already running is refused at once: this is what ends the walk. -/
theorem leavesOf_running (manager : Manager) (scripts : Scripts) (running : List Str) (script : Str)
    (words : List Str) (isRunning : script ∈ running) :
    leavesOf manager scripts running script words = .error script := by
  rw [leavesOf]
  simp [isRunning]

/-- A script whose first link runs the script itself never ends, and is named as the cycle. -/
theorem expand_self (manager : Manager) (scripts : Scripts) (script : Str) (link : List Str)
    (rest : List (Str × List Str)) :
    expand manager scripts script ((script, link) :: rest) = .error script := by
  simp [expand, leavesOf_running manager scripts [script] script link (by simp), Except.map, bind, Except.bind]

/-- A script with a `pre` or `post` script is run as it is by the link that names it: its hooks run with it. -/
theorem leavesOf_hooked (manager : Manager) (scripts : Scripts) (running : List Str) (script : Str)
    (words : List Str) (hook : Str) (hasHook : hooked scripts script = some hook) (fresh : script ∉ running) :
    leavesOf manager scripts running script words = .ok [{ script, words }] := by
  rw [leavesOf]
  simp [fresh, innerLinks, hasHook]

/-- When the walk of a script's links comes to a script that reaches itself, the step stays whole, for the reason
`script-cycle`, naming that script. -/
theorem decideRun_cycle (step : Step) (read : Read) (scripts : Scripts) (files : Files) (body : Str)
    (links : List (List Str)) (cycle : Str)
    (hasScript : scripts.lookup read.run.script = some body) (chain : linksOf body = .ok links)
    (allRuns : links.find? (fun link => (linkScript link read.run.manager scripts).isNone) = none)
    (reachesItself : expand read.run.manager scripts read.run.script
      (links.filterMap fun link => (linkScript link read.run.manager scripts).map (·, link)) = .error cycle) :
    decideRun step read scripts files = .whole "script-cycle" cycle := by
  simp [decideRun, hasScript, chain, allRuns, reachesItself]

/-- A script that has a `pre` or `post` script is never split: whatever else holds, the step does not become
links. -/
theorem decideRun_hooked (step : Step) (read : Read) (scripts : Scripts) (files : Files) (hook : Str)
    (hasHook : hooked scripts read.run.script = some hook) (links : List (Str × Str)) :
    decideRun step read scripts files ≠ .links links := by
  intro splits
  simp only [decideRun, hasHook] at splits
  split at splits
  · cases splits
  · split at splits
    · split at splits <;> cases splits
    · split at splits
      · split at splits <;> cases splits
      · split at splits
        · cases splits
        · split at splits <;> cases splits

/-- A script that has a hook, is a chain of at least two commands and does not reach itself stays whole for the
reason `script-hook`, naming the hook. -/
theorem decideRun_hook (step : Step) (read : Read) (scripts : Scripts) (files : Files) (body hook : Str)
    (links : List (List Str)) (leaves : List Leaf)
    (hasScript : scripts.lookup read.run.script = some body) (chain : linksOf body = .ok links)
    (allRuns : links.find? (fun link => (linkScript link read.run.manager scripts).isNone) = none)
    (ends : expand read.run.manager scripts read.run.script
      (links.filterMap fun link => (linkScript link read.run.manager scripts).map (·, link)) = .ok leaves)
    (several : 2 ≤ leaves.length) (hasHook : hooked scripts read.run.script = some hook) :
    decideRun step read scripts files = .whole "script-hook" hook := by
  have notFew : ¬ leaves.length < 2 := by omega
  simp [decideRun, hasScript, chain, allRuns, ends, notFew, hasHook]

end Script

end DecomposeSpec

/-
Reference specification of `packages/ci/src/decompose/Shell.vibe`: the reader of a CI step's shell text and the
quoter of one word.

Text is a list of characters (Unicode code points). The implementation works on UTF-16 code units; no character the
reader gives a meaning to is outside the Basic Multilingual Plane, so the two readings agree on every well-formed
string. Offsets are counted in characters here and converted to UTF-16 units where they leave the specification
(`Text.utf16Offset`).
-/

namespace DecomposeSpec

/-- Text: a list of Unicode code points. -/
abbrev Str := List Char

namespace Text

/-- The UTF-16 code units of one character. -/
def utf16Units (c : Char) : List Nat :=
  if c.toNat < 0x10000 then [c.toNat]
  else [0xD800 + (c.toNat - 0x10000) / 0x400, 0xDC00 + (c.toNat - 0x10000) % 0x400]

/-- The UTF-16 offset of the character offset `at` in `text`. -/
def utf16Offset (text : Str) (at_ : Nat) : Nat :=
  ((text.take at_).map fun c => (utf16Units c).length).sum

/-- JavaScript's default order of strings: by UTF-16 code unit. -/
def unitsLe : List Nat → List Nat → Bool
  | [], _ => true
  | _ :: _, [] => false
  | a :: as, b :: bs => a < b || (a == b && unitsLe as bs)

/-- `left <= right` in JavaScript's default order. -/
def jsLe (left right : Str) : Bool := unitsLe (left.flatMap utf16Units) (right.flatMap utf16Units)

/-- `Array.prototype.sort()` of strings. -/
def jsSort (values : List Str) : List Str := values.mergeSort jsLe

/-- The distinct values of a list, each at its first place: `[...new Set(values)]`. -/
def distinct [DecidableEq α] (values : List α) : List α :=
  values.foldl (fun out value => if value ∈ out then out else out ++ [value]) []

/-- `text.split(separator)` for a one-character separator. -/
def splitOn (separator : Char) : Str → List Str
  | [] => [[]]
  | c :: rest =>
    if c = separator then [] :: splitOn separator rest
    else match splitOn separator rest with
      | [] => [[c]]
      | head :: tail => (c :: head) :: tail

/-- `parts.join(separator)`. -/
def joinWith (separator : Str) (parts : List Str) : Str := separator.intercalate parts

/-- `text.includes(needle)`. -/
def contains (needle : Str) : Str → Bool
  | [] => needle.isEmpty
  | c :: rest => needle.isPrefixOf (c :: rest) || contains needle rest

/-- The text after `prefix`, when the text starts with it. -/
def dropPrefix (pre : Str) (text : Str) : Option Str :=
  if pre.isPrefixOf text then some (text.drop pre.length) else none

def isLower (c : Char) : Bool := 'a' ≤ c && c ≤ 'z'
def isUpper (c : Char) : Bool := 'A' ≤ c && c ≤ 'Z'
def isDigit (c : Char) : Bool := '0' ≤ c && c ≤ '9'

/-- `[A-Za-z_]`. -/
def isNameStart (c : Char) : Bool := isLower c || isUpper c || c = '_'

/-- `[A-Za-z0-9_]`, the `\w` of a regular expression without the `u` flag. -/
def isNameChar (c : Char) : Bool := isNameStart c || isDigit c

/-- The `\s` of a JavaScript regular expression, which is also what `String.prototype.trim` removes. -/
def isSpace (c : Char) : Bool :=
  let n := c.toNat
  n = 0x09 || n = 0x0A || n = 0x0B || n = 0x0C || n = 0x0D || n = 0x20 || n = 0xA0 || n = 0x1680 ||
    (0x2000 ≤ n && n ≤ 0x200A) || n = 0x2028 || n = 0x2029 || n = 0x202F || n = 0x205F || n = 0x3000 || n = 0xFEFF

/-- A line terminator: where `^` matches after, under the `m` flag. -/
def isLineEnd (c : Char) : Bool :=
  c = '\n' || c = '\r' || c.toNat = 0x2028 || c.toNat = 0x2029

/-- `text.trim()`. -/
def trim (text : Str) : Str := ((text.dropWhile isSpace).reverse.dropWhile isSpace).reverse

/-- The text from each place `^` matches under the `m` flag: the start, and after each line terminator. -/
def lineStarts (text : Str) : List Str :=
  text :: go text
where
  go : Str → List Str
    | [] => []
    | c :: rest => if isLineEnd c then rest :: go rest else go rest

/-- The leading decimal digits of a text as a number, with what follows them; `none` when there is no digit. -/
def leadingNumber (text : Str) : Option (Nat × Str) :=
  match text.span isDigit with
  | ([], _) => none
  | (digits, rest) => some (digits.foldl (fun n d => n * 10 + (d.toNat - '0'.toNat)) 0, rest)

end Text

namespace Shell

open Text

/-- One word of a command, with its quotes removed. `literal` is false when the word holds a variable. -/
structure Word where
  text : Str
  literal : Bool
  deriving DecidableEq, Repr

/-- What joins a command to the one before it in its list. -/
inductive Joint where
  | first | semi | and | or | pipe | amp
  deriving DecidableEq, Repr

/-- One simple command a step can run. `start` and `stop` bound its words in the source, in characters. -/
structure Command where
  assignments : List (Str × Word)
  words : List Word
  start : Option Nat
  stop : Option Nat
  joint : Joint
  piped : Bool
  background : Bool
  conditional : Bool
  deriving DecidableEq, Repr

/-! ## Lexer -/

/-- A space, a tab and a line break part words, and so does an operator character. Any other blank, such as a
carriage return or a no-break space, is a character of a word, as it is for the shell. -/
def isWordEnd (c : Char) : Bool :=
  c = ' ' || c = '\t' || c = '\n' || c = ';' || c = '&' || c = '|' || c = '<' || c = '>'

/-- Characters that start syntax this reader refuses when they stand bare in a word. -/
def isRefusedBare (c : Char) : Bool :=
  c = '`' || c = '(' || c = ')' || c = '{' || c = '}' || c = '*' || c = '?' || c = '~'

/-- The name after a dollar sign, as written, with the text after it: `NAME`, `{NAME}` or a one-character
parameter. Any other text after a dollar sign is an expansion this reader cannot follow. -/
def variableName : Str → Option (Str × Str)
  | [] => none
  | '{' :: rest =>
    match rest.span isNameChar with
    | (first :: more, '}' :: after) =>
      if isNameStart first then some ('{' :: first :: more ++ ['}'], after) else none
    | _ => none
  | c :: rest =>
    if isNameStart c then
      let (more, after) := rest.span isNameChar
      some (c :: more, after)
    else if c = '?' || c = '!' || c = '$' || c = '#' || isDigit c then some ([c], rest)
    else none

/-- The text inside single quotes and the text after the closing quote. -/
def readSingle : Str → Option (Str × Str)
  | [] => none
  | c :: rest =>
    if c = '\'' then some ([], rest)
    else match readSingle rest with
      | none => none
      | some (inside, after) => some (c :: inside, after)

/-- Reads from after an opening double quote to after the closing one. Inside, a backslash quotes only `"`, `\`,
`$` and a backquote, a backslash before a line break joins two lines, and a dollar sign must name a variable. -/
def readDouble : Nat → Str → Str → Bool → Option (Str × Bool × Str)
  | 0, _, _, _ => none
  | fuel + 1, text, value, literal =>
    match text with
    | [] => none
    | '"' :: rest => some (value, literal, rest)
    | '`' :: _ => none
    | '\\' :: '\n' :: rest => readDouble fuel rest value literal
    | '\\' :: c :: rest =>
      if c = '"' || c = '\\' || c = '$' || c = '`' then readDouble fuel rest (value ++ [c]) literal
      else readDouble fuel (c :: rest) (value ++ ['\\']) literal
    | '$' :: rest =>
      match variableName rest with
      | none => none
      | some (name, after) => readDouble fuel after (value ++ '$' :: name) false
    | c :: rest => readDouble fuel rest (value ++ [c]) literal

/-- What a word holds so far. -/
structure WordState where
  value : Str := []
  literal : Bool := true
  /-- True when a keyword spelled like this word would not be a keyword. -/
  quoted : Bool := false
  /-- True when the word holds a bare `[` or `]`. -/
  bracket : Bool := false
  deriving DecidableEq, Repr

/-- Reads one word to its end: the state it reached and the text after it. `none` for an open quote, a backslash
with nothing after it, an expansion that is not a variable, and a bare character of `isRefusedBare`. -/
def readWordLoop : Nat → Str → WordState → Option (WordState × Str)
  | 0, _, _ => none
  | fuel + 1, text, state =>
    match text with
    | [] => some (state, [])
    | c :: rest =>
      if isWordEnd c then some (state, c :: rest)
      else if c = '\'' then
        match readSingle rest with
        | none => none
        | some (inside, after) => readWordLoop fuel after { state with value := state.value ++ inside, quoted := true }
      else if c = '"' then
        match readDouble (rest.length + 1) rest state.value state.literal with
        | none => none
        | some (value, literal, after) =>
          readWordLoop fuel after { state with value := value, literal := literal, quoted := true }
      else if c = '\\' then
        match rest with
        | [] => none
        | next :: after =>
          readWordLoop fuel after
            { state with value := if next = '\n' then state.value else state.value ++ [next], quoted := true }
      else if c = '$' then
        match variableName rest with
        | none => none
        | some (name, after) =>
          readWordLoop fuel after { state with value := state.value ++ '$' :: name, literal := false }
      else if isRefusedBare c then none
      else
        readWordLoop fuel rest
          { state with value := state.value ++ [c], bracket := state.bracket || c = '[' || c = ']' }

/-- A word of the script, with where it sits. -/
structure WordToken where
  word : Word
  quoted : Bool
  /-- The variable name when the word is `NAME=value`. -/
  assigns : Option Str
  start : Nat
  stop : Nat
  deriving DecidableEq, Repr

/-- The variable a word assigns, read from the word as it is written: `^([A-Za-z_][A-Za-z0-9_]*)=`. -/
def assignmentName (raw : Str) : Option Str :=
  match raw.span isNameChar with
  | (first :: more, '=' :: _) => if isNameStart first then some (first :: more) else none
  | _ => none

/-- Reads the word at the start of `text`, a suffix of a script of `total` characters. `[` and `[[` are commands;
inside any other word a bare bracket is a glob, which is refused. -/
def readWord (total : Nat) (text : Str) : Option (WordToken × Str) :=
  match readWordLoop (text.length + 1) text {} with
  | none => none
  | some (state, rest) =>
    if state.bracket && !(state.value = ['['] || state.value = [']'] || state.value = ['[', '['] ||
        state.value = [']', ']']) then none
    else
      some ({
        word := { text := state.value, literal := state.literal }
        quoted := state.quoted
        assigns := assignmentName (text.take (text.length - rest.length))
        start := total - text.length
        stop := total - rest.length
      }, rest)

/-- An operator between commands. -/
inductive Operator where
  | semi | and | or | pipe | amp
  deriving DecidableEq, Repr

inductive Token where
  | word (token : WordToken)
  | op (operator : Operator)
  | redirect
  deriving DecidableEq, Repr

/-- An output redirection at the start of the text, `^[0-9]?>>?(?:&[0-9])?`: whether it names its own target, as
`2>&1` does, and the text after it. -/
def redirection (text : Str) : Option (Bool × Str) :=
  let afterArrow : Option Str :=
    match text with
    | '>' :: rest => some rest
    | digit :: '>' :: rest => if isDigit digit then some rest else none
    | _ => none
  match afterArrow with
  | none => none
  | some rest =>
    let rest := match rest with
      | '>' :: more => more
      | _ => rest
    match rest with
    | '&' :: digit :: after => if isDigit digit then some (true, after) else some (false, rest)
    | _ => some (false, rest)

/-- The tokens of a script, or `none` when it holds syntax this reader refuses: `;;`, `&>`, `|&`, an input
redirection, a redirection with no target, or a word `readWord` refuses. A `#` where a word would start opens a
comment to the end of its line. -/
def lexLoop (total : Nat) : Nat → Str → List Token → Option (List Token)
  | 0, _, _ => none
  | fuel + 1, text, out =>
    match text with
    | [] => some out.reverse
    | c :: rest =>
      let next := rest.head?
      if c = '\n' || c = ';' then
        if next = some ';' then none else lexLoop total fuel rest (.op .semi :: out)
      else if c = ' ' || c = '\t' then lexLoop total fuel rest out
      else if c = '\\' && next = some '\n' then lexLoop total fuel (rest.drop 1) out
      else if c = '#' then lexLoop total fuel (rest.dropWhile (· ≠ '\n')) out
      else if c = '&' then
        if next = some '>' then none
        else if next = some '&' then lexLoop total fuel (rest.drop 1) (.op .and :: out)
        else lexLoop total fuel rest (.op .amp :: out)
      else if c = '|' then
        if next = some '&' then none
        else if next = some '|' then lexLoop total fuel (rest.drop 1) (.op .or :: out)
        else lexLoop total fuel rest (.op .pipe :: out)
      else if c = '<' then none
      else
        match redirection (c :: rest) with
        | none =>
          match readWord total (c :: rest) with
          | none => none
          | some (token, after) => lexLoop total fuel after (.word token :: out)
        | some (true, after) => lexLoop total fuel after (.redirect :: out)
        | some (false, after) =>
          -- `2>&1` names its own target; any other redirection takes the next word.
          match readWord total (after.dropWhile fun blank => blank = ' ' || blank = '\t') with
          | none => none
          | some (target, afterTarget) =>
            if target.stop = target.start then none else lexLoop total fuel afterTarget (.redirect :: out)

def lex (script : Str) : Option (List Token) := lexLoop script.length (script.length + 1) script []

/-! ## Parser -/

def keywordIf : Str := ['i', 'f']
def keywordThen : Str := ['t', 'h', 'e', 'n']
def keywordElif : Str := ['e', 'l', 'i', 'f']
def keywordElse : Str := ['e', 'l', 's', 'e']
def keywordFi : Str := ['f', 'i']

/-- The keywords that end a branch of an `if`. -/
def branchKeywords : List Str := [keywordThen, keywordElif, keywordElse, keywordFi]

/-- The keywords of syntax this reader refuses. -/
def refusedKeywords : List Str :=
  ["for", "while", "until", "do", "done", "case", "esac", "function", "select", "time"].map String.toList

/-- The word a token spells when it could be a shell keyword: unquoted and with no variable. -/
def bareWord : Option Token → Option Str
  | some (.word token) => if !token.quoted && token.word.literal then some token.word.text else none
  | _ => none

/-- True when the next token spells `keyword` bare. -/
def atKeyword (keyword : Str) (tokens : List Token) : Bool := bareWord tokens.head? = some keyword

def isSemi : Token → Bool
  | .op .semi => true
  | _ => false

def jointOf : Operator → Joint
  | .semi => .semi
  | .and => .and
  | .or => .or
  | .pipe => .pipe
  | .amp => .amp

/-- `a &&`, `a ||` and `a |` with no command after them are not a script. -/
def Joint.complete (joint : Joint) : Bool := joint ≠ .and && joint ≠ .or && joint ≠ .pipe

/-- What a simple command holds so far. -/
structure SimpleState where
  assignments : List (Str × Word) := []
  words : List Word := []
  start : Option Nat := none
  stop : Option Nat := none
  replaceable : Bool := true
  redirected : Bool := false

/-- Takes tokens up to the next operator: assignments before the first word, then words, with redirections
anywhere. A redirection between two words leaves the command with no place to replace. -/
def simpleLoop : List Token → SimpleState → SimpleState × List Token
  | [], state => (state, [])
  | .op operator :: rest, state => (state, .op operator :: rest)
  | .redirect :: rest, state => simpleLoop rest { state with redirected := true }
  | .word token :: rest, state =>
    match state.words, token.assigns with
    | [], some name =>
      simpleLoop rest { state with
        assignments := state.assignments ++
          [(name, { text := token.word.text.drop (name.length + 1), literal := token.word.literal })] }
    | words, _ =>
      simpleLoop rest { state with
        words := words ++ [token.word]
        start := if words.isEmpty then some token.start else state.start
        stop := some token.stop
        replaceable := state.replaceable && (words.isEmpty || !state.redirected)
        redirected := false }

/-- One simple command and the tokens after it, or `none` when there is no word and no assignment. -/
def readSimple (tokens : List Token) (joint : Joint) (conditional : Bool) : Option (Command × List Token) :=
  let (state, rest) := simpleLoop tokens {}
  if state.words.isEmpty && state.assignments.isEmpty then none
  else
    some ({
      assignments := state.assignments
      words := state.words
      start := if state.replaceable then state.start else none
      stop := if state.replaceable then state.stop else none
      joint := joint
      piped := false
      background := false
      conditional := conditional
    }, rest)

/-- The value of a test the shell computes from literal words alone, or `none` when it depends on anything else. -/
def staticTest (condition : List Command) : Option Bool :=
  match condition with
  | [command] =>
    if !command.assignments.isEmpty || command.piped || command.background then none
    else if command.words.any (fun word => !word.literal) then none
    else
      let words := command.words.map (·.text)
      let operands : Option (List Str) :=
        if words.head? = some ['['] && words.getLast? = some [']'] then some (words.drop 1).dropLast
        else if words.head? = some ['t', 'e', 's', 't'] then some (words.drop 1)
        else none
      match operands with
      | none => none
      | some operands =>
        let negated := operands.head? = some ['!']
        let rest := if negated then operands.drop 1 else operands
        let value : Option Bool :=
          match rest with
          | [left, middle] =>
            if left = ['-', 'n'] then some (middle ≠ [])
            else if left = ['-', 'z'] then some (middle = [])
            else none
          | [left, middle, right] =>
            if middle = ['='] || middle = ['=', '='] then some (left = right)
            else if middle = ['!', '='] then some (left ≠ right)
            else none
          | _ => none
        value.map (· != negated)
  | _ => none

/-- Commands an `if` may or may not run. -/
def uncertain (list : List Command) : List Command := list.map ({ · with conditional := true })

mutual

/-- Reads commands until the tokens end or, inside an `if` (`stops`), a branch keyword is next. Outside an `if`
the list must reach the end of the script. Gives the tokens left and the commands read after `out`. -/
def readList : Nat → Bool → Bool → Joint → List Token → List Command → Option (List Token × List Command)
  | 0, _, _, _, _, _ => none
  | fuel + 1, stops, conditional, joint, tokens, out =>
    match tokens.dropWhile isSemi with
    | [] => if !stops && joint.complete then some ([], out) else none
    | token :: rest =>
      let keyword := bareWord (some token)
      if stops && keyword.any (branchKeywords.contains ·) then
        if joint.complete then some (token :: rest, out) else none
      else if keyword.any (fun word => branchKeywords.contains word || refusedKeywords.contains word) then none
      else if keyword = some keywordIf then
        -- An `if` stands alone: nothing may join it to a neighbour but a separator.
        if joint ≠ .first && joint ≠ .semi then none
        else
          match readIf fuel conditional (token :: rest) out true true with
          | none => none
          | some (after, out) =>
            let separated := match after with
              | [] => true
              | next :: _ => isSemi next || (stops && (bareWord (some next)).any (branchKeywords.contains ·))
            if separated then readList fuel stops conditional .semi after out else none
      else
        match readSimple (token :: rest) joint conditional with
        | none => none
        | some (command, .op operator :: after) =>
          readList fuel stops conditional (jointOf operator) after
            (out ++ [{ command with piped := operator = .pipe, background := operator = .amp }])
        | some (command, after) => readList fuel stops conditional .semi after (out ++ [command])

/-- Reads from `if` or `elif` to `fi`. A branch whose test is computed false is dropped; one computed true ends
the chain, and runs for certain when every test before it was computed false. -/
def readIf : Nat → Bool → List Token → List Command → Bool → Bool → Option (List Token × List Command)
  | 0, _, _, _, _, _ => none
  | fuel + 1, conditional, tokens, out, isOpen, certain =>
    match readList fuel true conditional .first (tokens.drop 1) [] with
    | none => none
    | some (afterCondition, condition) =>
      if !atKeyword keywordThen afterCondition then none
      else
        match readList fuel true conditional .first (afterCondition.drop 1) [] with
        | none => none
        | some (afterBody, body) =>
          let known := staticTest condition
          let taken := isOpen && known = some true
          let unknown := isOpen && known = none
          let out :=
            if taken then out ++ (if certain then body else uncertain body)
            else if unknown then out ++ condition ++ uncertain body
            else out
          let isOpen := isOpen && !taken
          let certain := certain && !unknown
          if atKeyword keywordElif afterBody then readIf fuel conditional afterBody out isOpen certain
          else
            let otherwise : Option (List Token × List Command) :=
              if atKeyword keywordElse afterBody then
                match readList fuel true conditional .first (afterBody.drop 1) [] with
                | none => none
                | some (afterElse, branch) =>
                  some (afterElse, if isOpen then out ++ (if certain then branch else uncertain branch) else out)
              else some (afterBody, out)
            match otherwise with
            | none => none
            | some (afterElse, out) => if atKeyword keywordFi afterElse then some (afterElse.drop 1, out) else none

end

/-- The commands a list of tokens can run, or `none` when they are not a script this reader understands. -/
def parse (tokens : List Token) : Option (List Command) :=
  match readList (2 * tokens.length + 4) false false .first tokens [] with
  | some ([], out) => some out
  | _ => none

/-- The simple commands a script can run, in order, or `none` when the script holds anything this reader does not
understand. -/
def commands (script : Str) : Option (List Command) :=
  match lex script with
  | none => none
  | some tokens => parse tokens

/-! ## Quoter -/

/-- A word character or one of `@ % + = : , . / -`: a character a POSIX shell reads as itself. -/
def isSafe (c : Char) : Bool :=
  isNameChar c || c = '@' || c = '%' || c = '+' || c = '=' || c = ':' || c = ',' || c = '.' || c = '/' || c = '-'

/-- One character inside single quotes: a single quote closes them, is written quoted by a backslash, and opens
them again. -/
def escapeQuote (c : Char) : Str := if c = '\'' then ['\'', '\\', '\'', '\''] else [c]

/-- Quotes one word for a POSIX shell. A word with nothing special stays bare. -/
def quote (word : Str) : Str :=
  if !word.isEmpty && word.all isSafe then word else '\'' :: (word.flatMap escapeQuote ++ ['\''])

end Shell
end DecomposeSpec

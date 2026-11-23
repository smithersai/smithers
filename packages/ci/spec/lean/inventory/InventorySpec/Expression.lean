/-
GitHub Actions expressions: the text inside `${{ }}` and after `if:`.

The reference for `packages/ci/src/inventory/Expression.ts`, and for the verdict `settled` of `Runner.ts`. An
expression is evaluated as far as the workflow file allows. What is known before the job runs becomes a value.
What is only known while the job runs stays in the result as a variable. What cannot be known either way is a
problem, and an expression that reads a secret says which.
-/
import InventorySpec.Json

namespace InventorySpec

/-! ## Tokens -/

/-- One token of an expression. -/
inductive Token where
  | symbol (text : String)
  | number (text : String)
  | string (text : String)
  | word (text : String)

/-- The text of a token, as a problem quotes it. -/
def Token.text : Token → String
  | .symbol text => text
  | .number text => text
  | .string text => text
  | .word text => text

/-- The symbols, longest first where one starts another. -/
def symbols : List String :=
  ["&&", "||", "==", "!=", "<=", ">=", "(", ")", "[", "]", ",", ".", "!", "<", ">", "*"]

/-- The symbol a text starts with. -/
def symbolAt (text : List Char) : Option String :=
  symbols.find? fun symbol => symbol.toList.isPrefixOf text

/-- Whether a character is a hexadecimal digit. -/
def isHexDigit (c : Char) : Bool := (hexValue? c).isSome

/-- The number a text starts with, and the text after it: `-?(0x[0-9a-f]+|(\d+\.?\d*|\.\d+)(e[+-]?\d+)?)` without case. -/
def scanNumber (text : List Char) : Option (List Char × List Char) :=
  let (sign, body) := match text with
    | '-' :: rest => (['-'], rest)
    | _ => ([], text)
  let hexadecimal : Option (List Char × List Char) := match body with
    | '0' :: x :: after =>
      let (digits, rest) := after.span isHexDigit
      if (x == 'x' || x == 'X') && !digits.isEmpty then some ('0' :: x :: digits, rest) else none
    | _ => none
  match hexadecimal with
  | some (written, rest) => some (sign ++ written, rest)
  | none => (scanDecimal body).map fun (_, rest) => (sign ++ body.take (body.length - rest.length), rest)

/-- Whether a character starts a word. -/
def isWordStart (c : Char) : Bool := ('A' ≤ c && c ≤ 'Z') || ('a' ≤ c && c ≤ 'z') || c == '_'

/-- Whether a character goes on a word. -/
def isWordPart (c : Char) : Bool := isWordStart c || isDigit c || c == '-'

/-- A string from after its opening quote, where `''` writes a quote: its text, and the text after its closing quote. -/
def scanString : List Char → List Char → Option (List Char × List Char)
  | [], _ => none
  | '\'' :: '\'' :: rest, text => scanString rest ('\'' :: text)
  | '\'' :: rest, text => some (text.reverse, rest)
  | c :: rest, text => scanString rest (c :: text)

/-- The first UTF-16 code unit of a character in double quotes, as `JSON.stringify` writes it. -/
def quoteFirstUnit (c : Char) : String :=
  match utf16 [c] with
  | [_, _] => String.ofList ('"' :: '\\' :: 'u' :: hexDigits (0xD800 + (c.toNat - 0x10000) / 0x400) 4 ++ ['"'])
  | _ => String.ofList (quoteJson [c])

/-- Splits an expression into tokens. Each step takes at least one character, so `fuel` is never short. -/
def tokenizeFrom : Nat → List Char → List Token → Except String (List Token)
  | _, [], tokens => .ok tokens.reverse
  | 0, _ :: _, tokens => .ok tokens.reverse
  | fuel + 1, c :: rest, tokens =>
    let text := c :: rest
    if isSpace c then tokenizeFrom fuel (rest.dropWhile isSpace) tokens
    else if c == '\'' then
      match scanString rest [] with
      | none => .error "a string has no closing quote"
      | some (held, rest) => tokenizeFrom fuel rest (.string (String.ofList held) :: tokens)
    else
      let symbol := symbolAt text
      match scanNumber text, symbol with
      | some (written, rest), none => tokenizeFrom fuel rest (.number (String.ofList written) :: tokens)
      | number, some symbol =>
        match number with
        | some (written, rest) =>
          if symbol == "." then tokenizeFrom fuel rest (.number (String.ofList written) :: tokens)
          else tokenizeFrom fuel (text.drop symbol.length) (.symbol symbol :: tokens)
        | none => tokenizeFrom fuel (text.drop symbol.length) (.symbol symbol :: tokens)
      | none, none =>
        if isWordStart c then
          let (more, rest) := rest.span isWordPart
          tokenizeFrom fuel rest (.word (String.ofList (c :: more)) :: tokens)
        else .error (quoteFirstUnit c ++ " is not part of an expression")

/-- The tokens of an expression, or why it has none. -/
def tokenize (text : String) : Except String (List Token) :=
  tokenizeFrom text.length text.toList []

/-! ## The tree -/

/-- An operator between two values. -/
inductive Operator where
  | lt | le | gt | ge | eq | ne | and | or
  deriving DecidableEq, Inhabited

/-- An operator as it is written. -/
def Operator.text : Operator → String
  | .lt => "<" | .le => "<=" | .gt => ">" | .ge => ">=" | .eq => "==" | .ne => "!=" | .and => "&&" | .or => "||"

/-- An expression as written. -/
inductive Node where
  | literal (value : Value)
  | name (name : String)
  | member (object property : Node)
  | star (object : Node)
  | not (operand : Node)
  | binary (operator : Operator) (left right : Node)
  | call (name : String) (args : List Node)
  deriving Inhabited

/-- The operators by how tightly they bind, loosest first, as GitHub orders them. -/
def levels : List (List Operator) := [[.or], [.and], [.eq, .ne], [.lt, .le, .gt, .ge]]

/-- The operator of a level a symbol is. -/
def operatorAt (level : Nat) (symbol : String) : Option Operator :=
  (levels.getD level []).find? fun operator => operator.text == symbol

/-- The words that are values. -/
def keyword? (word : String) : Option Value :=
  match lowerString word with
  | "true" => some (.bool true)
  | "false" => some (.bool false)
  | "null" => some .null
  | "nan" => some (.num nan)
  | "infinity" => some (.num (infinity false))
  | _ => none

/-- The number a number token names. The sign is applied after reading, so `-0` and `-0x0` are negative zero. -/
def numberOfToken (text : String) : Float :=
  let (negative, body) := match text.toList with
    | '-' :: rest => (true, rest)
    | chars => (false, chars)
  match body with
  | '0' :: 'x' :: digits => ratToFloat negative ((digitsValue? 16 digits).getD 0) 1
  | '0' :: 'X' :: digits => ratToFloat negative ((digitsValue? 16 digits).getD 0) 1
  | _ => match scanDecimal body with
    | some (decimal, _) => decimal.toFloat negative
    | none => nan

/-- A text in double quotes, as a problem shows it. -/
def quoted (text : String) : String := String.ofList (quoteJson text.toList)

/-- What reading says when an expression nests deeper than it can follow. -/
def tooDeep : String := "it nests too deep to read"

/-- Takes one symbol, or says it is missing. -/
def expectSymbol (symbol : String) : List Token → Except String (List Token)
  | .symbol found :: rest => if found == symbol then .ok rest else .error (quoted symbol ++ " is missing")
  | _ => .error (quoted symbol ++ " is missing")

mutual
  /-- An operand of the operators of `level`, and the tokens after it. -/
  def parseBinary : Nat → Nat → List Token → Except String (Node × List Token)
    | 0, _, _ => .error tooDeep
    | fuel + 1, level, tokens =>
      if level ≥ levels.length then parseUnary fuel tokens
      else match parseBinary fuel (level + 1) tokens with
        | .error why => .error why
        | .ok (left, rest) => parseBinaryRest fuel level left rest

  /-- The operators of `level` after `left`, joined from the left. -/
  def parseBinaryRest : Nat → Nat → Node → List Token → Except String (Node × List Token)
    | 0, _, _, _ => .error tooDeep
    | fuel + 1, level, left, tokens =>
      match tokens with
      | .symbol symbol :: rest =>
        match operatorAt level symbol with
        | none => .ok (left, tokens)
        | some operator =>
          match parseBinary fuel (level + 1) rest with
          | .error why => .error why
          | .ok (right, rest) => parseBinaryRest fuel level (.binary operator left right) rest
      | _ => .ok (left, tokens)

  /-- `!` any number of times before a value. -/
  def parseUnary : Nat → List Token → Except String (Node × List Token)
    | 0, _ => .error tooDeep
    | fuel + 1, tokens =>
      match tokens with
      | .symbol "!" :: rest =>
        match parseUnary fuel rest with
        | .error why => .error why
        | .ok (operand, rest) => .ok (.not operand, rest)
      | _ =>
        match parsePrimary fuel tokens with
        | .error why => .error why
        | .ok (node, rest) => parsePostfix fuel node rest

  /-- `.name`, `.*` and `[index]` after a value. -/
  def parsePostfix : Nat → Node → List Token → Except String (Node × List Token)
    | 0, _, _ => .error tooDeep
    | fuel + 1, node, tokens =>
      match tokens with
      | .symbol "." :: rest =>
        match rest with
        | .symbol "*" :: rest => parsePostfix fuel (.star node) rest
        | .word name :: rest => parsePostfix fuel (.member node (.literal (.str name))) rest
        | _ => .error "a property name is missing after a dot"
      | .symbol "[" :: rest =>
        match parseBinary fuel 0 rest with
        | .error why => .error why
        | .ok (property, rest) =>
          match expectSymbol "]" rest with
          | .error why => .error why
          | .ok rest => parsePostfix fuel (.member node property) rest
      | _ => .ok (node, tokens)

  /-- A literal, a name, a call, or an expression in parentheses. -/
  def parsePrimary : Nat → List Token → Except String (Node × List Token)
    | 0, _ => .error tooDeep
    | fuel + 1, tokens =>
      match tokens with
      | [] => .error "the expression ends early"
      | .string held :: rest => .ok (.literal (.str held), rest)
      | .number written :: rest => .ok (.literal (.num (numberOfToken written)), rest)
      | .word word :: rest =>
        match rest with
        | .symbol "(" :: rest =>
          match rest with
          | .symbol ")" :: rest => .ok (.call (lowerString word) [], rest)
          | _ => match parseArgs fuel rest [] with
            | .error why => .error why
            | .ok (args, rest) => .ok (.call (lowerString word) args, rest)
        | _ => .ok ((keyword? word).elim (.name word) .literal, rest)
      | .symbol symbol :: rest =>
        if symbol != "(" then .error (quoted symbol ++ " is not expected here")
        else match parseBinary fuel 0 rest with
          | .error why => .error why
          | .ok (inner, rest) =>
            match expectSymbol ")" rest with
            | .error why => .error why
            | .ok rest => .ok (inner, rest)

  /-- The values of a call from after `(` or a comma, to its `)`. -/
  def parseArgs : Nat → List Token → List Node → Except String (List Node × List Token)
    | 0, _, _ => .error tooDeep
    | fuel + 1, tokens, args =>
      match parseBinary fuel 0 tokens with
      | .error why => .error why
      | .ok (arg, rest) =>
        match rest with
        | .symbol "," :: rest => parseArgs fuel rest (arg :: args)
        | _ => match expectSymbol ")" rest with
          | .error why => .error why
          | .ok rest => .ok ((arg :: args).reverse, rest)
end

/-- Reads tokens into a tree. Every step down the tree is paid for by a token, so the fuel is never short. -/
def parseTokens (tokens : List Token) : Except String Node :=
  match parseBinary (10 * tokens.length + 20) 0 tokens with
  | .error why => .error why
  | .ok (node, []) => .ok node
  | .ok (_, token :: _) => .error (quoted token.text ++ " is not expected here")

/-- Reads an expression into a tree, or says why it is none. -/
def parse (text : String) : Except String Node :=
  match tokenize text with
  | .error why => .error why
  | .ok tokens => parseTokens tokens

/-! ## Values -/

/--
The number GitHub converts a value to when two types are compared: `null` is 0, `true` is 1, an empty string is
0, other text is the number it spells or `NaN`, and a list or mapping is `NaN`.
-/
def toNumber : Value → Float
  | .null => 0
  | .num x => x
  | .bool b => if b then 1 else 0
  | .str s =>
    let text := trim s.toList
    if text.isEmpty then 0
    else
      let (negative, unsigned) := match text with
        | '-' :: rest => (true, rest)
        | '+' :: rest => (false, rest)
        | _ => (false, text)
      match scanDecimal unsigned with
      | some (decimal, []) => decimal.toFloat negative
      | _ => match text with
        | '0' :: radix :: digits =>
          if digits.isEmpty || !digits.all isHexDigit then nan
          else if radix == 'x' || radix == 'X' then ratToFloat false ((digitsValue? 16 digits).getD 0) 1
          else if radix == 'o' || radix == 'O' then
            match digitsValue? 8 digits with
            | some n => ratToFloat false n 1
            | none => nan
          else nan
        | _ => nan
  | .arr _ _ => nan
  | .obj _ _ => nan

/-- The text GitHub writes for a value: `null` is empty, a list is `Array` and a mapping is `Object`. -/
def toText : Value → String
  | .null => ""
  | .str s => s
  | .num x => String.ofList (numberText x)
  | .bool b => if b then "true" else "false"
  | .arr _ _ => "Array"
  | .obj _ _ => "Object"

/-- Whether a value counts as true: everything but `false`, `0`, `NaN`, the empty string and `null`. -/
def truthy : Value → Bool
  | .null => false
  | .bool b => b
  | .str s => !s.isEmpty
  | .num x => !(x == 0 || x.isNaN)
  | .arr _ _ => true
  | .obj _ _ => true

/-- The types `==` tells apart. -/
inductive Kind where
  | null | boolean | number | string | array | object
  deriving DecidableEq

/-- The type of a value. -/
def typeOf : Value → Kind
  | .null => .null
  | .bool _ => .boolean
  | .num _ => .number
  | .str _ => .string
  | .arr _ _ => .array
  | .obj _ _ => .object

/-- `==`: values of two types are compared as numbers, text without case, and a list or mapping only with itself. -/
def equal (left right : Value) : Bool :=
  match left, right with
  | .null, .null => true
  | .bool a, .bool b => a == b
  | .num a, .num b => a == b
  | .str a, .str b => fold a.toList == fold b.toList
  | .arr a _, .arr b _ => a != 0 && a == b
  | .obj a _, .obj b _ => a != 0 && a == b
  | _, _ => toNumber left == toNumber right

/-- `<` on two values: text without case when both are text, and numbers otherwise. -/
def less (left right : Value) : Bool :=
  match left, right with
  | .str a, .str b => textLt (fold a.toList) (fold b.toList)
  | _, _ => toNumber left < toNumber right

/-- `<=` on two values. With `NaN` on a side it is false, as `<` is. -/
def lessOrEqual (left right : Value) : Bool :=
  match left, right with
  | .str a, .str b => !textLt (fold b.toList) (fold a.toList)
  | _, _ => toNumber left ≤ toNumber right

/-- What a comparison gives. `&&` and `||` are not comparisons, and give what they are given. -/
def compare (operator : Operator) (left right : Value) : Bool :=
  match operator with
  | .eq => equal left right
  | .ne => !equal left right
  | .lt => less left right
  | .le => lessOrEqual left right
  | .gt => less right left
  | _ => lessOrEqual right left

/-- Whether a value is neither a list nor a mapping. -/
def primitive : Value → Bool
  | .arr _ _ => false
  | .obj _ _ => false
  | _ => true

/-- One piece of a `format` template: text, or the number of the value that goes there. -/
inductive Piece where
  | text (text : String)
  | index (number : Float)

/-- The pieces of a template from one place on. -/
def formatPiecesFrom : Nat → List Char → List Char → List Piece → Option (List Piece)
  | _, [], before, pieces => some (.text (String.ofList before.reverse) :: pieces).reverse
  | 0, _ :: _, _, _ => none
  | fuel + 1, c :: rest, before, pieces =>
    let flush := Piece.text (String.ofList before.reverse) :: pieces
    if c == '{' then
      match rest with
      | '{' :: rest => formatPiecesFrom fuel rest [] (.text "{" :: flush)
      | _ =>
        let (digits, after) := rest.span isDigit
        match after with
        | '}' :: after =>
          if digits.isEmpty then none
          else formatPiecesFrom fuel after [] (.index (decToFloat false (decimalValue digits) 0) :: flush)
        | _ => none
    else if c == '}' then
      match rest with
      | '}' :: rest => formatPiecesFrom fuel rest [] (.text "}" :: flush)
      | _ => none
    else formatPiecesFrom fuel rest (c :: before) pieces

/--
The pieces of a `format` template: text, and the number of the value that goes between. `{{` and `}}` write a
brace. `none` for a template with a brace that is neither.
-/
def formatPieces (template : String) : Option (List Piece) :=
  formatPiecesFrom template.length template.toList [] []

/-- Why an evaluation stops: a problem, or the secret it reads. -/
inductive Stop where
  | problem (why : String)
  | secret (name : String)

/-- The text of a template's pieces, with each numbered value in its place. -/
def fillPieces (values : List Value) : List Piece → Except Stop String
  | [] => .ok ""
  | .text text :: rest => (fillPieces values rest).map (text ++ ·)
  | .index number :: rest =>
    match (floatNat? number).bind (values[·]?) with
    | some held => (fillPieces values rest).map (toText held ++ ·)
    | none => .error (.problem ("format has no value for {" ++ String.ofList (jsNumberText number) ++ "}"))

/-- `format('{0} and {1}', a, b)`. -/
def format (template : Value) (values : List Value) : Except Stop String :=
  match formatPieces (toText template) with
  | none => .error (.problem "format was given a template with a brace that names no value")
  | some pieces => fillPieces values pieces

/-- The text of two values that are not lists or mappings, without case. -/
def texts (left right : Value) : Option (List Char × List Char) :=
  if primitive left && primitive right then some (fold (toText left).toList, fold (toText right).toList) else none

/-- `contains`: an entry of a list equal to the item, or the item's text inside the text. -/
def contains (search item : Value) : Bool :=
  match search with
  | .arr _ items => items.any fun entry => equal entry item
  | _ => match texts search item with
    | some (text, part) => includes part text
    | none => false

/-- `startsWith`. -/
def startsWithValue (text start : Value) : Bool :=
  match texts text start with
  | some (text, start) => startsWith start text
  | none => false

/-- `endsWith`. -/
def endsWithValue (text ending : Value) : Bool :=
  match texts text ending with
  | some (text, ending) => startsWith ending.reverse text.reverse
  | none => false

/-- `join`: the entries of a list as text with the separator between, a comma when none is given. -/
def join (items : Value) (separator : Option Value) : String :=
  match items with
  | .arr _ entries => String.intercalate (separator.elim "," toText) (entries.map toText)
  | _ => toText items

/-- The functions whose arguments are all known, with the fewest and the most values each takes. -/
def arity? (name : String) : Option (Nat × Option Nat) :=
  match name with
  | "contains" => some (2, some 2)
  | "startswith" => some (2, some 2)
  | "endswith" => some (2, some 2)
  | "format" => some (1, none)
  | "join" => some (1, some 2)
  | "tojson" => some (1, some 1)
  | "fromjson" => some (1, some 1)
  | _ => none

/--
What a function gives for known values. A name that is no function, or a count of values no function takes, only
reaches here in an expression put together by hand, and the implementation then says what is said here.
-/
def apply (name : String) (args : List Value) : Except Stop Value :=
  match name, args with
  | "contains", [search, item] => .ok (.bool (contains search item))
  | "startswith", [text, start] => .ok (.bool (startsWithValue text start))
  | "endswith", [text, ending] => .ok (.bool (endsWithValue text ending))
  | "format", template :: values => (format template values).map .str
  | "join", [items] => .ok (.str (join items none))
  | "join", [items, separator] => .ok (.str (join items (some separator)))
  | "tojson", [held] => .ok (.str (toJson held))
  | "fromjson", [text] =>
    match parseJson (toText text) with
    | some held => .ok held
    | none => .error (.problem "fromJSON was given text that is not JSON")
  | _, _ => .error (.problem tooDeep)

/--
A property of a known value. Names are read without case; what is not there is `null`. Only an entry of the list
or a field of the mapping is ever given: nothing a value inherits can be read.
-/
def property (held name : Value) : Value :=
  match held with
  | .arr _ items =>
    match name with
    | .num index => ((floatNat? index).bind (items[·]?)).getD .null
    | _ => .null
  | .obj _ fields =>
    let wanted := lowerString (toText name)
    ((fields.find? fun (key, _) => lowerString key == wanted).map (·.2)).getD .null
  | _ => .null

/-! ## Evaluation -/

/--
A text value known only while the job runs. `id` says where the step finds it and `name` is how the workflow
wrote it. A `nullable` variable may be absent. A `typed` variable is a number or a boolean on GitHub.
-/
structure Variable where
  id : String
  name : String
  nullable : Bool
  typed : Bool

/-- An expression with everything known before the run worked out. -/
inductive Residual where
  | literal (value : Value)
  | var (read : Variable)
  | not (operand : Residual)
  | binary (operator : Operator) (left right : Residual)
  | call (name : String) (args : List Residual)
  deriving Inhabited

/--
What a name such as `github` or `steps.build.outputs` stands for: a value, an expression still to finish, a
mapping whose fields are looked up one at a time (`exact` when the names keep their case), something nobody can
know here, or a secret.
-/
inductive Context where
  | value (value : Value)
  | residual (residual : Residual)
  | fields (exact : Bool) (entries : List (String × Context))
  | unknown (why : String)
  | secret (name : String)
  deriving Inhabited

/-- What the status functions give where the expression stands. -/
structure Status where
  success : Bool
  always : Bool
  cancelled : Bool
  failure : Bool

/-- What `hashFiles` gives where the expression stands: its patterns as a list, or one context whatever they are. -/
inductive HashFiles where
  | echo
  | fixed (context : Context)

/--
Where an expression is evaluated: the contexts by name in lower case, the status functions when the place allows
them, and `hashFiles` when it does.
-/
structure Scope where
  contexts : List (String × Context)
  status : Option Status
  hashFiles : Option HashFiles

/-- The status functions. -/
def statusNames : List String := ["success", "always", "cancelled", "failure"]

/-- What one status function gives. -/
def Status.get (status : Status) (name : String) : Bool :=
  match name with
  | "success" => status.success
  | "always" => status.always
  | "cancelled" => status.cancelled
  | _ => status.failure

/-- What a path through the contexts reaches: a context, or what `.*` gives. -/
inductive Found where
  | context (context : Context)
  | each (items : List Value)

/-- The one value or unfinished expression that was found, or why there is none. -/
def settle (what : String) : Found → Except Stop Residual
  | .context (.value held) => .ok (.literal held)
  | .each items => .ok (.literal (.arr 0 items))
  | .context (.residual residual) => .ok residual
  | .context (.secret name) => .error (.secret name)
  | .context (.unknown why) => .error (.problem why)
  | .context (.fields _ _) => .error (.problem (what ++ " is not one value"))

/-- The value of an expression that must be known before the job runs. -/
def known (what : String) : Residual → Except Stop Value
  | .literal held => .ok held
  | _ => .error (.problem (what ++ " is decided while the job runs"))

/-- A field of a mapping context. A name it does not hold is `null`, as a missing property is. -/
def fieldOf (exact : Bool) (entries : List (String × Context)) (name : String) : Context :=
  (entries.lookup (if exact then name else lowerString name)).getD (.value .null)

/-- What `!` gives. -/
def notOf : Residual → Residual
  | .literal held => .literal (.bool (!truthy held))
  | operand => .not operand

/-- What a comparison gives once both sides are evaluated. -/
def compareOf (operator : Operator) : Residual → Residual → Residual
  | .literal left, .literal right => .literal (.bool (compare operator left right))
  | left, right => .binary operator left right

/-- The values of residuals that are all known. -/
def literals? : List Residual → Option (List Value)
  | [] => some []
  | .literal held :: rest => (literals? rest).map (held :: ·)
  | _ :: _ => none

mutual
  /--
  What a node stands for. A name, a property and `.*` are looked up in the contexts. Anything else is evaluated,
  and is then an expression that is finished or still to finish.
  -/
  def look (scope : Scope) : Node → Except Stop Found
    | .literal held => .ok (.context (.residual (.literal held)))
    | .name name =>
      .ok (.context ((scope.contexts.lookup (lowerString name)).getD
        (.unknown (name ++ " is not a context an expression can read"))))
    | .star object =>
      match look scope object with
      | .error stop => .error stop
      | .ok found =>
        match settle "the value before .*" found with
        | .error stop => .error stop
        | .ok (.literal (.arr _ items)) => .ok (.each items)
        | .ok (.literal (.obj _ fields)) => .ok (.each (fields.map (·.2)))
        | .ok (.literal _) => .ok (.each [])
        | .ok _ => .error (.problem "the value before .* is decided while the job runs")
    | .member object property =>
      match look scope object with
      | .error stop => .error stop
      | .ok (.context (.unknown why)) => .ok (.context (.unknown why))
      | .ok (.context (.secret name)) => .ok (.context (.secret name))
      | .ok owner =>
        match (look scope property).bind (settle "this context") |>.bind (known "a property name") with
        | .error stop => .error stop
        | .ok name =>
          match owner with
          | .context (.fields exact entries) => .ok (.context (fieldOf exact entries (toText name)))
          | .each items =>
            .ok (.each ((items.map fun item => InventorySpec.property item name).filter fun item =>
              match item with
              | .null => false
              | _ => true))
          | .context (.value held) => .ok (.context (.value (InventorySpec.property held name)))
          | .context (.residual (.literal held)) => .ok (.context (.value (InventorySpec.property held name)))
          | _ => .error (.problem "a property of a value decided while the job runs")
    | .not operand =>
      match (look scope operand).bind (settle "this context") with
      | .error stop => .error stop
      | .ok operand => .ok (.context (.residual (notOf operand)))
    | .binary operator left right =>
      match (look scope left).bind (settle "this context") with
      | .error stop => .error stop
      | .ok left =>
        if operator = .and ∨ operator = .or then
          -- GitHub stops at the left value when it decides the result, so the right side is never read.
          match left with
          | .literal held =>
            if truthy held == decide (operator = .and) then
              (look scope right).bind (settle "this context") |>.map fun right => .context (.residual right)
            else .ok (.context (.residual (.literal held)))
          | left =>
            (look scope right).bind (settle "this context") |>.map fun right =>
              .context (.residual (.binary operator left right))
        else
          (look scope right).bind (settle "this context") |>.map fun right =>
            .context (.residual (compareOf operator left right))
    | .call name args =>
      if statusNames.contains name then
        if args.length ≠ 0 then .error (.problem (name ++ " was given " ++ toString args.length ++ " values"))
        else match scope.status with
          | none => .error (.problem (name ++ "() has no meaning here"))
          | some status => .ok (.context (.residual (.literal (.bool (status.get name)))))
      else if name = "hashfiles" then
        match scope.hashFiles with
        | none => .error (.problem "hashFiles has no meaning here")
        | some hashFiles =>
          match lookPatterns scope args with
          | .error stop => .error stop
          | .ok patterns =>
            let found := match hashFiles with
              | .echo => Context.value (.arr 0 (patterns.map .str))
              | .fixed context => context
            (settle "hashFiles" (.context found)).map fun residual => .context (.residual residual)
      else match arity? name with
        | none => .error (.problem (name ++ " is not a function an expression can call"))
        | some (least, most) =>
          if args.length < least ∨ most.any (args.length > ·) then
            .error (.problem (name ++ " was given " ++ toString args.length ++ " values"))
          else match lookArgs scope args with
            | .error stop => .error stop
            | .ok walked =>
              match literals? walked with
              | some values => (apply name values).map fun held => .context (.residual (.literal held))
              | none => .ok (.context (.residual (.call name walked)))

  /-- The values of a call, evaluated in order. -/
  def lookArgs (scope : Scope) : List Node → Except Stop (List Residual)
    | [] => .ok []
    | arg :: rest =>
      match (look scope arg).bind (settle "this context") with
      | .error stop => .error stop
      | .ok walked => (lookArgs scope rest).map (walked :: ·)

  /-- The patterns of `hashFiles`, each of which must be known before the next is read. -/
  def lookPatterns (scope : Scope) : List Node → Except Stop (List String)
    | [] => .ok []
    | arg :: rest =>
      match (look scope arg).bind (settle "this context") |>.bind (known "a hashFiles pattern") with
      | .error stop => .error stop
      | .ok held => (lookPatterns scope rest).map (toText held :: ·)
end

/-- Evaluates a tree as far as the scope allows. -/
def walk (scope : Scope) (node : Node) : Except Stop Residual :=
  (look scope node).bind (settle "this context")

/-- The result of evaluating: the expression as far as it goes, why it cannot be evaluated, or the secret it reads. -/
inductive Evaluated where
  | ok (residual : Residual)
  | problem (why : String)
  | secret (name : String)

/-- Evaluates one expression, written without `${{ }}`. -/
def evaluate (text : String) (scope : Scope) : Evaluated :=
  match parse text with
  | .error why => .problem why
  | .ok node =>
    match walk scope node with
    | .ok residual => .ok residual
    | .error (.problem why) => .problem why
    | .error (.secret name) => .secret name

mutual
  /-- The variables an expression still to finish reads, once for each place it reads one. -/
  def variablesOf : Residual → List Variable
    | .literal _ => []
    | .var read => [read]
    | .not operand => variablesOf operand
    | .binary _ left right => variablesOf left ++ variablesOf right
    | .call _ args => variablesOfAll args

  /-- The variables of each of a call's values. -/
  def variablesOfAll : List Residual → List Variable
    | [] => []
    | arg :: rest => variablesOf arg ++ variablesOfAll rest
end

mutual
  /-- The value of an expression once every variable is known. -/
  def valueOf (knownVariable : Variable → Value) : Residual → Except Stop Value
    | .literal held => .ok held
    | .var read => .ok (knownVariable read)
    | .not operand => (valueOf knownVariable operand).map fun held => .bool (!truthy held)
    | .call name args => (valuesOf knownVariable args).bind (apply name)
    | .binary operator left right =>
      match valueOf knownVariable left with
      | .error stop => .error stop
      | .ok left =>
        if operator = .and ∨ operator = .or then
          if truthy left == decide (operator = .and) then valueOf knownVariable right else .ok left
        else (valueOf knownVariable right).map fun right => .bool (compare operator left right)

  /-- The values of a call's arguments, in order. -/
  def valuesOf (knownVariable : Variable → Value) : List Residual → Except Stop (List Value)
    | [] => .ok []
    | arg :: rest =>
      match valueOf knownVariable arg with
      | .error stop => .error stop
      | .ok held => (valuesOf knownVariable rest).map (held :: ·)
end

/-- What `finish` gives: the value, or why there is none. -/
inductive Finished where
  | ok (value : Value)
  | problem (why : String)

/-- Finishes an expression once `knownVariable` gives every variable it reads, by the same rules as `evaluate`. -/
def finish (node : Residual) (knownVariable : Variable → Value) : Finished :=
  match valueOf knownVariable node with
  | .ok held => .ok held
  | .error (.problem why) => .problem why
  -- A value is all the functions read, so what stops them is always a problem.
  | .error (.secret name) => .problem name

/-- Whether the generated runner should execute a step for these concrete variable values. -/
def runnerCondition (knownVariable : Variable → Value) (node : Residual) : Except Stop Bool :=
  (valueOf knownVariable node).map truthy

/-! ## Text with expressions in it -/

/-- Where an expression ends: the text before the first `}}` outside a string, and the text after it. -/
def closing : Bool → List Char → List Char → Option (List Char × List Char)
  | _, [], _ => none
  | quoted, '\'' :: rest, inner => closing (!quoted) rest ('\'' :: inner)
  | false, '}' :: '}' :: rest, inner => some (inner.reverse, rest)
  | quoted, c :: rest, inner => closing quoted rest (c :: inner)

/-- One expression in a text: the text before it, the expression, and the `${{ }}` as written. -/
structure SplitPiece where
  before : String
  expression : String
  written : String

/-- The expressions in a text from one place on, and the text after the last. -/
def splitFrom : Nat → List Char → List Char → List SplitPiece → List SplitPiece × String
  | _, [], before, pieces => (pieces.reverse, String.ofList before.reverse)
  | 0, text, before, pieces => (pieces.reverse, String.ofList (before.reverse ++ text))
  | fuel + 1, c :: rest, before, pieces =>
    match c, rest with
    | '$', '{' :: '{' :: after =>
      match closing false after [] with
      | some (inner, rest') =>
        splitFrom fuel rest' [] ({
          before := String.ofList before.reverse
          expression := String.ofList (trim inner)
          written := String.ofList ('$' :: '{' :: '{' :: inner ++ ['}', '}']) } :: pieces)
      -- No expression closes from here on, so none starts further on either.
      | none => (pieces.reverse, String.ofList (before.reverse ++ c :: rest))
    | _, _ => splitFrom fuel rest (c :: before) pieces

/-- The expressions in a text, each with the text before it, and the text after the last. -/
def split (text : String) : List SplitPiece × String := splitFrom text.length text.toList [] []

/-- One piece of a filled text: text, or an expression still to finish with the `${{ }}` the workflow wrote for it. -/
inductive Part where
  | text (text : String)
  | residual (residual : Residual) (written : String)

/-- The result of filling a text: its pieces, why one expression cannot be evaluated, or the secret one reads. -/
inductive Filled where
  | ok (parts : List Part)
  | problem (why : String)
  | secret (name : String)

/-- Adds a piece to pieces held last first: text joins text, and empty text adds nothing. -/
def addPart (parts : List Part) (part : Part) : List Part :=
  match part, parts with
  | .text more, .text last :: earlier => .text (last ++ more) :: earlier
  | .text "", _ => parts
  | _, _ => part :: parts

/-- Fills every `${{ }}` in a text. Text and known values are joined; the rest stays as its own piece. -/
def fill (text : String) (scope : Scope) : Filled :=
  let (pieces, rest) := split text
  let rec go (parts : List Part) : List SplitPiece → Filled
    | [] => .ok (addPart parts (.text rest)).reverse
    | piece :: more =>
      match evaluate piece.expression scope with
      | .problem why => .problem (piece.expression ++ ": " ++ why)
      | .secret name => .secret name
      | .ok residual =>
        let parts := addPart parts (.text piece.before)
        go (addPart parts (match residual with
          | .literal held => .text (toText held)
          | residual => .residual residual piece.written)) more
  go [] pieces

/--
The expression a whole text is, or `none` when it is text with expressions in it. `if:` may be written without
`${{ }}`, so with `bare` a text holding none is an expression too.
-/
def whole (text : String) (bare : Bool) : Option String :=
  match split text with
  | ([], rest) => if bare then some rest else none
  | ([piece], rest) => if piece.before.isEmpty && rest.isEmpty then some piece.expression else none
  | _ => none

/-! ## The runner's verdict on a condition -/

/-- What a value can be when the job runs: text, empty text, `null`, `true`, `false`, or something a shell cannot tell. -/
inductive ValueKind where
  | text | empty | null | true | false | other
  deriving DecidableEq

/-- The kinds that count as true. -/
def truthyKinds : List ValueKind := [.text, .true, .other]

/-- The kinds that count as false. -/
def falsyKinds : List ValueKind := [.empty, .null, .false, .other]

/-- Every kind of value a residual can give. `a && b` gives `a` when it is false and `b` otherwise. -/
def kindsOf : Residual → List ValueKind
  | .literal (.str s) => [if s.isEmpty then .empty else .text]
  | .literal .null => [.null]
  | .literal (.arr _ _) => [.other]
  | .literal (.obj _ _) => [.other]
  | .literal held => [if truthy held then .true else .false]
  | .var read =>
    if read.typed then [.other] else if read.nullable then [.text, .empty, .null] else [.text, .empty]
  | .not _ => [.true, .false]
  | .call name _ => if name = "format" then [.text, .empty] else [.true, .false]
  | .binary operator left right =>
    if operator = .and then ((kindsOf left).filter (falsyKinds.contains ·) ++ kindsOf right).eraseDups
    else if operator = .or then ((kindsOf left).filter (truthyKinds.contains ·) ++ kindsOf right).eraseDups
    else [.true, .false]

/--
Whether an expression still to finish is true whatever its variables hold: `x && false` is never true and
`x || 'fallback'` always is. `none` when its variables decide.
-/
def settled (node : Residual) : Option Bool :=
  let kinds := kindsOf node
  if kinds.all (fun kind => kind ≠ .other && falsyKinds.contains kind) then some false
  else if kinds.all (fun kind => kind ≠ .other && truthyKinds.contains kind) then some true
  else none

end InventorySpec

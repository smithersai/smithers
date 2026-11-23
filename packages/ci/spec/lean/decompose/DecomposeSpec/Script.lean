/-
Reference specification of `packages/ci/src/decompose/Script.vibe`: what a step that runs one `package.json`
script becomes — nothing, the step whole with the reason, or one step per command of the script.

A `package.json` comes here already parsed (`Manifest`): parsing JSON is not specified.
-/
import DecomposeSpec.Workspace

namespace DecomposeSpec
namespace Script

open Text
open Workspace (unseenCount unseenCount_lt)

/-- A package manager whose script runs are read. -/
inductive Manager where
  | npm | pnpm | yarn | bun
  deriving DecidableEq, Repr

def Manager.name : Manager → Str
  | .npm => "npm".toList
  | .pnpm => "pnpm".toList
  | .yarn => "yarn".toList
  | .bun => "bun".toList

def managerOf (word : Str) : Option Manager :=
  [Manager.npm, .pnpm, .yarn, .bun].find? (·.name = word)

/-- One run of a package script: `npm run build`. `rest` holds the words after the script's name. -/
structure Run where
  manager : Manager
  script : Str
  rest : List Str
  deriving DecidableEq, Repr

def wordsOf (text : String) : List Str := (splitOn ' ' text.toList).filter (· ≠ [])

/-- The words after `pnpm` that are its own commands (`Runners.pnpmCommands`). -/
def pnpmCommands : List Str :=
  wordsOf ("add audit bin cache ci config create dedupe deploy dlx doctor env exec fetch import init install i " ++
    "install-test it licenses link ln list ls la ll outdated pack patch patch-commit patch-remove prune publish " ++
    "rebuild rb recursive multi m remove rm uninstall un root server setup store unlink dislink update up upgrade " ++
    "why self-update approve-builds completion help start stop restart")

/-- The words after `yarn` that are its own commands (`Runners.yarnCommands`). -/
def yarnCommands : List Str :=
  wordsOf ("add audit autoclean bin cache check config constraints create dedupe dlx exec explain " ++
    "generate-lock-entry global help import info init install licenses link list login logout node npm outdated " ++
    "owner pack patch patch-commit plugin policies publish rebuild remove search self-update set stage tag team " ++
    "unlink unplug up upgrade upgrade-interactive version versions why workspaces")

/-- More words after `pnpm` that are its own commands. -/
def pnpmOwnCommands : List Str :=
  wordsOf ("access adduser bin bugs cat-file cat-index deprecate dist-tag docs edit explore find-hash get " ++
    "help-search hook ignored-builds info issues login logout org owner ping pkg prefix profile repo sbom search " ++
    "set show star stars t team token tst unpublish unstar version view whoami xmas")

/-- More words after `yarn` that are its own commands. -/
def yarnOwnCommands : List Str := wordsOf "generateLockEntry lockfile prune run upgradeInteractive workspace"

/-- The words that run a script by name, per package manager. -/
def runWords : Manager → List Str
  | .npm | .pnpm => ["run", "run-script"].map String.toList
  | .yarn | .bun => ["run"].map String.toList

def startsWithDash (word : Str) : Bool := word.head? = some '-'

/-- Reads a command's words as one run of a package script, or `none` when they are anything else. The forms are
`npm run <name>`, `npm run-script <name>`, `npm test`, `pnpm run <name>`, `pnpm <name>`, `yarn run <name>`,
`yarn <name>` and `bun run <name>`. -/
def runOf (words : List Str) : Option Run :=
  match words with
  | first :: second :: after =>
    match managerOf first with
    | none => none
    | some manager =>
      if (runWords manager).contains second then
        match after with
        | script :: rest => if startsWithDash script then none else some { manager, script, rest }
        | [] => none
      else if startsWithDash second || manager = .bun then none
      else if manager = .npm then
        if second = "test".toList then some { manager, script := second, rest := after } else none
      else
        let own := if manager = .pnpm then pnpmCommands ++ pnpmOwnCommands else yarnCommands ++ yarnOwnCommands
        if own.contains second then none else some { manager, script := second, rest := after }
  | _ => none

/-! ## The text of a script -/

/-- A script's text with every `&&` taken out: `text.replaceAll("&&", " ")`. -/
def withoutAnds : Str → Str
  | '&' :: '&' :: rest => ' ' :: withoutAnds rest
  | c :: rest => c :: withoutAnds rest
  | [] => []

/-- `text.split("&&")`. -/
def splitAnds : Str → List Str
  | '&' :: '&' :: rest => [] :: splitAnds rest
  | c :: rest =>
    match splitAnds rest with
    | [] => [[c]]
    | head :: tail => (c :: head) :: tail
  | [] => [[]]

/-- A character a plain word of a script is written with, a space or a tab. Any other blank, such as a no-break
space, is a character the shell reads in its own way. -/
def isPlain (c : Char) : Bool :=
  isNameChar c || c = '@' || c = '%' || c = '+' || c = ':' || c = ',' || c = '.' || c = '/' || c = '=' ||
    c = ' ' || c = '\t' || c = '-'

/-- What a script holds beside plain words and `&&`, in the order a reader names them. -/
def syntaxOf (text : Str) : Option String :=
  let rest := withoutAnds text
  if contains ['|', '|'] rest then some "joins commands with `||`"
  else if rest.any (fun c => c = ';' || c = '\n' || c = '\r') then some "joins commands with `;` or a line break"
  else if rest.contains '|' then some "pipes one command into another"
  else if rest.contains '&' then some "runs a command in the background"
  else if rest.any (fun c => c = '<' || c = '>') then some "redirects input or output"
  else if rest.any (fun c => c = '(' || c = ')') then some "runs commands in a subshell"
  else if rest.any (fun c => c = '$' || c = '`') then some "reads a variable or the output of a command"
  else if rest.any (fun c => c = '"' || c = '\'' || c = '\\') then some "quotes a word"
  else if rest.any (!isPlain ·) then some "has a character the shell reads in its own way"
  else none

/-- The words of one link: `link.split(/[ \t]+/)` without its empty parts. -/
def linkWords (link : Str) : List Str :=
  ((splitOn ' ' (link.map fun c => if c = '\t' then ' ' else c))).filter (· ≠ [])

/-- The links of a script that is nothing but plain words joined by `&&`, or what else the script holds. -/
def linksOf (text : Str) : Except String (List (List Str)) :=
  match syntaxOf text with
  | some found => .error found
  | none =>
    let links := (splitAnds text).map linkWords
    if links.any (·.isEmpty) then .error "has `&&` with no command beside it" else .ok links

/-- The scripts of a manifest: its own entries whose value is text, by name. -/
abbrev Scripts := List (Str × Str)

def Scripts.has (scripts : Scripts) (name : Str) : Bool := (scripts.lookup name).isSome

/-- The script a link runs: a script of the same manifest, run by the same package manager with no option. -/
def linkScript (words : List Str) (manager : Manager) (scripts : Scripts) : Option Str :=
  match runOf words with
  | some run => if run.manager = manager && run.rest.isEmpty && scripts.has run.script then some run.script else none
  | none => none

/-- The `pre` or `post` script a package manager runs around a script, when the manifest has one. -/
def hooked (scripts : Scripts) (name : Str) : Option Str :=
  ["pre".toList ++ name, "post".toList ++ name].find? scripts.has

/-- One command of a split script: the script it runs, and the link as its script writes it. -/
structure Leaf where
  script : Str
  words : List Str
  deriving DecidableEq, Repr

/-- The links a script may be split into: those of a script with no hook whose text is a chain of runs of scripts
of the same manifest, each with the script it runs. `none` for a script that is run as it is. -/
def innerLinks (manager : Manager) (scripts : Scripts) (script : Str) : Option (List (Str × List Str)) :=
  if (hooked scripts script).isSome then none
  else
    match linksOf ((scripts.lookup script).getD []) with
    | .error _ => none
    | .ok links => links.mapM fun link => (linkScript link manager scripts).map (·, link)

/-- The commands a link runs, to any depth, or the name of a script that reaches itself, which never ends
(`Except.error`). `running` holds the scripts being run around this one. A script that cannot be split is run by
its link as it is, hooks and all.

Every script gone into is one of the manifest's and is not running already, so fewer are left each time: the walk
ends because a script that reaches itself is refused. -/
def leavesOf (manager : Manager) (scripts : Scripts) (running : List Str) (script : Str) (words : List Str) :
    Except Str (List Leaf) :=
  if _ : script ∈ running then .error script
  else if _ : script ∈ scripts.map (·.1) then
    match innerLinks manager scripts script with
    | none => .ok [{ script, words }]
    | some links =>
      (links.mapM fun (inner, link) => leavesOf manager scripts (script :: running) inner link).map List.flatten
  else .ok [{ script, words }]
termination_by unseenCount (scripts.map (·.1)) running
decreasing_by exact unseenCount_lt _ running script (by assumption) (by assumption)

/-! ## The step and its files -/

/-- A `package.json`, parsed: its scripts and its `packageManager` field, when that is text. -/
abbrev Manifest := Scripts × Option Str

/-- A file the decision reads. -/
inductive File where
  /-- The repository has it and it cannot be read. -/
  | unreadable
  /-- Its text, and what it holds when it is a JSON object. -/
  | readable (text : Str) (manifest : Option Manifest)

/-- The files of a repository the decision may ask for, by path from the root. -/
abbrev Files := List (Str × File)

/-- A file's text, when the repository has the file and it can be read. -/
def Files.text (files : Files) (path : Str) : Option Str :=
  match files.lookup path with
  | some (.readable text _) => some text
  | _ => none

def Files.manifest (files : Files) (path : Str) : Option Manifest :=
  match files.lookup path with
  | some (.readable _ manifest) => manifest
  | _ => none

def Files.unreadable (files : Files) (path : Str) : Bool :=
  match files.lookup path with
  | some .unreadable => true
  | _ => false

/-- What of a step the decision reads. -/
structure Step where
  command : Str
  cwd : Str
  /-- The names of the step's variables. -/
  env : List Str
  runner : Option Str
  /-- True for the first step of a job that has more steps. -/
  leads : Bool

/-- The step's one command as a script run, the directory it runs in, and the command's words. -/
structure Read where
  run : Run
  directory : Str
  words : List Str

/-- Reads a step whose command is one script run and nothing else: no assignment, no pipe, no variable, no
redirection and no comment beside it. -/
def stepRun (command cwd : Str) : Option Read :=
  if cwd.head? = some '/' || contains "${{".toList cwd then none
  else
    match Workspace.join [] cwd, Shell.commands command with
    | some directory, some [only] =>
      if !only.assignments.isEmpty || only.piped || only.background then none
      else if only.words.any (!·.literal) then none
      else
        match only.start, only.stop with
        | some start, some stop =>
          if trim (command.take start ++ command.drop stop) ≠ [] then none
          else
            let words := only.words.map (·.text)
            (runOf words).map fun run => { run, directory, words }
        | _, _ => none
    | _, _ => none

/-- A path from the repository root for a file in a directory. -/
def inDirectory (directory file : Str) : Str := if directory = [] then file else directory ++ '/' :: file

/-- The files of one directory that say how a package manager runs a script there. -/
def settingFiles : List Str :=
  [".npmrc", ".yarnrc", ".yarnrc.yml", "bunfig.toml", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml",
    "pnpm-workspace.yaml", "yarn.lock"].map String.toList

/-- The step's directory and the root. -/
def directoriesOf (directory : Str) : List Str := distinct [directory, []]

/-- The files `decide` reads for a step, from the repository root: none when the step's command is not one script
run. -/
def filesOf (command cwd : Str) : List Str :=
  match stepRun command cwd with
  | none => []
  | some read =>
    (directoriesOf read.directory).flatMap fun directory =>
      ("package.json".toList :: settingFiles).map (inDirectory directory)

/-! ## Settings -/

def lowerAscii (c : Char) : Char := if isUpper c then Char.ofNat (c.toNat + 32) else c

/-- A variable of a step that a package manager reads as a setting: `/^(?:npm_config_|pnpm_config_|yarn_|bun_config_)/i`. -/
def isSettingVariable (name : Str) : Bool :=
  ["npm_config_", "pnpm_config_", "yarn_", "bun_config_"].any fun pre =>
    pre.toList.isPrefixOf (name.map lowerAscii)

/-- True when the runner's text sets a time limit: `/^__limit=/m`. -/
def hasLimit (runner : Str) : Bool := (lineStarts runner).any ("__limit=".toList.isPrefixOf ·)

/-- A setting at the start of a line: blanks, one of `keys`, blanks, then `mark`. -/
def assignedAt (keys : List String) (mark : Char) (line : Str) : Option Str :=
  let text := line.dropWhile isSpace
  keys.findSome? fun key =>
    match dropPrefix key.toList text with
    | some after => if (after.dropWhile isSpace).head? = some mark then some key.toList else none
    | none => none

/-- `.yarnrc`'s setting at the start of a line: blanks, `script-shell` with or without quotes, then a blank. -/
def yarnrcAt (line : Str) : Option Str :=
  let text := line.dropWhile isSpace
  let text := match text with
    | '"' :: rest => rest
    | _ => text
  match dropPrefix "script-shell".toList text with
  | some after =>
    let after := match after with
      | '"' :: rest => rest
      | _ => after
    if (after.head?.map isSpace).getD false then some "script-shell".toList else none
  | none => none

/-- The settings that change the shell a script's text is read by: the file, the package managers that read it,
and how a line of it names the setting. -/
def shellSettings : List (String × List Manager × (Str → Option Str)) := [
  (".npmrc", [.npm, .pnpm, .yarn], assignedAt ["script-shell", "shell-emulator"] '='),
  (".yarnrc", [.yarn], yarnrcAt),
  ("pnpm-workspace.yaml", [.pnpm], assignedAt ["scriptShell", "shellEmulator"] ':'),
  ("bunfig.toml", [.bun], assignedAt ["shell"] '=')
]

/-- The first such setting the files hold for a package manager, with the file it is in. -/
def shellSetting (manager : Manager) (directories : List Str) (files : Files) : Option (Str × Str) :=
  shellSettings.findSome? fun (file, users, find) =>
    (if users.contains manager then directories else []).findSome? fun directory =>
      let path := inDirectory directory file.toList
      ((lineStarts ((files.text path).getD [])).findSome? find).map (·, path)

/-- The release a `packageManager` field names for a package manager: `^<manager>@(\d+)`. -/
def namedRelease (manager : Manager) (field : Str) : Option Nat :=
  (dropPrefix (manager.name ++ ['@']) field).bind fun rest => (leadingNumber rest).map (·.1)

/-- The first 2000 UTF-16 code units of a text: `text.slice(0, 2000)`. -/
def lockHead (text : Str) : Str := go text 2000
where
  go : Str → Nat → Str
    | [], _ => []
    | c :: rest, room =>
      let size := (utf16Units c).length
      if size ≤ room then c :: go rest (room - size) else []

/-- The version a `package-lock.json` gives: the first `"lockfileVersion":`, blanks, then digits. -/
def jsonLockVersion : Str → Option Nat
  | [] => none
  | c :: rest =>
    let here := (dropPrefix "\"lockfileVersion\":".toList (c :: rest)).bind fun after =>
      (leadingNumber (after.dropWhile isSpace)).map (·.1)
    here.orElse fun _ => jsonLockVersion rest

/-- The version a `pnpm-lock.yaml` gives: a line that starts `lockfileVersion:`, blanks, a quote or none, digits. -/
def yamlLockVersion (text : Str) : Option Nat :=
  (lineStarts text).findSome? fun line =>
    (dropPrefix "lockfileVersion:".toList line).bind fun after =>
      let after := after.dropWhile isSpace
      let after := match after with
        | '\'' :: rest => rest
        | _ => after
      (leadingNumber after).map (·.1)

/-- The release of a package manager a script inside a script was not checked under, when the files name one. -/
def uncheckedRelease (manager : Manager) (directories : List Str) (files : Files) : Option String :=
  let each := fun (file : String) => directories.filterMap fun directory =>
    files.text (inDirectory directory file.toList)
  let fields := directories.filterMap fun directory =>
    (files.manifest (inDirectory directory "package.json".toList)).bind (·.2)
  -- The nearest `packageManager` names the release, when it names this package manager.
  let named := fields.head?.bind (namedRelease manager)
  match manager with
  | .yarn =>
    if named.getD 1 ≥ 2 || !(each ".yarnrc.yml").isEmpty ||
        (each "yarn.lock").any (contains "__metadata:".toList) then some "Yarn 2 or later"
    else none
  | .npm =>
    -- npm 7 writes a lockfile of version 2 or 3.
    if named.getD 7 < 7 || (each "package-lock.json" ++ each "npm-shrinkwrap.json").any
        (fun lock => (jsonLockVersion (lockHead lock)).getD 1 < 2) then some "npm 6 or earlier"
    else none
  | .pnpm =>
    -- pnpm 8 writes a lockfile of version 6.
    if named.getD 8 < 8 || (each "pnpm-lock.yaml").any
        (fun lock => (yamlLockVersion (lockHead lock)).getD 5 < 6) then some "pnpm 7 or earlier"
    else none
  | .bun => none

/-! ## The links' commands -/

/-- The directories whose `node_modules/.bin` a script's shell finds programs in before anything else, as shell
text from the step's directory. Yarn 1 puts itself first on the path and needs none. -/
def binDirectories (manager : Manager) (directory : Str) (workspace : Bool) : List Str :=
  let depth := if directory = [] then 0 else (splitOn '/' directory).length
  let at_ := fun (up : Nat) =>
    "$PWD/".toList ++ (List.replicate up "../".toList).flatten ++ "node_modules/.bin".toList
  match manager with
  | .yarn => []
  | .pnpm => if depth > 0 && workspace then [at_ 0, at_ depth] else [at_ 0]
  | _ => (List.range (depth + 1)).map at_

def hexDigit (n : Nat) : Char := if n < 10 then Char.ofNat (48 + n) else Char.ofNat (87 + n)

/-- `JSON.stringify` of one text. -/
def jsonText (text : Str) : Str :=
  '"' :: text.flatMap (fun c =>
    if c = '"' then ['\\', '"']
    else if c = '\\' then ['\\', '\\']
    else if c = '\n' then ['\\', 'n']
    else if c = '\r' then ['\\', 'r']
    else if c = '\t' then ['\\', 't']
    else if c.toNat = 8 then ['\\', 'b']
    else if c.toNat = 12 then ['\\', 'f']
    else if c.toNat < 32 then ['\\', 'u', '0', '0', hexDigit (c.toNat / 16), hexDigit (c.toNat % 16)]
    else [c]) ++ ['"']

def jsonList (items : List Str) : Str := '[' :: joinWith [','] (items.map jsonText) ++ [']']

/-- What the outer package manager left set for the links it started. Yarn 1 keeps the first `npm_config_argv` it
is given, and prints no banner inside a script. -/
def carried (run : Run) (stepWords : List Str) : Str :=
  if run.manager ≠ .yarn then []
  else
    let argv := "{\"remain\":[],\"cooked\":".toList ++ jsonList ["run".toList, run.script] ++
      ",\"original\":".toList ++ jsonList (stepWords.drop 1) ++ ['}']
    "YARN_WRAP_OUTPUT=false npm_config_argv=".toList ++ Shell.quote argv ++ [' ']

/-- A link's command: the words its script wrote, which are plain, after what the outer package manager set. -/
def commandOf (leaf : Leaf) (run : Run) (stepWords : List Str) (bins : List Str) : Str :=
  let path := if bins.isEmpty then [] else "PATH=\"".toList ++ joinWith [':'] bins ++ ":$PATH\" ".toList
  path ++ carried run stepWords ++ joinWith [' '] leaf.words

def decimal (n : Nat) : Str := (toString n).toList

/-- A name for each link: the script it runs, numbered from its second appearance. -/
def namesOf (leaves : List Leaf) : List Str :=
  (List.range leaves.length).filterMap fun index =>
    leaves[index]?.map fun leaf =>
      let seen := ((leaves.take (index + 1)).filter (·.script = leaf.script)).length
      if seen = 1 then leaf.script else leaf.script ++ '#' :: decimal seen

/-! ## The decision -/

/-- What a step becomes: nothing is said (`none`), the step stays whole for a reason, or one step per link. -/
inductive Decision where
  | none
  | whole (feature : String) (detail : Str)
  | links (links : List (Str × Str))
  deriving DecidableEq, Repr

/-- What is left to decide once the script is known to be a chain of at least two commands with no hook and no
argument: whether anything about the step or the repository's settings is meant for the script as a whole. -/
def decideSettings (step : Step) (read : Read) (files : Files) (leaves : List Leaf) : Decision :=
  let directories := directoriesOf read.directory
  -- The runner stops a step at its limit, and the limit is for the whole script.
  if (step.runner.map hasLimit).getD false then .whole "script-limit" []
  else if step.runner.isSome && step.leads then .whole "script-first" []
  else
    match step.env.find? isSettingVariable with
    | some found => .whole "script-setting" ("the step's variable `".toList ++ found ++ ['`'])
    | none =>
      match (filesOf step.command step.cwd).find? files.unreadable with
      | some unread =>
        .whole "script-setting" ("what `".toList ++ unread ++ "` sets, which cannot be read,".toList)
      | none =>
        match shellSetting read.run.manager directories files with
        | some (setting, path) => .whole "script-setting" ('`' :: setting ++ "` in `".toList ++ path ++ ['`'])
        | none =>
          match uncheckedRelease read.run.manager directories files with
          | some release => .whole "script-release" release.toList
          | none =>
            if leaves.length > 4096 then .none else
            let workspace := (files.lookup "pnpm-workspace.yaml".toList).isSome
            let bins := binDirectories read.run.manager read.directory workspace
            .links ((namesOf leaves).zip (leaves.map (commandOf · read.run read.words bins)))

/-- True when a script's text holds an operator: `/&&|\|\||[;|&\n\r]/`. -/
def hasOperator (body : Str) : Bool := body.any fun c => c = ';' || c = '|' || c = '&' || c = '\n' || c = '\r'

/-- Every command the links of the step's script run, in order, or the name of a script that reaches itself. -/
def expand (manager : Manager) (scripts : Scripts) (script : Str) (links : List (Str × List Str)) :
    Except Str (List Leaf) :=
  (links.mapM fun (inner, link) => leavesOf manager scripts [script] inner link).map List.flatten

/-- Decides what a step that runs the script `read.run.script` of `scripts` becomes. -/
def decideRun (step : Step) (read : Read) (scripts : Scripts) (files : Files) : Decision :=
  let run := read.run
  match scripts.lookup run.script with
  | none => .none
  | some body =>
    match linksOf body with
    -- One command with shell syntax of its own, such as a quoted word, is still one command.
    | .error found => if hasOperator body then .whole "script-syntax" found.toList else .none
    | .ok links =>
      match links.find? fun link => (linkScript link run.manager scripts).isNone with
      | some stray => if links.length > 1 then .whole "script-command" (joinWith [' '] stray) else .none
      | none =>
        let inner := links.filterMap fun link => (linkScript link run.manager scripts).map (·, link)
        match expand run.manager scripts run.script inner with
        | .error cycle => .whole "script-cycle" cycle
        | .ok leaves =>
          -- A script that only names another, down to one command, is that command.
          if leaves.length < 2 then .none
          else
            match hooked scripts run.script with
            | some hook => .whole "script-hook" hook
            | none =>
              if !run.rest.isEmpty then .whole "script-arguments" (joinWith [' '] run.rest)
              else decideSettings step read files leaves

/-- Decides what a step that runs a package script becomes. -/
def decide (step : Step) (files : Files) : Decision :=
  match stepRun step.command step.cwd with
  | none => .none
  | some read =>
    let scripts := ((files.manifest (inDirectory read.directory "package.json".toList)).map (·.1)).getD []
    decideRun step read scripts files

end Script
end DecomposeSpec

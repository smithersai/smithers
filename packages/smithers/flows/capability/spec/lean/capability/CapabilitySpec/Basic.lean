/-!
# Texts and actions

A text is a list of UTF-16 code units, because the implementation matches, splits and orders resources by code unit
and never decodes them. An action is one of nineteen host operations in seven namespaces; a pattern's action selector
is an exact action, a whole space, or every action.
-/

namespace CapabilitySpec

/-- A text: its UTF-16 code units. -/
abbrev Text := List Nat

/-- The code units of a string whose characters are all in the Basic Multilingual Plane. -/
def units (text : String) : Text := text.toList.map Char.toNat

/-- The longest resource an exact capability or a pattern may carry. -/
def maxResourceLength : Nat := 4096

/-- The most pattern-length times resource-length work one match may spend. -/
def maxMatchWork : Nat := maxResourceLength * maxResourceLength

inductive Namespace where
  | fs | net | model | memory | proc | jj | remote
  deriving DecidableEq, Repr

inductive Action where
  | fsRead | fsWrite | netGet | netPost | netPrivate | modelCall | memoryRead | memoryWrite | procSpawn
  | jjStatus | jjDiff | jjSnapshot | jjRestore | jjWorkspaceAdd | jjWorkspaceForget | jjRoot | jjRevert
  | jjOpRestore | remoteAcquire
  deriving DecidableEq, Repr

def Namespace.all : List Namespace := [.fs, .net, .model, .memory, .proc, .jj, .remote]

def Action.all : List Action :=
  [.fsRead, .fsWrite, .netGet, .netPost, .netPrivate, .modelCall, .memoryRead, .memoryWrite, .procSpawn,
    .jjStatus, .jjDiff, .jjSnapshot, .jjRestore, .jjWorkspaceAdd, .jjWorkspaceForget, .jjRoot, .jjRevert,
    .jjOpRestore, .remoteAcquire]

def Namespace.name : Namespace → String
  | .fs => "fs" | .net => "net" | .model => "model" | .memory => "memory" | .proc => "proc" | .jj => "jj"
  | .remote => "remote"

def Action.namespace : Action → Namespace
  | .fsRead | .fsWrite => .fs
  | .netGet | .netPost | .netPrivate => .net
  | .modelCall => .model
  | .memoryRead | .memoryWrite => .memory
  | .procSpawn => .proc
  | .jjStatus | .jjDiff | .jjSnapshot | .jjRestore | .jjWorkspaceAdd | .jjWorkspaceForget | .jjRoot | .jjRevert
  | .jjOpRestore => .jj
  | .remoteAcquire => .remote

/-- The operation: the text after the namespace and its colon. -/
def Action.operation : Action → String
  | .fsRead => "read" | .fsWrite => "write" | .netGet => "get" | .netPost => "post" | .netPrivate => "private"
  | .modelCall => "call" | .memoryRead => "read" | .memoryWrite => "write" | .procSpawn => "spawn"
  | .jjStatus => "status" | .jjDiff => "diff" | .jjSnapshot => "snapshot" | .jjRestore => "restore"
  | .jjWorkspaceAdd => "workspace-add" | .jjWorkspaceForget => "workspace-forget" | .jjRoot => "root"
  | .jjRevert => "revert" | .jjOpRestore => "op-restore" | .remoteAcquire => "acquire"

def Action.name (action : Action) : String := action.namespace.name ++ ":" ++ action.operation

/-- The action selector of a pattern. -/
inductive Selector where
  /-- `*`: every action. -/
  | any
  /-- `fs:*`: every action of one namespace. -/
  | within (space : Namespace)
  /-- `fs:read`: one action. -/
  | exact (action : Action)
  deriving DecidableEq, Repr

def Selector.name : Selector → String
  | .any => "*"
  | .within space => space.name ++ ":*"
  | .exact action => action.name

def Selector.all : List Selector :=
  Action.all.map .exact ++ Namespace.all.map .within ++ [.any]

def Action.named (name : String) : Option Action := Action.all.find? (·.name == name)

def Selector.named (name : String) : Option Selector := Selector.all.find? (·.name == name)

/-- A selector selects an action: `matchesAction`. -/
def Selector.selects : Selector → Action → Bool
  | .any, _ => true
  | .within space, action => action.namespace == space
  | .exact wanted, action => wanted == action

/-- Every action `right` selects, `left` selects: `actionSubsumes`. -/
def Selector.covers : Selector → Selector → Bool
  | .any, _ => true
  | .within space, .within other => space == other
  | .within space, .exact action => action.namespace == space
  | .within _, .any => false
  | .exact wanted, right => right == .exact wanted

/-- A selector can name a filesystem action: `*`, `fs:*`, `fs:read` or `fs:write`. -/
def Selector.selectsFilesystem : Selector → Bool
  | .any => true
  | .within space => space == .fs
  | .exact action => action.namespace == .fs

/-- An exact capability: one action on one resource. -/
structure Capability where
  action : Action
  resource : Text
  deriving DecidableEq, Repr

/-- A pattern: a selector and a resource glob. -/
structure Pattern where
  action : Selector
  resource : Text
  deriving DecidableEq, Repr

end CapabilitySpec

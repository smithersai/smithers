import McpAndStackSpec.Roles
import McpAndStackSpec.BlockedActs

/-!
# The MCP tool catalog, its gate, and the bearer token's format

What a call of a BYOA tool answers before any argument is read (`worker/mcp/Tools.ts` over `worker/mcp/Auth.ts`):
a person-only act is refused by name, an unknown name is not found, a read needs a role on a private repository and
the tool's least role, and a write needs a token, the agent's own act, the `mcp:write` scope, the token's
repository and the tool's least role. The token's format is `sma_` and 64 lowercase hex digits.
-/

namespace McpAndStackSpec

inductive Access where
  | read
  | write
  deriving DecidableEq, Repr

/-- A tool of the catalog: its name, whether it writes, and the least role that may call it. -/
structure ToolSpec where
  name : Text
  access : Access
  minimum : Option Role
  deriving DecidableEq, Repr

/-- The 17 tools (`TOOL_SPECS`), in the catalog's order. -/
def catalog : List ToolSpec := [
  ⟨u16! "repo_tree", .read, none⟩,
  ⟨u16! "repo_read_file", .read, none⟩,
  ⟨u16! "repo_refs", .read, none⟩,
  ⟨u16! "docs_list", .read, none⟩,
  ⟨u16! "docs_read", .read, none⟩,
  ⟨u16! "flows_list", .read, none⟩,
  ⟨u16! "flow_get", .read, none⟩,
  ⟨u16! "issues_list", .read, none⟩,
  ⟨u16! "issue_get", .read, none⟩,
  ⟨u16! "pulls_list", .read, none⟩,
  ⟨u16! "pull_get", .read, none⟩,
  ⟨u16! "pull_files", .read, none⟩,
  ⟨u16! "issue_create", .write, some .guest⟩,
  ⟨u16! "issue_comment", .write, some .guest⟩,
  ⟨u16! "todo_list", .read, some .member⟩,
  ⟨u16! "todo_draft", .write, some .member⟩,
  ⟨u16! "work_link_post", .write, some .maintainer⟩]

/-- The token a call came with: its scope, whether its actor is the token's own agent, and where it is pinned. -/
structure Principal where
  /-- It carries `mcp:write`. -/
  write : Bool
  /-- Its actor's `act` is `{ kind: "agent", id: "mcp:<tokenId>" }`. -/
  actOk : Bool
  /-- Its `repoScope` names another repository than the call's. -/
  pinnedElsewhere : Bool
  deriving DecidableEq, Repr

/-- How a call ends: `ok`, or the tool error's code. -/
inductive Outcome where
  | ok
  | personOnly
  | notFound
  | authentication
  | forbidden
  deriving DecidableEq, Repr

/-- Whether `role` reaches `minimum`; no minimum admits everyone. -/
def meets (role minimum : Option Role) : Bool := decide (rankOf minimum ≤ rankOf role)

/-- `visible`: a write is listed for a token with `mcp:write`; every tool for its least role and above. -/
def visible (spec : ToolSpec) (role : Option Role) (principal : Option Principal) : Bool :=
  (match spec.access, principal with
    | .write, none => false
    | .write, some token => token.write
    | .read, _ => true) && meets role spec.minimum

/-- The catalog's tool of that name. -/
def toolOf (name : Text) : Option ToolSpec := catalog.find? fun spec => decide (spec.name = name)

/--
The role a listing reads: Admin when no repository is named or the token is pinned elsewhere (each call checks the
live role), else the live role, none for a visitor.
-/
def listingRole (principal : Option Principal) (inRepo : Bool) (role : Option Role) : Option Role :=
  if !inRepo then some .admin
  else match principal with
    | none => none
    | some token => if token.pinnedElsewhere then some .admin else role

/-- `listTools`: the names listed, in catalog order. -/
def listTools (principal : Option Principal) (inRepo : Bool) (role : Option Role) : List Text :=
  (catalog.filter fun spec =>
    !isBlockedName spec.name && visible spec (listingRole principal inRepo role) principal).map (·.name)

/-- `readAccess` over `resolveRepoAccess`: the token's repository, a role on a private one, the least role. -/
def readOutcome (principal : Option Principal) (role : Option Role) (isPublic : Bool) (minimum : Option Role) :
    Outcome :=
  match principal with
  | none => if !isPublic then .forbidden else if meets none minimum then .ok else .forbidden
  | some token =>
    if token.pinnedElsewhere then .forbidden
    else if !isPublic && decide (role = none) then .forbidden
    else if meets role minimum then .ok
    else .forbidden

/-- `requireWriteAccess`: a token, its own agent's act, `mcp:write`, the token's repository, the least role. -/
def writeOutcome (principal : Option Principal) (role : Option Role) (minimum : Option Role) : Outcome :=
  match principal with
  | none => .authentication
  | some token =>
    if !token.actOk then .forbidden
    else if !token.write then .forbidden
    else if token.pinnedElsewhere then .forbidden
    else if meets role minimum then .ok
    else .forbidden

/-- `callTool` with arguments its tool accepts: a person-only act first, then the name, then the gate. -/
def callOutcome (name : Text) (principal : Option Principal) (role : Option Role) (isPublic : Bool) : Outcome :=
  if isBlockedName name then .personOnly
  else match toolOf name with
    | none => .notFound
    | some spec =>
      match spec.access with
      | .read => readOutcome principal role isPublic spec.minimum
      | .write => writeOutcome principal role spec.minimum

/-! ## The bearer token -/

/-- `MCP_TOKEN_PREFIX`. -/
def tokenPrefix : Text := u16! "sma_"

/-- `[0-9a-f]`. -/
def isLowerHex (unit : Nat) : Bool := (decide (48 ≤ unit) && decide (unit ≤ 57)) || (decide (97 ≤ unit) && decide (unit ≤ 102))

/-- `isValidMcpTokenFormat`: exactly `sma_` and 64 lowercase hex digits. -/
def isValidTokenFormat (token : Text) : Bool :=
  decide (token.take 4 = tokenPrefix) && decide ((token.drop 4).length = 64) && (token.drop 4).all isLowerHex

/-- JavaScript's `\s`, which `trim` strips too: white space and line terminators. -/
def isSpace (unit : Nat) : Bool :=
  decide (unit ∈ [9, 10, 11, 12, 13, 32, 160, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]) ||
    (decide (0x2000 ≤ unit) && decide (unit ≤ 0x200a))

/-- `text.trim()`. -/
def trim (text : Text) : Text := ((text.dropWhile isSpace).reverse.dropWhile isSpace).reverse

/-- An ASCII letter's lower case; every other unit itself. -/
def lower (unit : Nat) : Nat := if 65 ≤ unit ∧ unit ≤ 90 then unit + 32 else unit

/-- A space or a tab: `[ \t]`. -/
def isBlank (unit : Nat) : Bool := decide (unit = 32) || decide (unit = 9)

/-- What an `Authorization` header says (`ParsedMcpBearer`). -/
inductive Bearer where
  | absent
  | malformed
  | token (value : Text)
  deriving DecidableEq, Repr

/-- `MAX_AUTH_HEADER_LENGTH`. -/
def maxHeaderLength : Nat := 8 * 1024

/--
`parseMcpBearer`: no header is absent; else the trimmed header is `bearer`, in any case, blanks, and one token with
no white space or comma that has the token's format. Anything else is malformed.
-/
def parseBearer : Option Text → Bearer
  | none => .absent
  | some header =>
    if header.length = 0 ∨ header.length > maxHeaderLength then .malformed
    else
      let trimmed := trim header
      let rest := trimmed.drop 6
      let token := rest.dropWhile isBlank
      if (trimmed.take 6).map lower ≠ u16! "bearer" then .malformed
      else if (rest.takeWhile isBlank).isEmpty then .malformed
      else if token.isEmpty then .malformed
      else if token.any (fun unit => isSpace unit || decide (unit = 44)) then .malformed
      else if isValidTokenFormat token then .token token
      else .malformed

end McpAndStackSpec

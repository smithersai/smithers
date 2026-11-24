/-!
# Roles and who may touch a stack

The four roles of a repository and their rank (`worker/Actor.ts`), and the gates every route of the TODO stack asks
(`worker/stack/Access.ts`). An actor here is a role and whether an agent, flow or sandbox acts for the person.
-/

namespace McpAndStackSpec

/-- A role on a repository. A person with none is `none : Option Role`. -/
inductive Role where
  | guest
  | member
  | maintainer
  | admin
  deriving DecidableEq, Repr

/-- A role's authority: no role is 0, Admin is 4 (`rankOf`). -/
def rankOf : Option Role → Nat
  | none => 0
  | some .guest => 1
  | some .member => 2
  | some .maintainer => 3
  | some .admin => 4

/-- Member, Maintainer or Admin (`memberOrAbove`), written as the set it is in the implementation. -/
def memberOrAbove : Option Role → Bool
  | some .member => true
  | some .maintainer => true
  | some .admin => true
  | _ => false

/-- Who is acting: the person's role, and whether someone acts for them (`act` is set). -/
structure Actor where
  role : Option Role
  agent : Bool
  deriving DecidableEq, Repr

/-- Who a change acts for (`StackVia`). -/
inductive Via where
  | person
  | agent
  deriving DecidableEq, Repr

/-- `canAsk`: a Member or above; an agent asks with its person's role. -/
def canAsk (actor : Actor) : Bool := memberOrAbove actor.role

/-- `mayRead`: a signed-in Member or above. -/
def mayRead : Option Actor → Bool
  | none => false
  | some actor => canAsk actor

/-- `mayChange`: commit and drop are a Member's or above, in person. -/
def mayChange (actor : Actor) : Bool := canAsk actor && !actor.agent

/-- `mayConfigure`: a stack's settings are an Admin's, in person. -/
def mayConfigure (actor : Actor) : Bool := decide (actor.role = some .admin) && !actor.agent

/-- `mayRetryAny`: a Maintainer or Admin retries anyone's TODO. -/
def mayRetryAny (actor : Actor) : Bool :=
  match actor.role with
  | some .maintainer => true
  | some .admin => true
  | _ => false

/-- `viaOf`: the person, unless someone acts for them. -/
def viaOf (actor : Actor) : Via := if actor.agent then .agent else .person

end McpAndStackSpec

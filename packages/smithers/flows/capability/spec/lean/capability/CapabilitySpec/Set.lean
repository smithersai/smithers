import CapabilitySpec.Order
import CapabilitySpec.Pattern

/-!
# Capability sets: a meet of any-of groups

A set is a list of groups. A capability is allowed when every group has a pattern that selects it, so the empty list
is unrestricted authority and a list with an empty group is no authority. Intersection joins the lists; it never
simplifies a glob.
-/

namespace CapabilitySpec

abbrev Groups := List (List Pattern)

/-- Every group and the list of groups, sorted without repeats. -/
def sortedGroups (groups : Groups) : Groups := normalize (groups.map normalize)

/-- `fromGroups`: the normal form. A set with an empty group is the one set `none`. -/
def make (groups : Groups) : Groups :=
  if (sortedGroups groups).any List.isEmpty then [[]] else sortedGroups groups

/-- Unrestricted authority. -/
def unrestricted : Groups := []

/-- No authority. -/
def nothing : Groups := [[]]

/-- `allows`. -/
def allows (groups : Groups) (capability : Capability) : Bool :=
  groups.all fun group => group.any fun pattern => selected pattern capability

/-- `intersect`. -/
def intersect (left right : Groups) : Groups := make (left ++ right)

/-- `within`: each group of `outer` provably covers every pattern of some group of `inner`. -/
def within (inner outer : Groups) : Bool :=
  outer.all fun group => inner.any fun candidate =>
    candidate.all fun pattern => group.any fun cover => subsumes cover pattern

end CapabilitySpec

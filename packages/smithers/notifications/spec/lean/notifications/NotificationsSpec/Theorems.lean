import NotificationsSpec.State
import NotificationsSpec.Policy

/-!
# What the specification guarantees

Every statement here is checked by Lean.

The queue's lifecycle is `admitted` or `coalesced` into the pending items, then promoted out of them; a
`rejected-full` admission and a promotion are where a notification's life in the queue ends. The theorems below say
that those ends are final, that every transition is the one its decision names, that replaying a journal reproduces
the live queue, and that the alert and routing policies never page early, never page somebody they should not, and
never let one alert pass for another.
-/

namespace NotificationsSpec

/-! ## Admission -/

theorem replaceFirst_length (matching : Pending → Bool) (notification : Notification) (items out : List Pending)
    (found : replaceFirst matching notification items = some out) : out.length = items.length := by
  induction items generalizing out with
  | nil => simp [replaceFirst] at found
  | cons item rest ih =>
    simp only [replaceFirst] at found
    split at found
    · injection found with found
      subst found
      simp
    · cases later : replaceFirst matching notification rest with
      | none => simp [later] at found
      | some tail =>
        simp [later] at found
        subst found
        simp [ih tail later]

/-- Coalescing keeps every pending item's sequence, in order: the first admission's place in the journal stands. -/
theorem replaceFirst_seqs (matching : Pending → Bool) (notification : Notification) (items out : List Pending)
    (found : replaceFirst matching notification items = some out) :
    out.map (·.seq) = items.map (·.seq) := by
  induction items generalizing out with
  | nil => simp [replaceFirst] at found
  | cons item rest ih =>
    simp only [replaceFirst] at found
    split at found
    · injection found with found
      subst found
      simp
    · cases later : replaceFirst matching notification rest with
      | none => simp [later] at found
      | some tail =>
        simp [later] at found
        subst found
        simp [ih tail later]

/-- A refused admission is final and silent: the queue is exactly what it was. -/
theorem admit_rejected_unchanged (state : State) (notification : Notification) (seq : Int)
    (rejected : (admitOne state notification seq).decision = .rejectedFull) :
    (admitOne state notification seq).state = state := by
  unfold admitOne at rejected ⊢
  split
  · rename_i items found
    simp [found] at rejected
  · split
    · rfl
    · rename_i none room
      simp [none, room] at rejected

/-- An admission is refused only by a full queue. -/
theorem admit_rejected_only_when_full (state : State) (notification : Notification) (seq : Int)
    (rejected : (admitOne state notification seq).decision = .rejectedFull) :
    state.capacity ≤ state.items.length := by
  unfold admitOne at rejected
  split at rejected
  · simp at rejected
  · split at rejected
    · assumption
    · simp at rejected

/-- An `admitted` notification is appended at the sequence it was admitted at; nothing pending moves. -/
theorem admit_admitted_appends (state : State) (notification : Notification) (seq : Int)
    (admitted : (admitOne state notification seq).decision = .admitted) :
    (admitOne state notification seq).state.items = state.items ++ [{ notification, seq }]
      ∧ state.items.length < state.capacity := by
  unfold admitOne at admitted ⊢
  split
  · rename_i items found
    simp [found] at admitted
  · split
    · rename_i none full
      simp [none, full] at admitted
    · rename_i room
      exact ⟨rfl, by omega⟩

/-- A `coalesced` notification takes a pending item's place: the queue is as long, and its sequences as they were. -/
theorem admit_coalesced_keeps_order (state : State) (notification : Notification) (seq : Int)
    (coalesced : (admitOne state notification seq).decision = .coalesced) :
    (admitOne state notification seq).state.items.length = state.items.length
      ∧ (admitOne state notification seq).state.items.map (·.seq) = state.items.map (·.seq) := by
  unfold admitOne at coalesced ⊢
  split
  · rename_i items found
    exact ⟨replaceFirst_length _ _ _ _ found, replaceFirst_seqs _ _ _ _ found⟩
  · split
    · rename_i none full
      simp [none, full] at coalesced
    · rename_i none room
      simp [none, room] at coalesced

/-- The bound holds: a queue within its capacity stays within it under every admission. -/
theorem admit_bounded (state : State) (notification : Notification) (seq : Int)
    (within : state.items.length ≤ state.capacity) :
    (admitOne state notification seq).state.items.length ≤ (admitOne state notification seq).state.capacity
      ∧ (admitOne state notification seq).state.capacity = state.capacity := by
  unfold admitOne
  split
  · rename_i items found
    simp [replaceFirst_length _ _ _ _ found, within]
  · split
    · exact ⟨within, rfl⟩
    · simp
      omega

/-- Admission never shortens the queue: a pending notification leaves only by promotion. -/
theorem admit_never_drops (state : State) (notification : Notification) (seq : Int) :
    state.items.length ≤ (admitOne state notification seq).state.items.length := by
  unfold admitOne
  split
  · rename_i items found
    simp [replaceFirst_length _ _ _ _ found]
  · split <;> simp

/-- Replaying the decision an admission committed gives the state that admission produced. -/
theorem applyAdmission_replays_admit (state : State) (notification : Notification) (seq : Int) :
    applyAdmission state notification seq (admitOne state notification seq).decision
      = (admitOne state notification seq).state := by
  unfold admitOne
  split
  · rename_i items found
    simp [applyAdmission, found]
  · split <;> simp [applyAdmission]

/-- A replayed refusal changes nothing, whatever the queue holds. -/
theorem applyAdmission_rejected (state : State) (notification : Notification) (seq : Int) :
    applyAdmission state notification seq .rejectedFull = state := rfl

/-- Only a system event that declares a key can coalesce; a human steer and a follow-up never do. -/
theorem admit_coalesced_is_keyed_system_event (state : State) (notification : Notification) (seq : Int)
    (coalesced : (admitOne state notification seq).decision = .coalesced) :
    notification.tag = .systemEvent ∧ notification.key ≠ none := by
  have keyed : ∀ items, replaceFirst (coalesces notification) notification items ≠ none →
      coalesceKey notification ≠ none := by
    intro items
    induction items with
    | nil => simp [replaceFirst]
    | cons item rest ih =>
      intro found absent
      simp [replaceFirst, coalesces, absent] at found
      exact ih (by simpa [coalesces, absent] using found) absent
  have key : coalesceKey notification ≠ none := by
    apply keyed state.items
    intro none
    unfold admitOne at coalesced
    simp only [none] at coalesced
    split at coalesced <;> simp at coalesced
  unfold coalesceKey at key
  split at key
  · exact ⟨by assumption, key⟩
  · exact absurd rfl key

/-! ## Promotion -/

theorem filter_partition_length (taken : Pending → Bool) (items : List Pending) :
    (items.filter taken).length + (items.filter (fun item => !taken item)).length = items.length := by
  induction items with
  | nil => rfl
  | cons item rest ih =>
    cases holds : taken item <;> simp [List.filter, holds] <;> omega

/-- A promotion takes exactly what it reports and leaves the rest: nothing is lost and nothing is added. -/
theorem promoteWhere_partition (taken : Pending → Bool) (state : State) :
    (promoteWhere taken state).promoted.length + (promoteWhere taken state).state.items.length
      = state.items.length :=
  filter_partition_length taken state.items

/-- What a promotion takes is exactly the pending items its rule names. -/
theorem promoteWhere_promoted (taken : Pending → Bool) (state : State) (item : Pending) :
    item ∈ (promoteWhere taken state).promoted ↔ item ∈ state.items ∧ taken item = true := by
  simp [promoteWhere]

/-- What a promotion leaves is exactly the pending items its rule does not name. -/
theorem promoteWhere_remaining (taken : Pending → Bool) (state : State) (item : Pending) :
    item ∈ (promoteWhere taken state).state.items ↔ item ∈ state.items ∧ taken item = false := by
  simp [promoteWhere]

/-- Promotion only removes: what is left, and what is taken, keep the journal order they were pending in. -/
theorem promoteWhere_order (taken : Pending → Bool) (state : State) :
    (promoteWhere taken state).state.items.Sublist state.items
      ∧ (promoteWhere taken state).promoted.Sublist state.items :=
  ⟨List.filter_sublist, List.filter_sublist⟩

/-- Promotion is final: the same boundary, asked again, takes nothing more and leaves the queue as it left it. -/
theorem promoteWhere_absorbing (taken : Pending → Bool) (state : State) :
    (promoteWhere taken (promoteWhere taken state).state).promoted = []
      ∧ (promoteWhere taken (promoteWhere taken state).state).state = (promoteWhere taken state).state := by
  constructor
  · simp only [promoteWhere, List.filter_filter]
    rw [List.filter_eq_nil_iff]
    intro item _
    cases taken item <;> simp
  · simp only [promoteWhere, List.filter_filter]
    congr 1
    apply List.filter_congr
    intro item _
    cases taken item <;> simp

/-- A turn-close promotion takes only boundary-delivered notifications, admitted by the cutoff, of its lineage. -/
theorem promoteSteers_sound (state : State) (cutoff : Int) (target : Option Text) (item : Pending)
    (promoted : item ∈ (promoteSteers state (some cutoff) target).promoted) :
    item ∈ state.items ∧ deliversAtBoundary item.notification = true ∧ item.seq ≤ cutoff
      ∧ inLineage target item.notification = true := by
  have taken := (promoteWhere_promoted _ _ _).mp promoted
  simp only [steerTaken, Bool.and_eq_true, decide_eq_true_eq] at taken
  exact ⟨taken.1, taken.2.1.1, taken.2.1.2, taken.2.2⟩

/-- A steer admitted after the cutoff stays pending: it waits for the next boundary. -/
theorem promoteSteers_holds_late (state : State) (cutoff : Int) (target : Option Text) (item : Pending)
    (pending : item ∈ state.items) (late : cutoff < item.seq) :
    item ∈ (promoteSteers state (some cutoff) target).state.items := by
  refine (promoteWhere_remaining _ _ _).mpr ⟨pending, ?_⟩
  have notBy : decide (item.seq ≤ cutoff) = false := by simp; omega
  simp [steerTaken, notBy]

/-- A later cutoff only promotes more: whatever one boundary delivers, a later one would have delivered too. -/
theorem promoteSteers_monotone (state : State) (earlier later : Int) (target : Option Text) (item : Pending)
    (order : earlier ≤ later) (promoted : item ∈ (promoteSteers state (some earlier) target).promoted) :
    item ∈ (promoteSteers state (some later) target).promoted
      ∧ item ∈ (promoteSteers state none target).promoted := by
  have sound := promoteSteers_sound state earlier target item promoted
  constructor
  · refine (promoteWhere_promoted _ _ _).mpr ⟨sound.1, ?_⟩
    have by' : decide (item.seq ≤ later) = true := by simp; omega
    simp [steerTaken, sound.2.1, sound.2.2.2, by']
  · refine (promoteWhere_promoted _ _ _).mpr ⟨sound.1, ?_⟩
    simp [steerTaken, sound.2.1, sound.2.2.2]

/-- A promotion by id takes only boundary-delivered notifications that were named, in the boundary's lineage. -/
theorem promoteIds_sound (state : State) (ids : List Text) (target : Option Text) (item : Pending)
    (promoted : item ∈ (promoteIds state ids target).promoted) :
    item ∈ state.items ∧ deliversAtBoundary item.notification = true ∧ item.notification.id ∈ ids
      ∧ inLineage target item.notification = true := by
  have taken := (promoteWhere_promoted _ _ _).mp promoted
  simp only [idTaken, Bool.and_eq_true, decide_eq_true_eq] at taken
  exact ⟨taken.1, taken.2.1.1, taken.2.1.2, taken.2.2⟩

theorem takeFirst_some (matching : Pending → Bool) (items others : List Pending) (found : Pending)
    (taken : takeFirst matching items = some (found, others)) :
    matching found = true ∧ found ∈ items ∧ others.length + 1 = items.length ∧ others.Sublist items
      ∧ (items.filter matching).take 1 = [found] := by
  induction items generalizing others with
  | nil => simp [takeFirst] at taken
  | cons item rest ih =>
    simp only [takeFirst] at taken
    split at taken
    · rename_i holds
      injection taken with taken
      injection taken with first second
      subst first second
      simp [holds]
    · rename_i fails
      cases later : takeFirst matching rest with
      | none => simp [later] at taken
      | some pair =>
        obtain ⟨deeper, tail⟩ := pair
        simp [later] at taken
        obtain ⟨same, shape⟩ := taken
        subst same shape
        have step := ih tail later
        refine ⟨step.1, by simp [step.2.1], by simp [step.2.2.1], ?_, ?_⟩
        · exact List.Sublist.cons_cons _ step.2.2.2.1
        · simpa [List.filter, fails] using step.2.2.2.2

theorem takeFirst_none (matching : Pending → Bool) (items : List Pending)
    (absent : takeFirst matching items = none) : items.filter matching = [] := by
  induction items with
  | nil => rfl
  | cons item rest ih =>
    simp only [takeFirst] at absent
    split at absent
    · simp at absent
    · rename_i fails
      cases later : takeFirst matching rest with
      | none => simp [List.filter, fails, ih later]
      | some pair => simp [later] at absent

/-- An idle promotion takes exactly the oldest pending queue notification of its lineage, or nothing. -/
theorem promoteQueued_oldest (state : State) (target : Option Text) :
    (promoteQueued state target).promoted = (pending state .queue target).take 1 := by
  unfold promoteQueued pending
  split
  · rename_i absent
    simp [takeFirst_none _ _ absent]
  · rename_i found others taken
    exact (takeFirst_some _ _ _ _ taken).2.2.2.2.symm

/-- An idle promotion takes at most one notification, removes exactly it, and never takes a steer. -/
theorem promoteQueued_one (state : State) (target : Option Text) :
    (promoteQueued state target).promoted.length ≤ 1
      ∧ (promoteQueued state target).promoted.length + (promoteQueued state target).state.items.length
        = state.items.length
      ∧ (promoteQueued state target).state.items.Sublist state.items
      ∧ ∀ item ∈ (promoteQueued state target).promoted, admissionClass item.notification = .queue := by
  unfold promoteQueued
  split
  · simp
  · rename_i found others taken
    have facts := takeFirst_some _ _ _ _ taken
    refine ⟨by simp, by simp; omega, facts.2.2.2.1, ?_⟩
    intro item inside
    simp at inside
    subst inside
    have holds := facts.1
    simp only [Bool.and_eq_true, beq_iff_eq] at holds
    exact holds.1

/-! ## Replaying promotions -/

/-- A replayed promotion leaves no pending item under an id it names. -/
theorem applyPromoted_removes (state : State) (ids : List Text) (item : Pending)
    (left : item ∈ (applyPromoted state ids).items) : item ∈ state.items ∧ item.notification.id ∉ ids := by
  simpa [applyPromoted] using left

/-- A replayed promotion only removes, keeping journal order, and never changes the bound. -/
theorem applyPromoted_shrinks (state : State) (ids : List Text) :
    (applyPromoted state ids).items.Sublist state.items ∧ (applyPromoted state ids).capacity = state.capacity :=
  ⟨List.filter_sublist, rfl⟩

/-- Replaying a promotion record twice is replaying it once: a duplicated record cannot remove more. -/
theorem applyPromoted_idempotent (state : State) (ids : List Text) :
    applyPromoted (applyPromoted state ids) ids = applyPromoted state ids := by
  simp only [applyPromoted, List.filter_filter]
  congr 1
  apply List.filter_congr
  intro item _
  cases decide (item.notification.id ∈ ids) <;> simp

/-- A promotion record that names nothing changes nothing. -/
theorem applyPromoted_nil (state : State) : applyPromoted state [] = state := by
  cases state
  simp [applyPromoted]

/-- Promotion records commute: the order two boundaries are replayed in does not change what is left. -/
theorem applyPromoted_comm (state : State) (first second : List Text) :
    applyPromoted (applyPromoted state first) second = applyPromoted (applyPromoted state second) first := by
  simp only [applyPromoted, List.filter_filter]
  congr 1
  apply List.filter_congr
  intro item _
  exact Bool.and_comm _ _

/--
Replaying the record of a promotion gives the state that promotion left, when no two pending items share an id,
which is what the queue's idempotency key guarantees.
-/
theorem applyPromoted_replays_promotion (taken : Pending → Bool) (state : State)
    (unique : ∀ a ∈ state.items, ∀ b ∈ state.items, a.notification.id = b.notification.id → a = b) :
    applyPromoted state ((promoteWhere taken state).promoted.map (·.notification.id))
      = (promoteWhere taken state).state := by
  simp only [applyPromoted, promoteWhere]
  congr 1
  apply List.filter_congr
  intro item inside
  cases holds : taken item
  · have absent : item.notification.id ∉ (state.items.filter taken).map (·.notification.id) := by
      intro named
      obtain ⟨other, found, same⟩ := List.mem_map.mp named
      have pair := List.mem_filter.mp found
      have equal := unique other pair.1 item inside same
      rw [equal, holds] at pair
      exact absurd pair.2 (by simp)
    simp [absent]
  · have named : item.notification.id ∈ (state.items.filter taken).map (·.notification.id) :=
      List.mem_map.mpr ⟨item, List.mem_filter.mpr ⟨inside, holds⟩, rfl⟩
    simp [named]

/-! ## The journal projection -/

/-- A foreign entry leaves the projected queue unchanged. -/
theorem reduce_foreign (state : State) (entry : Entry) (foreign : fromEntry entry = none) :
    reduce state entry = state := by
  simp [reduce, foreign]

/-- An entry of any other event type is foreign, whatever its source and payload. -/
theorem fromEntry_other (entry : Entry) (other : entry.eventType = .other) : fromEntry entry = none := by
  simp [fromEntry, other]

/-- An admission record counts only under the source of the very notification it admits. -/
theorem fromEntry_admitted_source (entry : Entry) (notification : Notification) (decision : Decision)
    (versioned : Bool) (decoded : fromEntry entry = some (.admitted notification decision versioned)) :
    entry.eventType = .admitted ∧ entry.sourceId = admissionSourcePrefix ++ notification.id := by
  unfold fromEntry at decoded
  split at decoded
  · rename_i type body
    split at decoded
    · rename_i source
      injection decoded with decoded
      injection decoded with first second third
      subst first
      exact ⟨type, source⟩
    · simp at decoded
  · split at decoded <;> simp at decoded
  · simp at decoded

/-- The projection is a fold: a journal read in two parts projects as it does read whole. -/
theorem derive_append (earlier later : List Entry) :
    derive (earlier ++ later) = later.foldl reduce (derive earlier) := by
  simp [derive, List.foldl_append]

/-- A promotion record replayed twice projects as it does replayed once. -/
theorem reduce_promoted_idempotent (state : State) (entry : Entry) (ids : List Text)
    (decoded : fromEntry entry = some (.promoted ids)) :
    reduce (reduce state entry) entry = reduce state entry := by
  simp [reduce, decoded, applyPromoted_idempotent]

theorem applyAdmission_capacity (state : State) (notification : Notification) (seq : Int) (decision : Decision) :
    (applyAdmission state notification seq decision).capacity = state.capacity := by
  cases decision
  · rfl
  · simp only [applyAdmission]
    split <;> rfl
  · rfl

/-- Replay never changes the bound: the projected capacity is the default one, whatever the journal holds. -/
theorem derive_capacity (entries : List Entry) : (derive entries).capacity = defaultCapacity := by
  have step : ∀ (state : State) (entry : Entry), (reduce state entry).capacity = state.capacity := by
    intro state entry
    unfold reduce
    split
    · rfl
    · unfold applyAdmitted
      split
      · rfl
      · exact applyAdmission_capacity _ _ _ _
    · rfl
  have fold : ∀ (entries : List Entry) (state : State),
      (entries.foldl reduce state).capacity = state.capacity := by
    intro entries
    induction entries with
    | nil => intro state; rfl
    | cons entry rest ih => intro state; simp [List.foldl, ih, step]
  exact fold entries (empty defaultCapacity)

/-- A versioned edit of a pending notification replaces it in place: the queue is as long, in the same order. -/
theorem applyAdmitted_edit_keeps_order (state : State) (notification : Notification) (decision : Decision)
    (seq : Int) (pending : state.items.any (fun item => item.notification.id == notification.id) = true) :
    (applyAdmitted state notification decision true seq).items.map (·.seq) = state.items.map (·.seq) := by
  simp only [applyAdmitted, pending, Bool.and_self, if_true, List.map_map]
  apply List.map_congr_left
  intro item _
  simp only [Function.comp]
  split <;> rfl

/-! ## Alert policy: when a page is raised -/

/-- The alerter's own records are never evidence: a page cannot open or close the condition it pages about. -/
theorem observe_own_record (policy : Policy) (eventType : Text) (time : Int) (payload : List (Text × Option Text))
    (open_ : OpenMap) (own : isOwnRecord eventType = true) : observe policy eventType time payload open_ = open_ := by
  simp [observe, own]

/--
A condition that is open stays as it opened or closes; no later entry moves its opening time or its summary, so
an alert about it is the same alert on every tick.
-/
theorem observeCondition_first_open_wins (policy : Policy) (eventType : Text) (time : Int)
    (payload : List (Text × Option Text)) (open_ : OpenMap) (condition : Text)
    (isOpen : isOpenIn open_ condition = true) :
    observeCondition policy eventType time payload open_ condition = open_
      ∨ observeCondition policy eventType time payload open_ condition
        = open_.filter (fun each => each.1 != condition) := by
  unfold observeCondition
  repeat' split
  all_goals first | exact Or.inl rfl | exact Or.inr rfl | simp_all

/-- A condition without a detector is never opened or closed by any entry. -/
theorem observeCondition_without_detector (policy : Policy) (eventType : Text) (time : Int)
    (payload : List (Text × Option Text)) (open_ : OpenMap) (condition : Text)
    (absent : detectorOf policy condition = none) :
    observeCondition policy eventType time payload open_ condition = open_ := by
  simp [observeCondition, absent]

/-- An entry that does not carry a detector's field is ignored: a monitor beat cannot close an approval wait. -/
theorem observeCondition_without_field (policy : Policy) (eventType : Text) (time : Int)
    (payload : List (Text × Option Text)) (open_ : OpenMap) (condition : Text) (detector : Detector)
    (present : detectorOf policy condition = some detector) (absent : find payload detector.field = none) :
    observeCondition policy eventType time payload open_ condition = open_ := by
  simp [observeCondition, present, absent]

/-- An open condition no rule covers raises nothing. -/
theorem alertOf_unruled (policy : Policy) (condition : Open) (now : Int)
    (unruled : find policy.rules condition.condition = none) : alertOf policy condition now = some [] := by
  simp [alertOf, unruled]

/-- Suppression: a condition open for less than its rule's delay raises nothing. -/
theorem alertOf_before_delay (policy : Policy) (condition : Open) (now : Int) (rule : Rule)
    (ruled : find policy.rules condition.condition = some rule) (early : now - condition.since < rule.afterMs) :
    alertOf policy condition now = some [] := by
  simp [alertOf, ruled, early]

/-- A condition raises at most one alert. -/
theorem alertOf_at_most_one (policy : Policy) (condition : Open) (now : Int) (alerts : List Alert)
    (raised : alertOf policy condition now = some alerts) : alerts.length ≤ 1 := by
  unfold alertOf at raised
  split at raised
  · injection raised with raised; subst raised; simp
  · split at raised
    · injection raised with raised; subst raised; simp
    · split at raised
      · simp at raised
      · injection raised with raised; subst raised; simp

/--
What a raised alert is: the alert of a ruled condition past its delay, carrying that condition's run, name and
opening time, the key of exactly that pair, and the severity, owner and runbook the policy resolves.
-/
theorem alertOf_sound (policy : Policy) (condition : Open) (now : Int) (alert : Alert) (alerts : List Alert)
    (raised : alertOf policy condition now = some alerts) (inside : alert ∈ alerts) :
    ∃ rule, find policy.rules condition.condition = some rule
      ∧ rule.afterMs ≤ now - condition.since
      ∧ alert.runId = condition.runId ∧ alert.condition = condition.condition ∧ alert.since = condition.since
      ∧ alert.summary = condition.summary
      ∧ coalescingKey condition.runId condition.condition = some alert.coalescingKey
      ∧ alert.firedAt = firedAtOf rule condition.since now
      ∧ alert.severity = severityOf policy rule ∧ alert.owner = ownerOf policy rule
      ∧ alert.runbook = runbookOf policy rule := by
  unfold alertOf at raised
  split at raised
  · injection raised with raised; subst raised; simp at inside
  · rename_i rule ruled
    split at raised
    · injection raised with raised; subst raised; simp at inside
    · rename_i due
      split at raised
      · simp at raised
      · rename_i key keyed
        injection raised with raised
        subst raised
        simp at inside
        subst inside
        exact ⟨rule, ruled, by omega, rfl, rfl, rfl, rfl, keyed, rfl, rfl, rfl, rfl⟩

/-- Monotone in time: once a condition's alert is due, it is due at every later instant. -/
theorem alertOf_stays_due (policy : Policy) (condition : Open) (now later : Int) (alert : Alert)
    (raised : alertOf policy condition now = some [alert]) (order : now ≤ later) :
    ∃ after, alertOf policy condition later = some [after] ∧ after.since = alert.since
      ∧ after.coalescingKey = alert.coalescingKey ∧ after.severity = alert.severity := by
  obtain ⟨rule, ruled, due, _, _, since, _, keyed, _, severity, _, _⟩ :=
    alertOf_sound policy condition now alert [alert] raised (by simp)
  have stillDue : ¬ (later - condition.since < rule.afterMs) := by omega
  refine ⟨{
    runId := condition.runId
    condition := condition.condition
    since := condition.since
    firedAt := firedAtOf rule condition.since later
    reminder := if reminderAt rule condition.since later = 0 then none else some (reminderAt rule condition.since later)
    severity := severityOf policy rule
    coalescingKey := alert.coalescingKey
    summary := condition.summary
    owner := ownerOf policy rule
    runbook := runbookOf policy rule }, ?_, since.symm, rfl, severity.symm⟩
  simp only [alertOf, ruled, stillDue, keyed, if_false]

/--
Determinism across ticks: without a repeat, the alert a condition raises is the same value at every instant past
the delay. The reading time decides whether an alert is raised and never appears in one.
-/
theorem alertOf_stable_without_repeat (policy : Policy) (condition : Open) (first second : Int) (rule : Rule)
    (a b : Alert) (ruled : find policy.rules condition.condition = some rule) (once : rule.repeatMs = none)
    (atFirst : alertOf policy condition first = some [a]) (atSecond : alertOf policy condition second = some [b]) :
    a = b := by
  unfold alertOf at atFirst atSecond
  simp only [ruled] at atFirst atSecond
  split at atFirst
  · simp at atFirst
  · split at atSecond
    · simp at atSecond
    · split at atFirst
      · simp at atFirst
      · rename_i key keyed
        simp only [keyed] at atSecond
        simp only [firedAtOf, reminderAt, once, if_true] at atFirst atSecond
        injection atFirst with atFirst
        injection atSecond with atSecond
        injection atFirst with atFirst _
        injection atSecond with atSecond _
        rw [← atFirst, ← atSecond]

/-- The repeat count never goes back: a later tick sees at least as many repeats. -/
theorem reminderAt_monotone (rule : Rule) (since now later : Int) (period : Int) (repeats : rule.repeatMs = some period)
    (positive : 0 < period) (order : now ≤ later) : reminderAt rule since now ≤ reminderAt rule since later := by
  simp only [reminderAt, repeats]
  exact Int.ediv_le_ediv positive (by omega)

/--
A page comes due inside the window it describes: no earlier than its condition opened, and no later than the
instant it is judged at. So `firedAt` is never a time before the condition and never a time in the future.
-/
theorem firedAtOf_bounds (rule : Rule) (since now : Int) (delay : 0 ≤ rule.afterMs)
    (periodic : ∀ period, rule.repeatMs = some period → 0 < period) (due : rule.afterMs ≤ now - since) :
    since ≤ firedAtOf rule since now ∧ firedAtOf rule since now ≤ now := by
  unfold firedAtOf reminderAt
  cases repeats : rule.repeatMs with
  | none => simp only; omega
  | some period =>
    have positive := periodic period repeats
    have count : 0 ≤ (now - (since + rule.afterMs)) / period := Int.ediv_nonneg (by omega) (by omega)
    have under : (now - (since + rule.afterMs)) / period * period ≤ now - (since + rule.afterMs) :=
      Int.ediv_mul_le _ (by omega)
    have nonneg : 0 ≤ (now - (since + rule.afterMs)) / period * period := Int.mul_nonneg count (by omega)
    simp only
    omega

/-- Every alert `decideAlerts` raises is the sound alert of one of the open conditions it was given. -/
theorem decideAlerts_sound (policy : Policy) (now : Int) (open_ : List Open) :
    ∀ (alerts : List Alert), decideAlerts policy open_ now = some alerts → ∀ alert ∈ alerts,
      ∃ condition ∈ open_, ∃ rule, find policy.rules condition.condition = some rule
        ∧ rule.afterMs ≤ now - condition.since
        ∧ alert.runId = condition.runId ∧ alert.condition = condition.condition ∧ alert.since = condition.since
        ∧ coalescingKey condition.runId condition.condition = some alert.coalescingKey
        ∧ alert.severity = severityOf policy rule := by
  induction open_ with
  | nil =>
    intro alerts decided alert inside
    simp [decideAlerts] at decided
    subst decided
    simp at inside
  | cons condition rest ih =>
    intro alerts decided alert inside
    simp only [decideAlerts] at decided
    split at decided
    · simp at decided
    · rename_i mine raised
      split at decided
      · simp at decided
      · rename_i later decidedRest
        injection decided with decided
        subst decided
        rcases List.mem_append.mp inside with here | there
        · obtain ⟨rule, ruled, due, run, name, since, _, keyed, _, severity, _, _⟩ :=
            alertOf_sound policy condition now alert mine raised here
          exact ⟨condition, by simp, rule, ruled, due, run, name, since, keyed, severity⟩
        · obtain ⟨found, within, facts⟩ := ih later decidedRest alert there
          exact ⟨found, by simp [within], facts⟩

/-- Dedupe: a tick raises at most one alert per open condition. -/
theorem decideAlerts_at_most_one_each (policy : Policy) (now : Int) (open_ : List Open) :
    ∀ (alerts : List Alert), decideAlerts policy open_ now = some alerts → alerts.length ≤ open_.length := by
  induction open_ with
  | nil =>
    intro alerts decided
    simp [decideAlerts] at decided
    subst decided
    simp
  | cons condition rest ih =>
    intro alerts decided
    simp only [decideAlerts] at decided
    split at decided
    · simp at decided
    · rename_i mine raised
      split at decided
      · simp at decided
      · rename_i later decidedRest
        injection decided with decided
        subst decided
        have one := alertOf_at_most_one policy condition now mine raised
        have others := ih later decidedRest
        simp only [List.length_append, List.length_cons]
        omega

/-- Suppression for a whole tick: while every open condition is inside its delay, nothing is raised. -/
theorem decideAlerts_all_early (policy : Policy) (now : Int) (open_ : List Open)
    (early : ∀ condition ∈ open_, ∀ rule, find policy.rules condition.condition = some rule →
      now - condition.since < rule.afterMs) : decideAlerts policy open_ now = some [] := by
  induction open_ with
  | nil => rfl
  | cons condition rest ih =>
    have mine : alertOf policy condition now = some [] := by
      cases ruled : find policy.rules condition.condition with
      | none => exact alertOf_unruled policy condition now ruled
      | some rule => exact alertOf_before_delay policy condition now rule ruled (early condition (by simp) rule ruled)
    have later := ih (fun each inside => early each (by simp [inside]))
    simp [decideAlerts, mine, later]

/-! ## Alert policy: severity -/

/-- A rule's own severity wins over the policy's default. -/
theorem severityOf_rule (policy : Policy) (rule : Rule) (severity : Severity) (own : rule.severity = some severity) :
    severityOf policy rule = severity := by
  simp [severityOf, own]

/-- A rule that names no severity takes the policy's default. -/
theorem severityOf_default (policy : Policy) (rule : Rule) (defaults : Defaults) (severity : Severity)
    (silent : rule.severity = none) (given : policy.defaults = some defaults)
    (named : defaults.severity = some severity) : severityOf policy rule = severity := by
  cases defaults
  simp_all [severityOf]

/-- With no severity on the rule and none by default, an alert is a `warning`. -/
theorem severityOf_fallback (policy : Policy) (rule : Rule) (silent : rule.severity = none)
    (bare : policy.defaults = none ∨ ∃ defaults, policy.defaults = some defaults ∧ defaults.severity = none) :
    severityOf policy rule = .warning := by
  rcases bare with none | ⟨defaults, given, unnamed⟩
  · simp [severityOf, silent, none]
  · cases defaults
    simp_all [severityOf]

/-! ## Alert policy: keys cannot be forged -/

theorem hexDigit_ne_colon (value : Nat) : hexDigit value ≠ 58 := by
  unfold hexDigit
  split <;> omega

theorem percent_no_colon (byte : Nat) : 58 ∉ percent byte := by
  simp [percent, Ne.symm (hexDigit_ne_colon _)]

theorem percentUtf8_no_colon (point : Nat) : 58 ∉ percentUtf8 point := by
  unfold percentUtf8
  split
  · exact percent_no_colon _
  · split
    · simp [percent_no_colon]
    · split <;> simp [percent_no_colon]

/-- A percent-encoded component never holds the separator `:`. -/
theorem encodeAux_no_colon (fuel : Nat) : ∀ (text encoded : Text), encodeAux fuel text = some encoded → 58 ∉ encoded := by
  induction fuel with
  | zero =>
    intro text encoded result
    cases text with
    | nil => simp [encodeAux] at result; subst result; simp
    | cons c cs => simp [encodeAux] at result
  | succ fuel ih =>
    intro text encoded result
    cases text with
    | nil => simp [encodeAux] at result; subst result; simp
    | cons c cs =>
      simp only [encodeAux] at result
      split at result
      · rename_i kept
        cases later : encodeAux fuel cs with
        | none => simp [later] at result
        | some tail =>
          simp [later] at result
          subst result
          have clean := ih cs tail later
          have notColon : c ≠ 58 := by
            intro equal
            subst equal
            simp [isUnreserved] at kept
          simp [clean, Ne.symm notColon]
      · split at result
        · simp at result
        · split at result
          · split at result
            · rename_i low rest
              split at result
              · cases later : encodeAux fuel rest with
                | none => simp [later] at result
                | some tail =>
                  simp [later] at result
                  subst result
                  simp [percentUtf8_no_colon, ih rest tail later]
              · simp at result
            · simp at result
          · cases later : encodeAux fuel cs with
            | none => simp [later] at result
            | some tail =>
              simp [later] at result
              subst result
              simp [percentUtf8_no_colon, ih cs tail later]

theorem split_at_colon : ∀ (a b c d : Text), 58 ∉ a → 58 ∉ c → a ++ 58 :: b = c ++ 58 :: d → a = c ∧ b = d := by
  intro a
  induction a with
  | nil =>
    intro b c d _ cleanC equal
    cases c with
    | nil => simpa using equal
    | cons head tail =>
      simp at equal
      exact absurd (by simp [equal.1]) cleanC
  | cons head tail ih =>
    intro b c d cleanA cleanC equal
    cases c with
    | nil =>
      simp at equal
      exact absurd (by simp [equal.1]) cleanA
    | cons first others =>
      simp at equal
      have step := ih b others d (fun inside => cleanA (by simp [inside])) (fun inside => cleanC (by simp [inside]))
        equal.2
      exact ⟨by simp [equal.1, step.1], step.2⟩

/--
No forgery. Two pairs share a coalescing key only when their run ids encode alike and their conditions encode
alike: a run id or a condition name that holds the separator cannot produce another pair's key, so it cannot
suppress a page that belongs to somebody else.
-/
theorem coalescingKey_no_forgery (runA conditionA runB conditionB key : Text)
    (first : coalescingKey runA conditionA = some key) (second : coalescingKey runB conditionB = some key) :
    encodeURIComponent runA = encodeURIComponent runB
      ∧ encodeURIComponent conditionA = encodeURIComponent conditionB := by
  unfold coalescingKey at first second
  cases encodedRunA : encodeURIComponent runA with
  | none => simp [encodedRunA] at first
  | some a =>
    cases encodedConditionA : encodeURIComponent conditionA with
    | none => simp [encodedRunA, encodedConditionA] at first
    | some b =>
      cases encodedRunB : encodeURIComponent runB with
      | none => simp [encodedRunB] at second
      | some c =>
        cases encodedConditionB : encodeURIComponent conditionB with
        | none => simp [encodedRunB, encodedConditionB] at second
        | some d =>
          simp [encodedRunA, encodedConditionA] at first
          simp [encodedRunB, encodedConditionB] at second
          have parts := split_at_colon a b c d (encodeAux_no_colon _ _ _ encodedRunA)
            (encodeAux_no_colon _ _ _ encodedRunB) (first.trans second.symm)
          simp [parts.1, parts.2]

/-- An alert's id begins with its key, so alerts under different keys never share an id's opening. -/
theorem alertId_prefix (key : Text) (since : Int) (reminder : Option Int) :
    (ascii "alert:" ++ key) <+: alertId key since reminder := by
  unfold alertId
  exact List.IsPrefix.trans (List.prefix_append _ _) (List.prefix_append _ _)

/-! ## Inbox routing: who is told -/

/--
Everyone `heard` returns is a listed watcher who may read the run, is not muted, is not the excluded principal and
was not already counted.
-/
theorem heardFrom_safe (mayRead : Text → Bool) (exclude : Option Text) (watchers : List Watcher) :
    ∀ (seen : List Text), ∀ watcher ∈ heardFrom mayRead exclude seen watchers,
      watcher ∈ watchers ∧ mayRead watcher.principal = true ∧ watcher.level ≠ .muted
        ∧ exclude ≠ some watcher.principal ∧ watcher.principal ∉ seen := by
  induction watchers with
  | nil => intro seen watcher inside; simp [heardFrom] at inside
  | cons first rest ih =>
    intro seen watcher inside
    simp only [heardFrom] at inside
    split at inside
    · have facts := ih seen watcher inside
      exact ⟨by simp [facts.1], facts.2⟩
    · rename_i fresh
      split at inside
      · have facts := ih (first.principal :: seen) watcher inside
        exact ⟨by simp [facts.1], facts.2.1, facts.2.2.1, facts.2.2.2.1,
          fun within => facts.2.2.2.2 (by simp [within])⟩
      · rename_i told
        rcases List.mem_cons.mp inside with rfl | later
        · refine ⟨by simp, ?_, fun muted => told (Or.inl muted), fun excluded => fresh (Or.inl excluded),
            fun within => fresh (Or.inr within)⟩
          cases readable : mayRead watcher.principal
          · exact absurd (Or.inr readable) told
          · rfl
        · have facts := ih (first.principal :: seen) watcher later
          exact ⟨by simp [facts.1], facts.2.1, facts.2.2.1, facts.2.2.2.1,
            fun within => facts.2.2.2.2 (by simp [within])⟩

/-- Nobody is heard twice: a principal counts once, however many times they are listed. -/
theorem heardFrom_nodup (mayRead : Text → Bool) (exclude : Option Text) (watchers : List Watcher) :
    ∀ (seen : List Text), ((heardFrom mayRead exclude seen watchers).map (·.principal)).Nodup := by
  induction watchers with
  | nil => intro seen; simp [heardFrom]
  | cons first rest ih =>
    intro seen
    simp only [heardFrom]
    split
    · exact ih seen
    · split
      · exact ih _
      · simp only [List.map_cons, List.nodup_cons]
        refine ⟨?_, ih _⟩
        intro repeated
        obtain ⟨other, within, same⟩ := List.mem_map.mp repeated
        have facts := heardFrom_safe mayRead exclude rest (first.principal :: seen) other within
        exact facts.2.2.2.2 (by simp [same])

/-- Filtering safety: nobody who may not read a run is told about it, launcher or watcher. -/
theorem route_only_readers (launcher : Option Text) (state : RunState) (watchers : List Watcher)
    (mayRead : Text → Bool) : ∀ told ∈ route launcher state watchers mayRead, mayRead told.recipient = true := by
  intro told inside
  unfold route at inside
  rcases List.mem_append.mp inside with first | later
  · cases launcher with
    | none => simp at first
    | some principal =>
      simp only at first
      split at first
      · simp at first
        subst first
        assumption
      · simp at first
  · obtain ⟨watcher, within, rfl⟩ := List.mem_map.mp later
    exact (heardFrom_safe mayRead launcher watchers [] watcher within).2.1

/-- A watcher who is told is listed and not muted: muting is honoured for every delivery that is not the launcher's. -/
theorem route_watchers_unmuted (launcher : Option Text) (state : RunState) (watchers : List Watcher)
    (mayRead : Text → Bool) (told : Told) (inside : told ∈ route launcher state watchers mayRead)
    (other : told.mine = false) :
    ∃ watcher ∈ watchers, watcher.principal = told.recipient ∧ watcher.level ≠ .muted
      ∧ told.quiet = decide (watcher.level = .attention) ∧ launcher ≠ some told.recipient := by
  unfold route at inside
  rcases List.mem_append.mp inside with first | later
  · cases launcher with
    | none => simp at first
    | some principal =>
      simp only at first
      split at first
      · simp at first
        subst first
        simp at other
      · simp at first
  · obtain ⟨watcher, within, rfl⟩ := List.mem_map.mp later
    have facts := heardFrom_safe mayRead launcher watchers [] watcher within
    exact ⟨watcher, facts.1, rfl, facts.2.2.1, rfl, facts.2.2.2.1⟩

/-- Only the launcher's delivery is `mine`, and only the launcher is ever told the run needs them. -/
theorem route_needs_you_is_the_launchers (launcher : Option Text) (state : RunState) (watchers : List Watcher)
    (mayRead : Text → Bool) (told : Told) (inside : told ∈ route launcher state watchers mayRead) :
    (told.mine = true → launcher = some told.recipient ∧ told.state = state ∧ told.quiet = false)
      ∧ (told.state = .needsYou → told.mine = true) := by
  unfold route at inside
  rcases List.mem_append.mp inside with first | later
  · cases launcher with
    | none => simp at first
    | some principal =>
      simp only at first
      split at first
      · simp at first
        subst first
        simp
      · simp at first
  · obtain ⟨watcher, within, rfl⟩ := List.mem_map.mp later
    refine ⟨by simp, ?_⟩
    simp only [watcherState]
    split <;> simp_all

/-- Nobody is told twice: the launcher is not also a watcher's delivery, and no watcher is delivered to twice. -/
theorem route_nodup (launcher : Option Text) (state : RunState) (watchers : List Watcher) (mayRead : Text → Bool) :
    ((route launcher state watchers mayRead).map (·.recipient)).Nodup := by
  have watchersOnce : ((heard mayRead launcher watchers).map (·.principal)).Nodup :=
    heardFrom_nodup mayRead launcher watchers []
  unfold route
  cases launcher with
  | none => simpa [List.map_map, Function.comp_def] using watchersOnce
  | some principal =>
    simp only
    split
    · simp only [List.cons_append, List.nil_append, List.map_cons, List.map_map, List.nodup_cons]
      refine ⟨?_, by simpa [Function.comp_def] using watchersOnce⟩
      intro repeated
      obtain ⟨watcher, within, same⟩ := List.mem_map.mp repeated
      have facts := heardFrom_safe mayRead (some principal) watchers [] watcher within
      simp only [Function.comp] at same
      exact facts.2.2.2.1 (by rw [same])
    · simpa [List.map_map, Function.comp_def] using watchersOnce

/-- `audience` holds only listed, unmuted principals who may read the run, each once. -/
theorem audience_safe (watchers : List Watcher) (mayRead : Text → Bool) :
    (audience watchers mayRead).Nodup
      ∧ ∀ principal ∈ audience watchers mayRead, mayRead principal = true
        ∧ ∃ watcher ∈ watchers, watcher.principal = principal ∧ watcher.level ≠ .muted := by
  refine ⟨heardFrom_nodup mayRead none watchers [], ?_⟩
  intro principal inside
  obtain ⟨watcher, within, rfl⟩ := List.mem_map.mp inside
  have facts := heardFrom_safe mayRead none watchers [] watcher within
  exact ⟨facts.2.1, watcher, facts.1, rfl, facts.2.2.1⟩

/-! ## Inbox: what raises a notice, and how marks advance -/

/-- A run's first notice always raises. -/
theorem raises_first (after : RunState) : raises none after = true := rfl

/-- A state that did not change raises nothing: no notice is raised twice for one state. -/
theorem raises_unchanged (state : RunState) : raises (some state) state = false := by
  simp [raises]

/-- A change raises only into a state that asks for attention; `working` and `waiting` never raise one. -/
theorem raises_only_attention (before after : RunState) (raised : raises (some before) after = true) :
    after = .needsYou ∨ after = .failed ∨ after = .done := by
  cases after <;> simp_all [raises, isAttention]

/-- An acknowledgement never changes the notice's own version. -/
theorem ack_version (notice : Versions) (act : Act) (version : Int) :
    (ack notice act version).version = notice.version := by
  unfold ack
  split
  · rfl
  · split
    · cases act <;> rfl
    · rfl

/-- Marks only advance: no acknowledgement moves a read, dismiss or hide mark backwards, whatever it names. -/
theorem ack_monotone (notice : Versions) (act other : Act) (version : Int) :
    markOf notice other ≤ markOf (ack notice act version) other := by
  unfold ack
  split
  · exact Int.le_refl _
  · split
    · cases act <;> cases other <;> simp_all [setMark, markOf] <;> omega
    · exact Int.le_refl _

/-- An acknowledgement touches only the mark it names. -/
theorem ack_touches_one (notice : Versions) (act other : Act) (version : Int) (different : other ≠ act) :
    markOf (ack notice act version) other = markOf notice other := by
  unfold ack
  split
  · rfl
  · split
    · cases act <;> cases other <;> simp_all [setMark, markOf]
    · rfl

/-- A mark never passes the notice's version, unless it was already past it. -/
theorem ack_bounded (notice : Versions) (act : Act) (version : Int) :
    markOf (ack notice act version) act ≤ notice.version ∨ markOf (ack notice act version) act = markOf notice act := by
  unfold ack
  split
  · exact Or.inr rfl
  · split
    · left
      cases act <;> simp [setMark, markOf, capped] <;> split <;> omega
    · exact Or.inr rfl

/-- Acknowledging the same version twice is acknowledging it once. -/
theorem ack_idempotent (notice : Versions) (act : Act) (version : Int) :
    ack (ack notice act version) act version = ack notice act version := by
  cases safe : isSafe version
  · simp [ack, safe]
  · by_cases advances : markOf notice act < capped version notice.version
    · have once : ack notice act version = setMark notice act (capped version notice.version) := by
        simp [ack, safe, advances]
      have settled : ¬ (markOf (setMark notice act (capped version notice.version)) act
          < capped version (setMark notice act (capped version notice.version)).version) := by
        cases act <;> simp [setMark, markOf]
      rw [once]
      simp [ack, safe, settled]
    · simp [ack, safe, advances]

/-- A version that is not a safe integer acknowledges nothing. -/
theorem ack_unsafe (notice : Versions) (act : Act) (version : Int) (refused : isSafe version = false) :
    ack notice act version = notice := by
  simp [ack, refused]

/-- Dismissing at or past a notice's version closes it, and it stays closed under every later acknowledgement. -/
theorem ack_dismiss_closes (notice : Versions) (version : Int) (safe : isSafe version = true)
    (current : notice.version ≤ version) :
    isOpen (ack notice .dismiss version) = false
      ∧ ∀ act later, isOpen (ack (ack notice .dismiss version) act later) = false := by
  have closed : isOpen (ack notice .dismiss version) = false := by
    unfold ack
    simp only [safe, Bool.true_eq_false, if_false]
    split
    · simp [isOpen, setMark, capped]
      split <;> omega
    · rename_i settled
      simp [markOf, capped] at settled
      simp [isOpen]
      split at settled <;> omega
  refine ⟨closed, ?_⟩
  intro act later
  have grows := ack_monotone (ack notice .dismiss version) act .dismiss later
  have same := ack_version (ack notice .dismiss version) act later
  simp only [isOpen, markOf, decide_eq_false_iff_not] at closed grows ⊢
  omega

end NotificationsSpec

import CronSpec.Search
import CronSpec.Parse

/-!
# Machine-checked laws of the occurrence searches

Every theorem here is proved in full from the definitions of the specification and rests on nothing but Lean's own
foundations. The laws hold for every schedule, well formed or not, and every instant, before the epoch or after.

The next occurrence of a schedule after an instant is strictly later, fires, and is the first instant after it that
does. The latest occurrence at or before an instant is no later, fires, and is the last that does. Both follow from
the same two facts about the bounded searches of `Basic`.
-/

namespace CronSpec

/-! ## The bounded searches -/

/-- A found number satisfies the predicate, lies in the window, and is the least that does. -/
theorem firstFrom_some {p : Nat → Bool} : ∀ (count floor : Nat) {found : Nat}, firstFrom p floor count = some found →
    p found = true ∧ floor ≤ found ∧ found < floor + count ∧ ∀ k, floor ≤ k → k < found → p k = false
  | 0, _, _, h => by simp [firstFrom] at h
  | count + 1, floor, found, h => by
    unfold firstFrom at h
    by_cases here : p floor = true
    · rw [if_pos here] at h
      cases h
      exact ⟨here, Nat.le_refl _, by omega, fun k low high => by omega⟩
    · rw [if_neg here] at h
      have ⟨holds, low, high, least⟩ := firstFrom_some count (floor + 1) h
      refine ⟨holds, by omega, by omega, fun k atLeast below => ?_⟩
      by_cases same : k = floor
      · subst same
        simpa using here
      · exact least k (by omega) below

/-- A search that finds nothing has a window in which nothing satisfies the predicate. -/
theorem firstFrom_none {p : Nat → Bool} : ∀ (count floor : Nat), firstFrom p floor count = none →
    ∀ k, floor ≤ k → k < floor + count → p k = false
  | 0, _, _, k, low, high => by omega
  | count + 1, floor, h, k, low, high => by
    unfold firstFrom at h
    by_cases here : p floor = true
    · rw [if_pos here] at h
      cases h
    · rw [if_neg here] at h
      by_cases same : k = floor
      · subst same
        simpa using here
      · exact firstFrom_none count (floor + 1) h k (by omega) (by omega)

/-- A found number satisfies the predicate, lies below the ceiling, and is the greatest that does. -/
theorem lastBelow_some {p : Nat → Bool} : ∀ (ceiling : Nat) {found : Nat}, lastBelow p ceiling = some found →
    p found = true ∧ found < ceiling ∧ ∀ k, found < k → k < ceiling → p k = false
  | 0, _, h => by simp [lastBelow] at h
  | ceiling + 1, found, h => by
    unfold lastBelow at h
    by_cases here : p ceiling = true
    · rw [if_pos here] at h
      cases h
      exact ⟨here, by omega, fun k low high => by omega⟩
    · rw [if_neg here] at h
      have ⟨holds, below, greatest⟩ := lastBelow_some ceiling h
      refine ⟨holds, by omega, fun k above under => ?_⟩
      by_cases same : k = ceiling
      · subst same
        simpa using here
      · exact greatest k above (by omega)

/-- A search that finds nothing has nothing below the ceiling that satisfies the predicate. -/
theorem lastBelow_none {p : Nat → Bool} : ∀ (ceiling : Nat), lastBelow p ceiling = none →
    ∀ k, k < ceiling → p k = false
  | 0, _, k, high => by omega
  | ceiling + 1, h, k, high => by
    unfold lastBelow at h
    by_cases here : p ceiling = true
    · rw [if_pos here] at h
      cases h
    · rw [if_neg here] at h
      by_cases same : k = ceiling
      · subst same
        simpa using here
      · exact lastBelow_none ceiling h k (by omega)

/-! ## An instant as a day and a second of it -/

/-- A schedule fires at a second of a day exactly when it matches the day and the second. -/
theorem fires_at (cron : Cron) (day : Int) (second : Nat) (inDay : second < 86400) :
    fires cron (day * 86400 + second) = (dateMatch cron day && timeMatch cron second) := by
  have dayOf : (day * 86400 + (second : Int)) / 86400 = day := by omega
  have secondOf : ((day * 86400 + (second : Int)) % 86400).toNat = second := by omega
  unfold fires
  rw [dayOf, secondOf]

/-- Every instant is a second of its day. -/
theorem instant_split (instant : Int) :
    instant = instant / 86400 * 86400 + ((instant % 86400).toNat : Int) ∧ (instant % 86400).toNat < 86400 := by
  omega

/-- A schedule fires at no instant whose second of the day it does not match, nor one whose day it does not. -/
theorem fires_false_of_time {cron : Cron} {instant : Int}
    (h : timeMatch cron (instant % 86400).toNat = false) : fires cron instant = false := by
  simp [fires, h]

theorem fires_false_of_date {cron : Cron} {instant : Int}
    (h : dateMatch cron (instant / 86400) = false) : fires cron instant = false := by
  simp [fires, h]

/-! ## The next occurrence -/

/-- A second found later today matches the day and the time, is later, and is the first such second. -/
theorem laterToday_some {cron : Cron} {day : Int} {second found : Nat} (h : laterToday cron day second = some found) :
    dateMatch cron day = true ∧ timeMatch cron found = true ∧ second < found ∧ found < 86400 ∧
      ∀ k, second < k → k < found → timeMatch cron k = false := by
  unfold laterToday at h
  by_cases today : dateMatch cron day = true
  · rw [if_pos today] at h
    have ⟨holds, low, high, least⟩ := firstFrom_some _ _ h
    exact ⟨today, holds, by omega, by omega, fun k above below => least k (by omega) below⟩
  · rw [if_neg today] at h
    cases h

/-- When nothing is found later today, no later second of the day fires. -/
theorem laterToday_none {cron : Cron} {day : Int} {second : Nat} (h : laterToday cron day second = none)
    (k : Nat) (above : second < k) (inDay : k < 86400) : (dateMatch cron day && timeMatch cron k) = false := by
  unfold laterToday at h
  by_cases today : dateMatch cron day = true
  · rw [if_pos today] at h
    simp [firstFrom_none _ _ h k (by omega) (by omega)]
  · simp [today]

/--
**The next occurrence is exact.** It is strictly later than the instant, the schedule fires at it, and the schedule
fires at no instant between the two.
-/
theorem nextSecond_spec {cron : Cron} {instant found : Int} (h : nextSecond cron instant = some found) :
    instant < found ∧ fires cron found = true ∧ ∀ between, instant < between → between < found →
      fires cron between = false := by
  have ⟨split, inDay⟩ := instant_split instant
  unfold nextSecond at h
  simp only at h
  cases today : laterToday cron (instant / 86400) (instant % 86400).toNat with
  | some second =>
    rw [today] at h
    cases h
    have ⟨date, time, later, bound, least⟩ := laterToday_some today
    refine ⟨by omega, by rw [fires_at _ _ _ bound, date, time]; rfl, fun between above below => ?_⟩
    have ⟨splitBetween, _⟩ := instant_split between
    have sameDay : between / 86400 = instant / 86400 := by omega
    exact fires_false_of_time (least _ (by omega) (by omega))
  | none =>
    rw [today] at h
    cases days : firstFrom (fun ahead => dateMatch cron (instant / 86400 + 1 + ahead)) 0 horizon with
    | none => simp [days] at h
    | some ahead =>
      cases times : firstFrom (timeMatch cron) 0 86400 with
      | none => simp [days, times] at h
      | some second =>
        simp only [days, times] at h
        cases h
        have ⟨date, _, _, noDay⟩ := firstFrom_some _ _ days
        have ⟨time, _, bound, noTime⟩ := firstFrom_some _ _ times
        refine ⟨by omega, by rw [fires_at _ _ _ (by omega)]; simp only [date, time]; rfl,
          fun between above below => ?_⟩
        have ⟨splitBetween, boundBetween⟩ := instant_split between
        by_cases sameDay : between / 86400 = instant / 86400
        · rw [splitBetween, fires_at _ _ _ boundBetween, sameDay]
          exact laterToday_none today _ (by omega) boundBetween
        · by_cases lastDay : between / 86400 = instant / 86400 + 1 + ahead
          · exact fires_false_of_time (noTime _ (by omega) (by omega))
          · have skipped := noDay (between / 86400 - (instant / 86400 + 1)).toNat (by omega) (by omega)
            have dayOf : instant / 86400 + 1 + ((between / 86400 - (instant / 86400 + 1)).toNat : Int)
                = between / 86400 := by omega
            simp only [dayOf] at skipped
            exact fires_false_of_date skipped

/-- **Strict monotonicity.** The next occurrence is strictly after the instant it is asked from. -/
theorem nextSecond_gt {cron : Cron} {instant found : Int} (h : nextSecond cron instant = some found) :
    instant < found := (nextSecond_spec h).1

/-- **Match soundness.** The schedule fires at the next occurrence. -/
theorem nextSecond_fires {cron : Cron} {instant found : Int} (h : nextSecond cron instant = some found) :
    fires cron found = true := (nextSecond_spec h).2.1

/-- **Minimality.** An instant the schedule fires at after the given one is no earlier than the next occurrence. -/
theorem nextSecond_least {cron : Cron} {instant found other : Int} (h : nextSecond cron instant = some found)
    (later : instant < other) (fired : fires cron other = true) : found ≤ other := by
  refine Int.not_lt.mp (fun before => ?_)
  rw [(nextSecond_spec h).2.2 other later before] at fired
  cases fired

/-- **Monotonicity.** Asking from a later instant never answers with an earlier occurrence. -/
theorem nextSecond_mono {cron : Cron} {first second firstFound secondFound : Int}
    (hFirst : nextSecond cron first = some firstFound) (hSecond : nextSecond cron second = some secondFound)
    (ordered : first ≤ second) : firstFound ≤ secondFound :=
  nextSecond_least hFirst (Int.lt_of_le_of_lt ordered (nextSecond_gt hSecond)) (nextSecond_fires hSecond)

/-- Asking again from any instant before the next occurrence answers with the same occurrence. -/
theorem nextSecond_stable {cron : Cron} {instant found other otherFound : Int}
    (h : nextSecond cron instant = some found) (hOther : nextSecond cron other = some otherFound)
    (later : instant ≤ other) (before : other < found) : otherFound = found :=
  Int.le_antisymm (nextSecond_least hOther before (nextSecond_fires h)) (nextSecond_mono h hOther later)

/--
When the search finds nothing, the schedule fires at no instant from the one given to the end of the search's
horizon of 146,097 days, one full era of the calendar.
-/
theorem nextSecond_none {cron : Cron} {instant : Int} (h : nextSecond cron instant = none) (other : Int)
    (later : instant < other) (within : other < (instant / 86400 + 1 + horizon) * 86400) :
    fires cron other = false := by
  have ⟨split, inDay⟩ := instant_split instant
  have ⟨splitOther, boundOther⟩ := instant_split other
  unfold nextSecond at h
  simp only at h
  cases today : laterToday cron (instant / 86400) (instant % 86400).toNat with
  | some second => simp [today] at h
  | none =>
    by_cases sameDay : other / 86400 = instant / 86400
    · rw [splitOther, fires_at _ _ _ boundOther, sameDay]
      exact laterToday_none today _ (by omega) boundOther
    · rw [today] at h
      have dayOf : instant / 86400 + 1 + ((other / 86400 - (instant / 86400 + 1)).toNat : Int)
          = other / 86400 := by omega
      cases days : firstFrom (fun ahead => dateMatch cron (instant / 86400 + 1 + ahead)) 0 horizon with
      | none =>
        have skipped := firstFrom_none _ _ days (other / 86400 - (instant / 86400 + 1)).toNat (by omega)
          (by unfold horizon at *; omega)
        simp only [dayOf] at skipped
        exact fires_false_of_date skipped
      | some ahead =>
        cases times : firstFrom (timeMatch cron) 0 86400 with
        | some second => simp [days, times] at h
        | none => exact fires_false_of_time (firstFrom_none _ _ times _ (by omega) (by omega))

/-! ## The latest occurrence -/

/-- A second found earlier today matches the day and the time, is no later, and is the last such second. -/
theorem earlierToday_some {cron : Cron} {day : Int} {second found : Nat}
    (h : earlierToday cron day second = some found) :
    dateMatch cron day = true ∧ timeMatch cron found = true ∧ found ≤ second ∧
      ∀ k, found < k → k ≤ second → timeMatch cron k = false := by
  unfold earlierToday at h
  by_cases today : dateMatch cron day = true
  · rw [if_pos today] at h
    have ⟨holds, below, greatest⟩ := lastBelow_some _ h
    exact ⟨today, holds, by omega, fun k above under => greatest k above (by omega)⟩
  · rw [if_neg today] at h
    cases h

/-- When nothing is found earlier today, no second of the day up to the given one fires. -/
theorem earlierToday_none {cron : Cron} {day : Int} {second : Nat} (h : earlierToday cron day second = none)
    (k : Nat) (under : k ≤ second) : (dateMatch cron day && timeMatch cron k) = false := by
  unfold earlierToday at h
  by_cases today : dateMatch cron day = true
  · rw [if_pos today] at h
    simp [lastBelow_none _ h k (by omega)]
  · simp [today]

/--
**The latest occurrence is exact.** It is no later than the instant, the schedule fires at it, and the schedule
fires at no instant after it up to the instant.
-/
theorem previousSecond_spec {cron : Cron} {instant found : Int} (h : previousSecond cron instant = some found) :
    found ≤ instant ∧ fires cron found = true ∧ ∀ between, found < between → between ≤ instant →
      fires cron between = false := by
  have ⟨split, inDay⟩ := instant_split instant
  unfold previousSecond at h
  simp only at h
  cases today : earlierToday cron (instant / 86400) (instant % 86400).toNat with
  | some second =>
    rw [today] at h
    cases h
    have ⟨date, time, earlier, greatest⟩ := earlierToday_some today
    refine ⟨by omega, by rw [fires_at _ _ _ (by omega), date, time]; rfl, fun between above below => ?_⟩
    have ⟨splitBetween, _⟩ := instant_split between
    have sameDay : between / 86400 = instant / 86400 := by omega
    exact fires_false_of_time (greatest _ (by omega) (by omega))
  | none =>
    rw [today] at h
    cases days : firstFrom (fun back => dateMatch cron (instant / 86400 - 1 - back)) 0 horizon with
    | none => simp [days] at h
    | some back =>
      cases times : lastBelow (timeMatch cron) 86400 with
      | none => simp [days, times] at h
      | some second =>
        simp only [days, times] at h
        cases h
        have ⟨date, _, _, noDay⟩ := firstFrom_some _ _ days
        have ⟨time, bound, noTime⟩ := lastBelow_some _ times
        refine ⟨by omega, by rw [fires_at _ _ _ bound]; simp only [date, time]; rfl,
          fun between above below => ?_⟩
        have ⟨splitBetween, boundBetween⟩ := instant_split between
        by_cases sameDay : between / 86400 = instant / 86400
        · rw [splitBetween, fires_at _ _ _ boundBetween, sameDay]
          exact earlierToday_none today _ (by omega)
        · by_cases firstDay : between / 86400 = instant / 86400 - 1 - back
          · exact fires_false_of_time (noTime _ (by omega) (by omega))
          · have skipped := noDay (instant / 86400 - 1 - between / 86400).toNat (by omega) (by omega)
            have dayOf : instant / 86400 - 1 - ((instant / 86400 - 1 - between / 86400).toNat : Int)
                = between / 86400 := by omega
            simp only [dayOf] at skipped
            exact fires_false_of_date skipped

/-- The latest occurrence is at or before the instant it is asked at. -/
theorem previousSecond_le {cron : Cron} {instant found : Int} (h : previousSecond cron instant = some found) :
    found ≤ instant := (previousSecond_spec h).1

/-- The schedule fires at the latest occurrence. -/
theorem previousSecond_fires {cron : Cron} {instant found : Int} (h : previousSecond cron instant = some found) :
    fires cron found = true := (previousSecond_spec h).2.1

/-- An instant the schedule fires at, at or before the given one, is no later than the latest occurrence. -/
theorem previousSecond_greatest {cron : Cron} {instant found other : Int}
    (h : previousSecond cron instant = some found) (earlier : other ≤ instant) (fired : fires cron other = true) :
    other ≤ found := by
  refine Int.not_lt.mp (fun after => ?_)
  rw [(previousSecond_spec h).2.2 other after earlier] at fired
  cases fired

/-- **The searches are inverse.** The next occurrence after the latest one is after the instant asked at. -/
theorem next_after_previous {cron : Cron} {instant found following : Int}
    (h : previousSecond cron instant = some found) (hNext : nextSecond cron found = some following) :
    instant < following := by
  refine Int.not_le.mp (fun under => ?_)
  have := previousSecond_greatest h under (nextSecond_fires hNext)
  have := nextSecond_gt hNext
  omega

/-- A schedule that fires at an instant has that instant as its own latest occurrence. -/
theorem previousSecond_self {cron : Cron} {instant found : Int} (h : previousSecond cron instant = some found)
    (fired : fires cron instant = true) : found = instant :=
  Int.le_antisymm (previousSecond_le h) (previousSecond_greatest h (Int.le_refl _) fired)

/-! ## Milliseconds -/

/-- **Strict monotonicity, to the millisecond.** The next occurrence is strictly after the instant asked from. -/
theorem next_gt {cron : Cron} {millis found : Int} (h : next cron millis = some found) : millis < found := by
  unfold next at h
  cases found' : nextSecond cron (millis / 1000) with
  | none => simp [found'] at h
  | some second =>
    simp [found'] at h
    have := nextSecond_gt found'
    omega

/-- **Match soundness, to the millisecond.** The schedule fires at the next occurrence. -/
theorem next_fires {cron : Cron} {millis found : Int} (h : next cron millis = some found) :
    firesAt cron found = true := by
  unfold next at h
  cases found' : nextSecond cron (millis / 1000) with
  | none => simp [found'] at h
  | some second =>
    simp [found'] at h
    subst h
    have whole : second * 1000 / 1000 = second := by omega
    simpa [firesAt, whole] using nextSecond_fires found'

/-- The next occurrence is a whole second. -/
theorem next_whole {cron : Cron} {millis found : Int} (h : next cron millis = some found) : found % 1000 = 0 := by
  unfold next at h
  cases found' : nextSecond cron (millis / 1000) with
  | none => simp [found'] at h
  | some second =>
    simp [found'] at h
    omega

/-- **Minimality, to the millisecond.** No instant between the one asked from and the next occurrence fires at the
start of its second. -/
theorem next_least {cron : Cron} {millis found other : Int} (h : next cron millis = some found)
    (later : millis < other) (whole : other % 1000 = 0) (fired : firesAt cron other = true) : found ≤ other := by
  unfold next at h
  cases found' : nextSecond cron (millis / 1000) with
  | none => simp [found'] at h
  | some second =>
    simp [found'] at h
    have := nextSecond_least found' (other := other / 1000) (by omega) fired
    omega

/-- The latest occurrence is at or before the instant asked at, and the schedule fires at it. -/
theorem previous_le_and_fires {cron : Cron} {millis found : Int} (h : previous cron millis = some found) :
    found ≤ millis ∧ firesAt cron found = true := by
  unfold previous at h
  cases found' : previousSecond cron (millis / 1000) with
  | none => simp [found'] at h
  | some second =>
    simp [found'] at h
    subst h
    have := previousSecond_le found'
    have whole : second * 1000 / 1000 = second := by omega
    exact ⟨by omega, by simpa [firesAt, whole] using previousSecond_fires found'⟩

/-! ## The occurrences of an interval -/

/-- Every listed occurrence is after the cursor, at or before the end, and an instant the schedule fires at. -/
theorem between_mem {cron : Cron} {to : Int} : ∀ (limit : Nat) (cursor : Int) {occurrence : Int},
    occurrence ∈ between cron to limit cursor → cursor < occurrence ∧ occurrence ≤ to ∧ firesAt cron occurrence = true
  | 0, _, _, h => by simp [between] at h
  | limit + 1, cursor, occurrence, h => by
    unfold between at h
    cases found : next cron cursor with
    | none => simp [found] at h
    | some first =>
      simp only [found] at h
      by_cases inside : first ≤ to
      · rw [if_pos inside] at h
        cases List.mem_cons.mp h with
        | inl same => exact same ▸ ⟨next_gt found, inside, next_fires found⟩
        | inr rest =>
          have ⟨after, under, fired⟩ := between_mem limit first rest
          exact ⟨Int.lt_trans (next_gt found) after, under, fired⟩
      · rw [if_neg inside] at h
        cases h

/-- **The occurrences of an interval are strictly increasing**, so none is listed twice. -/
theorem between_increasing {cron : Cron} {to : Int} : ∀ (limit : Nat) (cursor : Int),
    (between cron to limit cursor).Pairwise (· < ·)
  | 0, _ => by simp [between]
  | limit + 1, cursor => by
    unfold between
    cases found : next cron cursor with
    | none => simp
    | some first =>
      by_cases inside : first ≤ to
      · simp only [if_pos inside]
        exact List.pairwise_cons.mpr
          ⟨fun later member => (between_mem limit first member).1, between_increasing limit first⟩
      · simp [if_neg inside]

/-- The list holds no more occurrences than its limit. -/
theorem between_length {cron : Cron} {to : Int} : ∀ (limit : Nat) (cursor : Int),
    (between cron to limit cursor).length ≤ limit
  | 0, _ => by simp [between]
  | limit + 1, cursor => by
    unfold between
    cases found : next cron cursor with
    | none => simp
    | some first =>
      by_cases inside : first ≤ to
      · simp only [if_pos inside, List.length_cons]
        exact Nat.succ_le_succ (between_length limit first)
      · simp [if_neg inside]

/-! ## The calendar and the fields -/

/-- A weekday is 0 to 6, for every day before or after the epoch. -/
theorem civil_weekday_lt (epochDay : Int) : (civil epochDay).weekday < 7 := by
  unfold civil
  dsimp only
  omega

/-- A day of a year of at most 366 days falls in a month from 1 to 12, on a day of it from 1 to 31. -/
theorem month_and_day_bounds (day : Nat) (inYear : day ≤ 365) :
    1 ≤ monthOf day ∧ monthOf day ≤ 12 ∧ 1 ≤ dayOfMonth day ∧ dayOfMonth day ≤ 31 := by
  unfold monthOf dayOfMonth
  dsimp only
  split <;> omega

/-- A week later is the same weekday. -/
theorem civil_weekday_week (epochDay : Int) : (civil (epochDay + 7)).weekday = (civil epochDay).weekday := by
  unfold civil
  dsimp only
  omega

/-- Every value of a stepped run lies between its ends. -/
theorem stepped_bounds {low high stride value : Nat} (h : value ∈ stepped low high stride) :
    low ≤ value ∧ value ≤ high := by
  simp only [stepped, List.mem_map, List.mem_filter, List.mem_range] at h
  obtain ⟨offset, ⟨below, _⟩, rfl⟩ := h
  omega

/-- A parsed field holds only values the field allows, in increasing order with no repeats. -/
theorem ordered_bounds {field : Field} {values : List Nat} {value : Nat} (h : value ∈ ordered field values) :
    value ≤ field.max ∧ value ∈ values := by
  simp only [ordered, List.mem_filter, List.mem_range, List.contains_iff_mem] at h
  exact ⟨by omega, h.2⟩

theorem ordered_increasing (field : Field) (values : List Nat) : (ordered field values).Pairwise (· < ·) :=
  List.Pairwise.filter _ List.pairwise_lt_range

end CronSpec

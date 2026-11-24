/-
What the reference specifications guarantee, proved for every input. Nothing here is assumed: every proof is
complete, and rests on nothing beyond what Lean's own library does.
-/
import ReportReplaySpec.Format
import ReportReplaySpec.Html
import ReportReplaySpec.Redact
import ReportReplaySpec.GitEscape
import ReportReplaySpec.ProcessTree
import ReportReplaySpec.BoxSift

namespace ReportReplaySpec

/-! ## Lists -/

theorem takeWhile_all {p : Nat → Bool} : ∀ (l : Str), (∀ c ∈ l, p c = true) → l.takeWhile p = l
  | [], _ => rfl
  | a :: l, h => by
    have ha := h a List.mem_cons_self
    simp only [List.takeWhile_cons, ha, if_true]
    rw [takeWhile_all l fun c hc => h c (List.mem_cons_of_mem _ hc)]

theorem dropWhile_all {p : Nat → Bool} : ∀ (l : Str), (∀ c ∈ l, p c = true) → l.dropWhile p = []
  | [], _ => rfl
  | a :: l, h => by
    have ha := h a List.mem_cons_self
    simp only [List.dropWhile_cons, ha, if_true]
    exact dropWhile_all l fun c hc => h c (List.mem_cons_of_mem _ hc)

theorem takeWhile_append_stop {p : Nat → Bool} : ∀ (l : Str) (x : Nat) (rest : Str),
    (∀ c ∈ l, p c = true) → p x = false → (l ++ x :: rest).takeWhile p = l
  | [], x, rest, _, hx => by simp [hx]
  | a :: l, x, rest, h, hx => by
    have ha := h a List.mem_cons_self
    simp only [List.cons_append, List.takeWhile_cons, ha, if_true]
    rw [takeWhile_append_stop l x rest (fun c hc => h c (List.mem_cons_of_mem _ hc)) hx]

theorem dropWhile_append_stop {p : Nat → Bool} : ∀ (l : Str) (x : Nat) (rest : Str),
    (∀ c ∈ l, p c = true) → p x = false → (l ++ x :: rest).dropWhile p = x :: rest
  | [], x, rest, _, hx => by simp [hx]
  | a :: l, x, rest, h, hx => by
    have ha := h a List.mem_cons_self
    simp only [List.cons_append, List.dropWhile_cons, ha, if_true]
    exact dropWhile_append_stop l x rest (fun c hc => h c (List.mem_cons_of_mem _ hc)) hx

/-- A run that passes, before a text that is empty or starts with a unit that does not: the run is what is taken. -/
theorem takeWhile_append_boundary {p : Nat → Bool} (l rest : Str) (hl : ∀ c ∈ l, p c = true)
    (hrest : ∀ c ∈ rest.head?, p c = false) : (l ++ rest).takeWhile p = l := by
  cases rest with
  | nil => simpa using takeWhile_all l hl
  | cons x rest => exact takeWhile_append_stop l x rest hl (hrest x (by simp))

theorem dropWhile_append_boundary {p : Nat → Bool} (l rest : Str) (hl : ∀ c ∈ l, p c = true)
    (hrest : ∀ c ∈ rest.head?, p c = false) : (l ++ rest).dropWhile p = rest := by
  cases rest with
  | nil => simpa using dropWhile_all l hl
  | cons x rest => exact dropWhile_append_stop l x rest hl (hrest x (by simp))

theorem mem_takeWhile {p : Nat → Bool} {c : Nat} : ∀ {l : Str}, c ∈ l.takeWhile p → p c = true
  | [], h => by simp at h
  | a :: l, h => by
    by_cases ha : p a = true
    · simp only [List.takeWhile_cons, ha, if_true, List.mem_cons] at h
      rcases h with rfl | h
      · exact ha
      · exact mem_takeWhile h
    · simp [ha] at h

theorem head?_dropWhile {p : Nat → Bool} (l : Str) : ∀ c ∈ (l.dropWhile p).head?, p c = false := by
  intro c hc
  have := List.head?_dropWhile_not p l
  cases h : (l.dropWhile p).head? with
  | none => rw [h] at hc; cases hc
  | some x =>
    rw [h] at hc this
    cases hc
    exact this

theorem prefix_drop : ∀ (pre text : Str), pre.isPrefixOf text = true → text = pre ++ text.drop pre.length
  | [], _, _ => by simp
  | _ :: _, [], h => by simp [List.isPrefixOf] at h
  | a :: pre, b :: text, h => by
    simp only [List.isPrefixOf, Bool.and_eq_true, beq_iff_eq] at h
    obtain ⟨rfl, h⟩ := h
    simp only [List.length_cons, List.drop_succ_cons, List.cons_append, List.cons.injEq, true_and]
    exact prefix_drop pre text h

/-! ## `Html.escape`: a repository's text is never markup -/

theorem escape_append (a b : Str) : escape (a ++ b) = escape a ++ escape b := by simp [escape]

theorem wellEscaped_escapeUnit_append (c : Nat) (rest : Str) (h : wellEscaped rest = true) :
    wellEscaped (escapeUnit c ++ rest) = true := by
  unfold escapeUnit
  repeat' split
  all_goals simp_all [wellEscaped, startsEntity, entityTails, isMarkup, List.isPrefixOf]

/-- Escaped text passes the check a reader of HTML makes. -/
theorem wellEscaped_escape (s : Str) : wellEscaped (escape s) = true := by
  induction s with
  | nil => rfl
  | cons c rest ih =>
    simp only [escape, List.flatMap_cons] at ih ⊢
    exact wellEscaped_escapeUnit_append c _ ih

theorem wellEscaped_no_markup (s : Str) (h : wellEscaped s = true) : ∀ c ∈ s, isMarkup c = false := by
  induction s with
  | nil => intro c hc; cases hc
  | cons a rest ih =>
    intro c hc
    simp only [wellEscaped, Bool.and_eq_true] at h
    rcases List.mem_cons.mp hc with rfl | hc
    · by_cases h38 : c = 38
      · subst h38; decide
      · simpa [h38] using h.1
    · exact ih h.2 c hc

theorem wellEscaped_amp (s : Str) (h : wellEscaped s = true) (pre post : Str) (eq : s = pre ++ 38 :: post) :
    startsEntity post = true := by
  induction s generalizing pre with
  | nil => cases pre <;> simp at eq
  | cons a rest ih =>
    simp only [wellEscaped, Bool.and_eq_true] at h
    cases pre with
    | nil =>
      simp only [List.nil_append, List.cons.injEq] at eq
      obtain ⟨rfl, rfl⟩ := eq
      simpa using h.1
    | cons b pre =>
      simp only [List.cons_append, List.cons.injEq] at eq
      exact ih h.2 pre eq.2

/-- **No unescaped `<`, `>`, `"` or `'`.** Whatever the text, none of the four is in what `escape` gives. -/
theorem escape_no_markup (s : Str) : ∀ c ∈ escape s, c ≠ 60 ∧ c ≠ 62 ∧ c ≠ 34 ∧ c ≠ 39 := by
  intro c hc
  have := wellEscaped_no_markup _ (wellEscaped_escape s) c hc
  simp [isMarkup] at this
  omega

/-- **Every `&` starts a valid entity.** What follows an `&` of escaped text is `amp;`, `lt;`, `gt;`, `quot;` or `#39;`. -/
theorem escape_amp_starts_entity (s pre post : Str) (h : escape s = pre ++ 38 :: post) :
    ∃ tail ∈ entityTails, tail <+: post := by
  have := wellEscaped_amp _ (wellEscaped_escape s) pre post h
  simp only [startsEntity, List.any_eq_true] at this
  obtain ⟨tail, member, isPrefix⟩ := this
  exact ⟨tail, member, List.isPrefixOf_iff_prefix.mp isPrefix⟩

/-! ## `Text.clean`: a repository's text never moves a terminal's cursor -/

/-- No control character is in cleaned text. -/
theorem clean_no_control (s : Str) : ∀ c ∈ clean s, isControl c = false := by
  intro c hc
  simp only [clean, List.mem_map] at hc
  obtain ⟨x, _, rfl⟩ := hc
  by_cases h : isControl x = true
  · rw [if_pos h]; decide
  · rw [if_neg h]; simpa using h

/-- Cleaning keeps the length, so a table's columns stay where they were. -/
theorem clean_length (s : Str) : (clean s).length = s.length := by simp [clean]

/-- Cleaning clean text changes nothing. -/
theorem clean_idempotent (s : Str) : clean (clean s) = clean s := by
  have fixed : ∀ l : Str, (∀ c ∈ l, isControl c = false) → clean l = l := by
    intro l
    induction l with
    | nil => intro _; rfl
    | cons a l ih =>
      intro h
      have ha := h a List.mem_cons_self
      have hl := ih fun c hc => h c (List.mem_cons_of_mem _ hc)
      simp only [clean, List.map_cons, ha] at hl ⊢
      simp [hl]
  exact fixed _ (clean_no_control s)

/-! ## `Format.speedupCommits`: no speedup beside a wrong result -/

/-- **Speedup honesty.** A report with a mismatch of normal mode that nothing explains covers no commit, whatever it declares. -/
theorem speedupCommits_zero_of_unattributed (report : Report)
    (h : ∃ commit ∈ report.commits, ∃ m ∈ commit.mismatches, m.mode = .normal ∧ m.cause = none) :
    speedupCommits report = 0 := by
  obtain ⟨commit, hc, m, hm, hmode, hcause⟩ := h
  have differs : normalDiffers report = true := by
    simp only [normalDiffers, List.any_eq_true]
    exact ⟨commit, hc, m, hm, by simp [Mismatch.unattributed, hmode, hcause]⟩
  simp [speedupCommits, differs]

/-- `normalDiffers` is exactly that: a mismatch of normal mode with no cause, at some commit. -/
theorem normalDiffers_iff (report : Report) :
    normalDiffers report = true ↔
      ∃ commit ∈ report.commits, ∃ m ∈ commit.mismatches, m.mode = .normal ∧ m.cause = none := by
  simp [normalDiffers, Mismatch.unattributed, Option.isNone_iff_eq_none]

/-- A report that shows a speedup over some commit has every mismatch of normal mode explained. -/
theorem speedupCommits_pos_explained (report : Report) (h : 0 < speedupCommits report) :
    ∀ commit ∈ report.commits, ∀ m ∈ commit.mismatches, m.mode = .normal → m.cause ≠ none := by
  intro commit hc m hm hmode hcause
  have := speedupCommits_zero_of_unattributed report ⟨commit, hc, m, hm, hmode, hcause⟩
  omega

/-- Where normal mode agrees, the report's own count stands, and every commit when it gives none. -/
theorem speedupCommits_of_agreeing (report : Report) (h : normalDiffers report = false) :
    speedupCommits report = report.declared.getD report.commits.length := by
  simp [speedupCommits, h]

/-! ## `Summary.withoutCredentials`: no user name or password stays in a remote -/

theorem afterLastAt_append (userinfo host : Str) (hhost : ∀ c ∈ host, c ≠ 64) :
    afterLastAt (userinfo ++ 64 :: host) = host := by
  unfold afterLastAt
  have : (userinfo ++ 64 :: host).reverse = host.reverse ++ 64 :: userinfo.reverse := by simp
  rw [this, takeWhile_append_stop host.reverse 64 _ (fun c hc => by simpa using hhost c (by simpa using hc))
    (by decide), List.reverse_reverse]

theorem afterLastAt_no_at (s : Str) : 64 ∉ afterLastAt s := by
  intro h
  have := mem_takeWhile (List.mem_reverse.mp h)
  simp at this

theorem mem_afterLastAt {s : Str} {c : Nat} (h : c ∈ afterLastAt s) : c ∈ s :=
  List.mem_reverse.mp ((List.takeWhile_sublist _).subset (List.mem_reverse.mp h))

theorem splitScheme_url (first : Nat) (scheme after : Str) (hfirst : isLetter first = true)
    (hscheme : ∀ c ∈ scheme, isSchemeUnit c = true) :
    splitScheme (first :: (scheme ++ 58 :: 47 :: 47 :: after)) = some (first :: scheme ++ u!"://", after) := by
  simp only [splitScheme, hfirst, if_true]
  rw [dropWhile_append_stop scheme 58 _ hscheme (by decide), takeWhile_append_stop scheme 58 _ hscheme (by decide)]
  rfl

theorem splitScheme_some {url scheme after : Str} (h : splitScheme url = some (scheme, after)) :
    ∃ first name, isLetter first = true ∧ (∀ c ∈ name, isSchemeUnit c = true) ∧
      scheme = first :: name ++ u!"://" ∧ url = first :: (name ++ 58 :: 47 :: 47 :: after) := by
  cases url with
  | nil => simp [splitScheme] at h
  | cons first rest =>
    by_cases hfirst : isLetter first = true
    · simp only [splitScheme, hfirst, if_true] at h
      split at h
      · rename_i after' heq
        simp only [Option.some.injEq, Prod.mk.injEq] at h
        obtain ⟨rfl, rfl⟩ := h
        refine ⟨first, rest.takeWhile isSchemeUnit, hfirst, fun c hc => mem_takeWhile hc, rfl, ?_⟩
        rw [← heq, List.takeWhile_append_dropWhile]
      · cases h
    · simp [splitScheme, hfirst] at h

/--
**A password may hold an `@`.** Of a URL with a user name and password before its host, only the scheme and
what follows the last `@` of the authority stay, whatever the user name and password hold: an `@`, a `:`.
-/
theorem scrub_strips_userinfo (first : Nat) (scheme userinfo host rest : Str)
    (hfirst : isLetter first = true) (hscheme : ∀ c ∈ scheme, isSchemeUnit c = true)
    (huser : ∀ c ∈ userinfo, isAuthorityUnit c = true)
    (hhost : ∀ c ∈ host, isAuthorityUnit c = true ∧ c ≠ 64)
    (hrest : ∀ c ∈ rest.head?, isAuthorityUnit c = false) :
    scrub (first :: scheme ++ u!"://" ++ userinfo ++ u!"@" ++ host ++ rest) =
      first :: scheme ++ u!"://" ++ host ++ rest := by
  have shape : first :: scheme ++ u!"://" ++ userinfo ++ u!"@" ++ host ++ rest =
      first :: (scheme ++ 58 :: 47 :: 47 :: ((userinfo ++ 64 :: host) ++ rest)) := by simp
  have authority : ∀ c ∈ userinfo ++ 64 :: host, isAuthorityUnit c = true := by
    intro c hc
    rcases List.mem_append.mp hc with hc | hc
    · exact huser c hc
    · rcases List.mem_cons.mp hc with rfl | hc
      · decide
      · exact (hhost c hc).1
  rw [shape]
  simp only [scrub, splitScheme_url first scheme _ hfirst hscheme, authorityOf,
    takeWhile_append_boundary _ rest authority hrest, dropWhile_append_boundary _ rest authority hrest,
    afterLastAt_append userinfo host fun c hc => (hhost c hc).2]
  simp

/-- The same for `user:pass@host` where the password is `first@second`: both halves go. -/
theorem scrub_strips_password_with_at (first : Nat) (scheme user pass₁ pass₂ host rest : Str)
    (hfirst : isLetter first = true) (hscheme : ∀ c ∈ scheme, isSchemeUnit c = true)
    (huser : ∀ c ∈ user ++ pass₁ ++ pass₂, isAuthorityUnit c = true)
    (hhost : ∀ c ∈ host, isAuthorityUnit c = true ∧ c ≠ 64)
    (hrest : ∀ c ∈ rest.head?, isAuthorityUnit c = false) :
    scrub (first :: scheme ++ u!"://" ++ (user ++ u!":" ++ pass₁ ++ u!"@" ++ pass₂) ++ u!"@" ++ host ++ rest) =
      first :: scheme ++ u!"://" ++ host ++ rest := by
  apply scrub_strips_userinfo first scheme _ host rest hfirst hscheme _ hhost hrest
  intro c hc
  simp only [List.mem_append, List.mem_cons, List.not_mem_nil, or_false] at hc huser
  rcases hc with (((hc | rfl) | hc) | rfl) | hc
  · exact huser c (Or.inl (Or.inl hc))
  · decide
  · exact huser c (Or.inl (Or.inr hc))
  · decide
  · exact huser c (Or.inr hc)

/--
**No credential stays, for any text.** Whenever what `scrub` gives is a URL, its authority holds no `@`:
nothing is left before a host that a reader takes for a user name or a password.
-/
theorem scrub_authority_no_at (url scheme after : Str) (h : splitScheme (scrub url) = some (scheme, after)) :
    64 ∉ authorityOf after := by
  unfold scrub at h
  cases found : splitScheme url with
  | none =>
    rw [found] at h
    simp only at h
    rw [found] at h
    cases h
  | some pair =>
    obtain ⟨scheme', after'⟩ := pair
    rw [found] at h
    simp only at h
    by_cases hat : 64 ∈ authorityOf after'
    · rw [if_pos hat] at h
      obtain ⟨first, name, hfirst, hname, rfl, -⟩ := splitScheme_some found
      have shape : first :: name ++ u!"://" ++ afterLastAt (authorityOf after') ++
          after'.dropWhile isAuthorityUnit =
          first :: (name ++ 58 :: 47 :: 47 :: (afterLastAt (authorityOf after') ++
            after'.dropWhile isAuthorityUnit)) := by simp
      rw [shape, splitScheme_url first name _ hfirst hname] at h
      simp only [Option.some.injEq, Prod.mk.injEq] at h
      obtain ⟨-, rfl⟩ := h
      unfold authorityOf
      rw [takeWhile_append_boundary _ _ (fun c hc => mem_takeWhile (mem_afterLastAt hc)) (head?_dropWhile _)]
      exact afterLastAt_no_at _
    · rw [if_neg hat, found] at h
      simp only [Option.some.injEq, Prod.mk.injEq] at h
      obtain ⟨-, rfl⟩ := h
      exact hat

/-- `withoutCredentials` is `scrub` of the trimmed remote, so the same holds of it. -/
theorem withoutCredentials_authority_no_at (remote scheme after : Str)
    (h : splitScheme (withoutCredentials remote) = some (scheme, after)) : 64 ∉ authorityOf after :=
  scrub_authority_no_at _ scheme after h

/-- A remote already without credentials is not touched a second time. -/
theorem withoutCredentials_strips_userinfo (first : Nat) (scheme userinfo host rest : Str)
    (hfirst : isLetter first = true) (hscheme : ∀ c ∈ scheme, isSchemeUnit c = true)
    (huser : ∀ c ∈ userinfo, isAuthorityUnit c = true)
    (hhost : ∀ c ∈ host, isAuthorityUnit c = true ∧ c ≠ 64)
    (hrest : ∀ c ∈ rest.head?, isAuthorityUnit c = false)
    (trimmed : trim (first :: scheme ++ u!"://" ++ userinfo ++ u!"@" ++ host ++ rest) =
      first :: scheme ++ u!"://" ++ userinfo ++ u!"@" ++ host ++ rest) :
    withoutCredentials (first :: scheme ++ u!"://" ++ userinfo ++ u!"@" ++ host ++ rest) =
      first :: scheme ++ u!"://" ++ host ++ rest := by
  unfold withoutCredentials
  rw [trimmed]
  exact scrub_strips_userinfo first scheme userinfo host rest hfirst hscheme huser hhost hrest

/-! ## `Command.errorLine`: no user name or password in an error, whatever stands before the URL -/

/-- If an authority holds no `@`, `afterLastAt` returns it unchanged. -/
theorem afterLastAt_id_of_no_at (s : Str) (h : 64 ∉ s) : afterLastAt s = s := by
  unfold afterLastAt
  have hrev : ∀ x ∈ s.reverse, (x != 64) = true := by
    intro x hx
    simp only [bne_iff_ne, ne_eq]
    intro eq
    exact h (eq ▸ List.mem_reverse.mp hx)
  rw [takeWhile_all _ hrev, List.reverse_reverse]

/-- If a text holds no `@`, `credentialAt` returns the exact prefix it consumed. -/
theorem credentialAt_no_at_id (c : Nat) (rest stays rem : Str) (h : 64 ∉ c :: rest)
    (heq : credentialAt c rest = some (stays, rem)) : stays ++ rem = c :: rest := by
  unfold credentialAt at heq
  split at heq
  · split at heq
    · rename_i after hdrop
      have hword : 64 ∉ (after.dropWhile isLineAuthorityUnit).takeWhile (fun u => !isSpace u) := by
        intro mem
        have hafter := (List.dropWhile_sublist isLineAuthorityUnit).subset ((List.takeWhile_sublist _).subset mem)
        have hrest : 64 ∈ rest.dropWhile isSchemeUnit := hdrop ▸ (by simp [hafter])
        exact h (List.mem_cons_of_mem _ ((List.dropWhile_sublist isSchemeUnit).subset hrest))
      simp only [hword, false_and, if_false, Option.some.injEq, Prod.mk.injEq] at heq
      obtain ⟨rfl, rfl⟩ := heq
      have hsub : ∀ x ∈ after.takeWhile isLineAuthorityUnit, x ∈ c :: rest := by
        intro x hx
        have h1 : x ∈ after := (List.takeWhile_sublist isLineAuthorityUnit).subset hx
        have h2 : x ∈ 58 :: 47 :: 47 :: after := by simp [h1]
        have h3 : x ∈ rest.dropWhile isSchemeUnit := hdrop ▸ h2
        exact List.mem_cons_of_mem c ((List.dropWhile_sublist isSchemeUnit).subset h3)
      have hnoat : 64 ∉ after.takeWhile isLineAuthorityUnit := fun mem => h (hsub 64 mem)
      rw [afterLastAt_id_of_no_at _ hnoat]
      have hrest : rest.takeWhile isSchemeUnit ++ 58 :: 47 :: 47 :: after = rest := by
        rw [← hdrop, List.takeWhile_append_dropWhile]
      have hafter : after.takeWhile isLineAuthorityUnit ++ after.dropWhile isLineAuthorityUnit = after :=
        List.takeWhile_append_dropWhile
      calc (c :: rest.takeWhile isSchemeUnit ++ u!"://" ++ after.takeWhile isLineAuthorityUnit) ++
              after.dropWhile isLineAuthorityUnit
          = c :: (rest.takeWhile isSchemeUnit ++ (58 :: 47 :: 47 ::
              (after.takeWhile isLineAuthorityUnit ++ after.dropWhile isLineAuthorityUnit))) := by
            simp [List.append_assoc]
        _ = c :: (rest.takeWhile isSchemeUnit ++ 58 :: 47 :: 47 :: after) := by rw [hafter]
        _ = c :: rest := by rw [hrest]
    · cases heq
  · cases heq

/-- If a text holds no `@`, `scrubAll` leaves it unchanged. -/
theorem scrubAll_no_at : ∀ (fuel : Nat) (s : Str), 64 ∉ s → scrubAll fuel s = s
  | 0, [], _ => rfl
  | _ + 1, [], _ => rfl
  | 0, _ :: _, _ => rfl
  | fuel + 1, c :: rest, h => by
    unfold scrubAll
    cases hcred : credentialAt c rest with
    | none =>
      simp [scrubAll_no_at fuel rest (fun m => h (List.mem_cons_of_mem c m))]
    | some pair =>
      obtain ⟨stays, rem⟩ := pair
      have hid := credentialAt_no_at_id c rest stays rem h hcred
      have hrem : 64 ∉ rem := fun m => h (hid ▸ List.mem_append_right stays m)
      simp [scrubAll_no_at fuel rem hrem, hid]

/-- A URL with a user name before its host matches where its scheme starts: the scheme and `://` stay. -/
theorem credentialAt_url (c : Nat) (scheme userinfo tail : Str) (hc : isLetter c = true)
    (hscheme : ∀ x ∈ scheme, isSchemeUnit x = true) (hshort : scheme.length ≤ schemeTail)
    (huser : ∀ x ∈ userinfo, isLineAuthorityUnit x = true) (htail : 64 ∉ tail) :
    credentialAt c (scheme ++ 58 :: 47 :: 47 :: (userinfo ++ 64 :: tail)) =
      some (c :: scheme ++ u!"://" ++ tail.takeWhile isLineAuthorityUnit, tail.dropWhile isLineAuthorityUnit) := by
  have run : (userinfo ++ 64 :: tail).takeWhile isLineAuthorityUnit =
      userinfo ++ 64 :: tail.takeWhile isLineAuthorityUnit ∧
      (userinfo ++ 64 :: tail).dropWhile isLineAuthorityUnit = tail.dropWhile isLineAuthorityUnit := by
    have split : userinfo ++ 64 :: tail =
        (userinfo ++ 64 :: tail.takeWhile isLineAuthorityUnit) ++ tail.dropWhile isLineAuthorityUnit := by
      simp [List.takeWhile_append_dropWhile]
    have passes : ∀ x ∈ userinfo ++ 64 :: tail.takeWhile isLineAuthorityUnit, isLineAuthorityUnit x = true := by
      intro x hx
      simp only [List.mem_append, List.mem_cons] at hx
      rcases hx with hx | rfl | hx
      · exact huser x hx
      · decide
      · exact mem_takeWhile hx
    rw [split]
    exact ⟨takeWhile_append_boundary _ _ passes (head?_dropWhile _),
      dropWhile_append_boundary _ _ passes (head?_dropWhile _)⟩
  have last : afterLastAt (userinfo ++ 64 :: tail.takeWhile isLineAuthorityUnit) = tail.takeWhile isLineAuthorityUnit :=
    afterLastAt_append _ _ fun x hx hx64 =>
      htail (hx64 ▸ (List.takeWhile_sublist isLineAuthorityUnit).subset hx)
  unfold credentialAt
  rw [takeWhile_append_stop scheme 58 _ hscheme (by decide), dropWhile_append_stop scheme 58 _ hscheme (by decide),
    if_pos ⟨hc, hshort⟩]
  simp [run.1, run.2, last]

/-- A run where some code unit fails: the first that fails is where `dropWhile` stops. -/
theorem dropWhile_append_stops_in {p : Nat → Bool} : ∀ (l m : Str), (∃ x ∈ l, p x = false) →
    ∃ x ∈ l, ((l ++ m).dropWhile p).head? = some x
  | [], _, h => by obtain ⟨x, hx, _⟩ := h; cases hx
  | a :: l, m, h => by
    by_cases ha : p a = true
    · obtain ⟨x, hx, fails⟩ := h
      have inTail : x ∈ l := by
        rcases List.mem_cons.mp hx with rfl | hx
        · rw [ha] at fails; cases fails
        · exact hx
      obtain ⟨y, hy, stops⟩ := dropWhile_append_stops_in l m ⟨x, inTail, fails⟩
      exact ⟨y, List.mem_cons_of_mem _ hy, by simpa [ha] using stops⟩
    · exact ⟨a, List.mem_cons_self, by simp [ha]⟩

/--
**No user name or password stays, whatever stands before the URL.** A text that holds a URL with a user name
before its host, after anything that has no `:` (a word, a digit, the letter that ends a terminal's colour
sequence), loses all between `://` and the `@`.
-/
theorem scrubAll_strips_userinfo : ∀ (before : Str) (fuel : Nat) (first : Nat) (scheme userinfo tail : Str),
    before.length < fuel → 58 ∉ before → isLetter first = true → (∀ x ∈ scheme, isSchemeUnit x = true) →
    scheme.length ≤ schemeTail → (∀ x ∈ userinfo, isLineAuthorityUnit x = true) →
    64 ∉ tail →
    scrubAll fuel (before ++ first :: scheme ++ u!"://" ++ userinfo ++ u!"@" ++ tail) =
      before ++ first :: scheme ++ u!"://" ++ tail
  | [], fuel, first, scheme, userinfo, tail, hfuel, _, hfirst, hscheme, hshort, huser, htail => by
    obtain ⟨fuel, rfl⟩ : ∃ n, fuel = n + 1 := ⟨fuel - 1, by simp at hfuel; omega⟩
    have shape : [] ++ first :: scheme ++ u!"://" ++ userinfo ++ u!"@" ++ tail =
        first :: (scheme ++ 58 :: 47 :: 47 :: (userinfo ++ 64 :: tail)) := by simp
    have hdrop : 64 ∉ tail.dropWhile isLineAuthorityUnit := fun m =>
      htail ((List.dropWhile_sublist isLineAuthorityUnit).subset m)
    rw [shape]
    simp only [scrubAll, credentialAt_url first scheme userinfo tail hfirst hscheme hshort huser htail,
      scrubAll_no_at fuel _ hdrop, List.append_assoc, List.takeWhile_append_dropWhile]
    simp
  | c :: before, fuel, first, scheme, userinfo, tail, hfuel, hcolon, hfirst, hscheme, hshort, huser, htail => by
    obtain ⟨fuel, rfl⟩ : ∃ n, fuel = n + 1 := ⟨fuel - 1, by simp at hfuel; omega⟩
    have hcolon' : 58 ∉ before := fun member => hcolon (List.mem_cons_of_mem _ member)
    have later := scrubAll_strips_userinfo before fuel first scheme userinfo tail
      (by simp at hfuel; omega) hcolon' hfirst hscheme hshort huser htail
    have shape : c :: before ++ first :: scheme ++ u!"://" ++ userinfo ++ u!"@" ++ tail =
        c :: ((before ++ first :: scheme) ++ 58 :: 47 :: 47 :: (userinfo ++ 64 :: tail)) := by simp
    have shape' : before ++ first :: scheme ++ u!"://" ++ userinfo ++ u!"@" ++ tail =
        (before ++ first :: scheme) ++ 58 :: 47 :: 47 :: (userinfo ++ 64 :: tail) := by simp
    have hdrop : 64 ∉ tail.dropWhile isLineAuthorityUnit := fun m =>
      htail ((List.dropWhile_sublist isLineAuthorityUnit).subset m)
    rw [shape]
    rw [shape'] at later
    by_cases allScheme : ∀ x ∈ before ++ first :: scheme, isSchemeUnit x = true
    · by_cases guard : isLetter c = true ∧ (before ++ first :: scheme).length ≤ schemeTail
      · have hcred := credentialAt_url c (before ++ first :: scheme) userinfo tail guard.1 allScheme guard.2 huser htail
        simp only [scrubAll]
        rw [hcred]; dsimp only; rw [scrubAll_no_at fuel _ hdrop]
        simp [List.append_assoc, List.takeWhile_append_dropWhile]
      · have none : credentialAt c ((before ++ first :: scheme) ++ 58 :: 47 :: 47 :: (userinfo ++ 64 :: tail)) =
            none := by
          unfold credentialAt
          rw [takeWhile_append_stop _ 58 _ allScheme (by decide), if_neg guard]
        simp only [scrubAll, none, later]
        simp
    · have fails : ∃ x ∈ before, isSchemeUnit x = false := by
        apply Classical.byContradiction
        intro none
        apply allScheme
        intro x hx
        simp only [List.mem_append] at hx
        rcases hx with hx | hx
        · cases h : isSchemeUnit x with
          | true => rfl
          | false => exact absurd ⟨x, hx, h⟩ none
        · rcases List.mem_cons.mp hx with rfl | hx
          · simp [isSchemeUnit, hfirst]
          · exact hscheme x hx
      have none : credentialAt c ((before ++ first :: scheme) ++ 58 :: 47 :: 47 :: (userinfo ++ 64 :: tail)) =
          none := by
        obtain ⟨x, hx, stops⟩ := dropWhile_append_stops_in before
          (first :: scheme ++ 58 :: 47 :: 47 :: (userinfo ++ 64 :: tail)) fails
        have same : (before ++ first :: scheme) ++ 58 :: 47 :: 47 :: (userinfo ++ 64 :: tail) =
            before ++ (first :: scheme ++ 58 :: 47 :: 47 :: (userinfo ++ 64 :: tail)) := by simp
        unfold credentialAt
        split
        · split
          · rename_i after heq
            rw [← same, heq] at stops
            simp only [List.head?_cons, Option.some.injEq] at stops
            exact absurd (stops ▸ hx) hcolon'
          · rfl
        · rfl
      simp only [scrubAll, none, later]
      simp

/-! ## `Command.errorLine`: an error is one short line -/

/-- An error's line is at most 300 code units and a `…`. -/
theorem errorLine_length (cause : Str) : (errorLine cause).length ≤ longest + 1 := by
  unfold errorLine
  simp only
  split
  · simp only [List.length_append, List.length_take, List.length_cons, List.length_nil]
    omega
  · omega

/-! ## `Names.bytesOf`: git's quoted name gives the bytes back -/

theorem octalValue_digits (b : Nat) (h : b < 256) : octalValue [48 + b / 64, 48 + b / 8 % 8, 48 + b % 8] = b := by
  have h1 : isOctal (48 + b / 64) = true := by
    simp only [isOctal, Bool.and_eq_true, decide_eq_true_eq]; omega
  have h2 : isOctal (48 + b / 8 % 8) = true := by
    simp only [isOctal, Bool.and_eq_true, decide_eq_true_eq]; omega
  have h3 : isOctal (48 + b % 8) = true := by
    simp only [isOctal, Bool.and_eq_true, decide_eq_true_eq]; omega
  simp only [octalValue, List.takeWhile_cons, h1, h2, h3, if_true, List.takeWhile_nil, List.foldl_cons,
    List.foldl_nil]
  omega

theorem isOctal_high (b : Nat) (h : b < 256) : isOctal (48 + b / 64) = true := by
  simp only [isOctal, Bool.and_eq_true, decide_eq_true_eq]; omega

/-- One byte as git writes it, before more text, reads back as that byte. -/
theorem decodeQuoted_quoteByte (b : Nat) (h : b < 256) (t : Nat) (ts : Str) :
    decodeQuoted (quoteByte b ++ t :: ts) = b :: decodeQuoted (t :: ts) := by
  unfold quoteByte
  repeat' split
  all_goals first
    | (subst_vars; simp [decodeQuoted, isOctal, escapeByte]; done)
    | (simp [decodeQuoted, isOctal_high b h, octalValue_digits b h, Nat.mod_eq_of_lt h]; done)
    | (simp_all [decodeQuoted, Nat.mod_eq_of_lt h]; done)

theorem decodeQuoted_quoted : ∀ (bytes : List Nat), (∀ b ∈ bytes, b < 256) →
    decodeQuoted (bytes.flatMap quoteByte ++ [34]) = bytes
  | [], _ => by simp [decodeQuoted]
  | b :: bytes, h => by
    have rest := decodeQuoted_quoted bytes fun x hx => h x (List.mem_cons_of_mem _ hx)
    rw [List.flatMap_cons, List.append_assoc]
    cases tail : bytes.flatMap quoteByte ++ [34] with
    | nil => simp at tail
    | cons t ts =>
      rw [decodeQuoted_quoteByte b (h b List.mem_cons_self) t ts, ← tail, rest]

/-- **Round trip.** The name git prints in double quotes gives the file's bytes back exactly, whatever they are. -/
theorem bytesOf_gitQuote (bytes : List Nat) (h : ∀ b ∈ bytes, b < 256) : bytesOf (gitQuote bytes) = bytes := by
  simp only [gitQuote, bytesOf]
  exact decodeQuoted_quoted bytes h

theorem escapeByte_lt (c : Nat) : escapeByte c < 256 := by
  unfold escapeByte
  repeat' split
  all_goals omega

/-- Whatever stands between the quotes, every value read is a byte. -/
theorem decodeQuoted_lt (s : Str) : ∀ b ∈ decodeQuoted s, b < 256 := by
  fun_induction decodeQuoted s
  all_goals
    intro b hb
    first
      | (cases hb; done)
      | (rename_i ih
         rcases List.mem_cons.mp hb with rfl | hb
         · first | exact Nat.mod_lt _ (by decide) | exact escapeByte_lt _
         · exact ih b hb)

/-! ## `ProcessTable.treeOf`: each process once, on any table -/

theorem dedup_nodup : ∀ (l : List Nat), (dedup l).Nodup
  | [] => by simp [dedup]
  | x :: l => by
    simp only [dedup, List.nodup_cons, List.mem_filter]
    exact ⟨by simp, List.Pairwise.filter _ (dedup_nodup l)⟩

theorem below_nodup (table : List ProcessEntry) (seen : List Nat) (next : Nat) : (below table seen next).Nodup :=
  List.Pairwise.filter _ (dedup_nodup _)

/-- What holds at every turn of the walk. -/
structure WalkInv (table : List ProcessEntry) (waiting seen : List Nat) (tree : ProcessTree) : Prop where
  waitingNodup : waiting.Nodup
  pidsNodup : tree.pids.Nodup
  waitingSeen : ∀ pid ∈ waiting, pid ∈ seen
  pidsSeen : ∀ pid ∈ tree.pids, pid ∈ seen
  apart : ∀ pid ∈ waiting, pid ∉ tree.pids
  waitingListed : ∀ pid ∈ waiting, ∃ entry ∈ table, entry.pid = pid
  pidsListed : ∀ pid ∈ tree.pids, ∃ entry ∈ table, entry.pid = pid
  leavesCounted : ∀ pid ∈ tree.leaves, pid ∈ tree.pids

theorem WalkInv.step {table : List ProcessEntry} {next : Nat} {rest seen : List Nat} {tree : ProcessTree}
    (inv : WalkInv table (next :: rest) seen tree) :
    WalkInv table ((below table seen next).reverse ++ rest) (below table seen next ++ seen)
      { cpuMs := tree.cpuMs + cpuOf table next
        pids := tree.pids ++ [next]
        leaves := if (below table seen next).isEmpty then tree.leaves ++ [next] else tree.leaves } := by
  have fresh : ∀ pid ∈ below table seen next, (∃ entry ∈ table, entry.pid = pid) ∧ pid ∉ seen :=
    fun pid h => mem_below h
  obtain ⟨nextNew, restNodup⟩ := List.nodup_cons.mp inv.waitingNodup
  have nextSeen := inv.waitingSeen next List.mem_cons_self
  refine { waitingNodup := ?_, pidsNodup := ?_, waitingSeen := ?_, pidsSeen := ?_, apart := ?_,
           waitingListed := ?_, pidsListed := ?_, leavesCounted := ?_ }
  · refine List.nodup_append.mpr ⟨?_, restNodup, ?_⟩
    · exact List.pairwise_reverse.mpr ((below_nodup table seen next).imp fun h => Ne.symm h)
    · intro a ha b hb heq
      subst heq
      exact (fresh a (List.mem_reverse.mp ha)).2 (inv.waitingSeen a (List.mem_cons_of_mem _ hb))
  · refine List.nodup_append.mpr ⟨inv.pidsNodup, by simp, ?_⟩
    intro a ha b hb heq
    rw [List.mem_singleton] at hb
    subst hb heq
    exact inv.apart a List.mem_cons_self ha
  · intro pid h
    rcases List.mem_append.mp h with h | h
    · exact List.mem_append_left _ (List.mem_reverse.mp h)
    · exact List.mem_append_right _ (inv.waitingSeen pid (List.mem_cons_of_mem _ h))
  · intro pid h
    rcases List.mem_append.mp h with h | h
    · exact List.mem_append_right _ (inv.pidsSeen pid h)
    · rw [List.mem_singleton] at h
      subst h
      exact List.mem_append_right _ nextSeen
  · intro pid waits counted
    rcases List.mem_append.mp waits with inBelow | inRest
    · have notSeen := (fresh pid (List.mem_reverse.mp inBelow)).2
      rcases List.mem_append.mp counted with before | isNext
      · exact notSeen (inv.pidsSeen pid before)
      · rw [List.mem_singleton.mp isNext] at notSeen
        exact notSeen nextSeen
    · rcases List.mem_append.mp counted with before | isNext
      · exact inv.apart pid (List.mem_cons_of_mem _ inRest) before
      · rw [List.mem_singleton.mp isNext] at inRest
        exact nextNew inRest
  · intro pid h
    rcases List.mem_append.mp h with h | h
    · exact (fresh pid (List.mem_reverse.mp h)).1
    · exact inv.waitingListed pid (List.mem_cons_of_mem _ h)
  · intro pid h
    rcases List.mem_append.mp h with h | h
    · exact inv.pidsListed pid h
    · rw [List.mem_singleton] at h
      subst h
      exact inv.waitingListed _ List.mem_cons_self
  · intro pid h
    show pid ∈ tree.pids ++ [next]
    dsimp only at h
    split at h
    · rcases List.mem_append.mp h with h | h
      · exact List.mem_append_left _ (inv.leavesCounted pid h)
      · exact List.mem_append_right _ h
    · exact List.mem_append_left _ (inv.leavesCounted pid h)

/-- What a tree is, whatever the table: each process once, each a process of the table, each leaf a process of the tree. -/
structure TreeSound (table : List ProcessEntry) (tree : ProcessTree) : Prop where
  pidsNodup : tree.pids.Nodup
  pidsListed : ∀ pid ∈ tree.pids, ∃ entry ∈ table, entry.pid = pid
  leavesCounted : ∀ pid ∈ tree.leaves, pid ∈ tree.pids

theorem walk_sound (table : List ProcessEntry) (waiting seen : List Nat) (tree : ProcessTree)
    (inv : WalkInv table waiting seen tree) : TreeSound table (walk table waiting seen tree) := by
  fun_induction walk table waiting seen tree
  · exact ⟨inv.pidsNodup, inv.pidsListed, inv.leavesCounted⟩
  · rename_i ih
    exact ih inv.step

theorem treeOf_sound (table : List ProcessEntry) (root : Nat) : TreeSound table (treeOf table root) := by
  simp only [treeOf]
  apply walk_sound
  by_cases h : (table.any fun entry => entry.pid == root) = true
  · have listed : ∃ entry ∈ table, entry.pid = root := by simpa [List.any_eq_true] using h
    rw [if_pos h]
    exact { waitingNodup := by simp, pidsNodup := by simp, waitingSeen := fun _ h => h, pidsSeen := by simp,
            apart := by simp, waitingListed := by simpa using listed, pidsListed := by simp,
            leavesCounted := by simp }
  · rw [if_neg h]
    exact { waitingNodup := by simp, pidsNodup := by simp, waitingSeen := by simp, pidsSeen := by simp,
            apart := by simp, waitingListed := by simp, pidsListed := by simp, leavesCounted := by simp }

/--
**No process twice.** On any table, one that names a process twice, gives it two parents or holds a parent
cycle, the tree has each process once. `treeOf` is defined for all of them: the walk it runs was shown to end
(`walk`, by `unseen_lt`), which Lean requires before it accepts the definition.
-/
theorem treeOf_pids_nodup (table : List ProcessEntry) (root : Nat) : (treeOf table root).pids.Nodup :=
  (treeOf_sound table root).pidsNodup

/-- Every process of the tree is a row of the table: the walk invents none. -/
theorem treeOf_pids_listed (table : List ProcessEntry) (root : Nat) :
    ∀ pid ∈ (treeOf table root).pids, ∃ entry ∈ table, entry.pid = pid :=
  (treeOf_sound table root).pidsListed

/-- Every leaf is a process of the tree. -/
theorem treeOf_leaves_counted (table : List ProcessEntry) (root : Nat) :
    ∀ pid ∈ (treeOf table root).leaves, pid ∈ (treeOf table root).pids :=
  (treeOf_sound table root).leavesCounted

/-- A process that is gone has an empty tree. -/
theorem treeOf_gone (table : List ProcessEntry) (root : Nat) (h : ∀ entry ∈ table, entry.pid ≠ root) :
    treeOf table root = { cpuMs := 0, pids := [], leaves := [] } := by
  have none : (table.any fun entry => entry.pid == root) = false := by
    simpa [List.any_eq_false] using h
  simp only [treeOf, none]
  rw [walk.eq_def]
  rfl

/-! ## `sift`: what is taken from an untrusted artifact -/

theorem stripPrefix_cases (pre text : Str) :
    stripPrefix pre text = text ∨ text = pre ++ stripPrefix pre text := by
  unfold stripPrefix
  split
  · rename_i h
    exact Or.inr (prefix_drop pre text h)
  · exact Or.inl rfl

/-- A path is one of the four spellings of the result it names. -/
theorem path_spelling (path : Str) : path ∈ spellings (nameOf path) := by
  have h1 := stripPrefix_cases u!"./" path
  have h2 := stripPrefix_cases u!"out/" (stripPrefix u!"./" path)
  simp only [nameOf, spellings, List.mem_cons, List.not_mem_nil, or_false]
  generalize stripPrefix u!"out/" (stripPrefix u!"./" path) = name at h2 ⊢
  generalize stripPrefix u!"./" path = inner at h1 h2
  rcases h1 with h1 | h1 <;> rcases h2 with h2 | h2 <;> subst_vars <;> simp

set_option maxRecDepth 8192 in
/-- None of the forty paths starts with `/` or holds `..`. -/
theorem takenPaths_safe : ∀ path ∈ takenPaths, path.head? ≠ some 47 ∧ dotDot path = false := by decide

/-- What a line that is listed is: a plain file's, named as a result, of a sane size. -/
theorem judge_listed {line path size : Str} {entry : SiftEntry} (h : judge line path size = .listed entry) :
    line.head? = some 45 ∧ nameOf path ∈ kept ∧ natOf size ≤ largest ∧
      entry = ⟨path, nameOf path, natOf size⟩ := by
  unfold judge at h
  split at h
  · cases h
  · split at h
    · cases h
    · split at h
      · cases h
      · split at h
        · cases h
        · rename_i plain named sized
          cases h
          exact ⟨Decidable.of_not_not plain, Decidable.of_not_not named, (Decidable.of_not_not sized).2, rfl⟩

theorem classify_listed {line : Str} {entry : SiftEntry} (h : classify line = .listed entry) :
    line.head? = some 45 ∧ entry.name ∈ kept ∧ entry.bytes ≤ largest ∧ entry.name = nameOf entry.path := by
  unfold classify at h
  obtain ⟨plain, named, sized, rfl⟩ := judge_listed h
  exact ⟨plain, named, sized, rfl⟩

theorem mem_listedOf {listing : Str} {entry : SiftEntry} (h : entry ∈ listedOf listing) :
    ∃ line ∈ linesOf listing, classify line = .listed entry := by
  simp only [listedOf, List.mem_filterMap, List.mem_map] at h
  obtain ⟨verdict, ⟨line, member, rfl⟩, isEntry⟩ := h
  refine ⟨line, member, ?_⟩
  cases found : classify line with
  | skip => rw [found] at isEntry; cases isEntry
  | drop dropped => rw [found] at isEntry; cases isEntry
  | listed other =>
    rw [found] at isEntry
    cases isEntry
    rfl

theorem mem_keep {listing : Str} {entry : SiftEntry} (h : entry ∈ (sift listing).keep) :
    entry ∈ listedOf listing ∧ once (listedOf listing) entry = true := by
  simpa [sift, List.mem_filter] using h

/--
**Only plain files.** Every member taken comes from a line of the listing that starts with `-`, and every
line that gives it does.
-/
theorem sift_keeps_only_plain_files (listing : Str) (entry : SiftEntry) (h : entry ∈ (sift listing).keep) :
    (∃ line ∈ linesOf listing, classify line = .listed entry) ∧
      ∀ line, classify line = .listed entry → line.head? = some 45 :=
  ⟨mem_listedOf (mem_keep h).1, fun _ found => (classify_listed found).1⟩

/-- A line that does not start with `-` is never listed, so never taken, whatever follows its first character. -/
theorem not_plain_never_listed (kind : Nat) (rest : Str) (h : kind ≠ 45) (entry : SiftEntry) :
    classify (kind :: rest) ≠ .listed entry := by
  intro found
  have := (classify_listed found).1
  simp only [List.head?_cons, Option.some.injEq] at this
  exact h this

/--
**No link, directory, FIFO or device.** A line of a symbolic link (`l`), a hard link (`h`), a directory (`d`),
a FIFO (`p`), a block or character device (`b`, `c`) or a socket (`s`) is never listed.
-/
theorem special_never_listed : ∀ kind ∈ u!"lhdpbcs", ∀ (rest : Str) (entry : SiftEntry),
    classify (kind :: rest) ≠ .listed entry := by
  intro kind member rest entry
  apply not_plain_never_listed
  intro isPlain
  subst isPlain
  simp at member

/-- **Only named results.** Every member taken has a name of `kept`. -/
theorem sift_keep_named (listing : Str) (entry : SiftEntry) (h : entry ∈ (sift listing).keep) :
    entry.name ∈ kept := by
  obtain ⟨line, -, found⟩ := mem_listedOf (mem_keep h).1
  exact (classify_listed found).2.1

/--
**No traversal, no absolute path.** The path of every member taken is one of the four spellings of its
result, so it does not start with `/` and holds no `..`.
-/
theorem sift_keep_no_traversal (listing : Str) (entry : SiftEntry) (h : entry ∈ (sift listing).keep) :
    entry.path ∈ spellings entry.name ∧ entry.path.head? ≠ some 47 ∧ dotDot entry.path = false := by
  obtain ⟨line, -, found⟩ := mem_listedOf (mem_keep h).1
  obtain ⟨-, named, -, isName⟩ := classify_listed found
  have spelled : entry.path ∈ spellings entry.name := by rw [isName]; exact path_spelling entry.path
  exact ⟨spelled, takenPaths_safe entry.path (List.mem_flatMap.mpr ⟨entry.name, named, spelled⟩)⟩

/-- **At most 1 GiB.** Every member taken has a size of at most `largest`, which is 2³⁰ bytes. -/
theorem sift_keep_bounded (listing : Str) (entry : SiftEntry) (h : entry ∈ (sift listing).keep) :
    entry.bytes ≤ 2 ^ 30 := by
  obtain ⟨line, -, found⟩ := mem_listedOf (mem_keep h).1
  exact (classify_listed found).2.2.1

theorem twice_not_once (listed : List SiftEntry) (a b : SiftEntry) (both : [a, b].Sublist listed)
    (same : a.name = b.name) : once listed a = false ∧ once listed b = false := by
  have count := (both.filter (·.name == b.name)).length_le
  simp only [List.filter_cons, same, beq_self_eq_true, if_true, List.filter_nil, List.length_cons,
    List.length_nil] at count
  simp only [once, same, beq_eq_false_iff_ne, ne_eq]
  omega

/-- **No result twice.** No two members taken have one name. -/
theorem sift_keep_names_nodup (listing : Str) : ((sift listing).keep.map (·.name)).Nodup := by
  rw [List.Nodup, List.pairwise_map, List.pairwise_iff_forall_sublist]
  intro a b both same
  have first : a ∈ (sift listing).keep := both.subset (by simp)
  have kept := (mem_keep first).2
  have listed : [a, b].Sublist (listedOf listing) := by
    refine both.trans ?_
    simp only [sift]
    exact List.filter_sublist
  rw [(twice_not_once _ a b listed same).1] at kept
  cases kept

/-- So no two members taken have one path either. -/
theorem sift_keep_paths_nodup (listing : Str) : ((sift listing).keep.map (·.path)).Nodup := by
  have names := sift_keep_names_nodup listing
  rw [List.Nodup, List.pairwise_map] at names ⊢
  have named : ∀ entry ∈ (sift listing).keep, entry.name = nameOf entry.path := by
    intro entry h
    obtain ⟨line, -, found⟩ := mem_listedOf (mem_keep h).1
    exact (classify_listed found).2.2.2
  rw [List.pairwise_iff_forall_sublist] at names ⊢
  intro a b both same
  refine names both ?_
  rw [named a (both.subset (by simp)), named b (both.subset (by simp)), same]

/--
**A result listed twice is dropped both times.** Two lines of a listing that are each a plain file's, of a
sane size, with one name: neither is taken, whichever comes first and whatever each holds.
-/
theorem sift_twice_never_kept (listing : Str) (a b : SiftEntry) (both : [a, b].Sublist (listedOf listing))
    (same : a.name = b.name) : a ∉ (sift listing).keep ∧ b ∉ (sift listing).keep := by
  obtain ⟨notA, notB⟩ := twice_not_once _ a b both same
  constructor
  · intro h; rw [(mem_keep h).2] at notA; cases notA
  · intro h; rw [(mem_keep h).2] at notB; cases notB

end ReportReplaySpec

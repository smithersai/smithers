"""Production postconditions selected for expensive negative cases; positive proofs still check every obligation."""
# Mutations whose claim is that a call stays inside its callee's domain. Only these may be rejected by a failed
# precondition at that call (mutation_results.py); every other mutation must fail its own function's contract.
# Dafny assumes a failed precondition afterwards, so such a mutant can fail nothing later: its fault is the call itself.
CALLEE_PRECONDITIONS = {
    'history-replay-capacity-gate': 'apply requires a history below capacity; replayEvent must not call it on a full one',
    'history-capacity-low': 'decide requires a nonnegative sequence; the capacity guard must not call it with one below zero',
    'history-capacity-high': 'decide requires a sequence below capacity; the capacity guard must not call it at capacity',
}
# Exact production clauses, not generated line numbers. Positive verification checks all clauses.
# Prefix mutations keep whole-function checking because an earlier checked assertion is the earliest failure.
# Exact production clauses, not generated line numbers. Positive verification checks all clauses.
# Prefix mutations keep whole-function checking because an earlier checked assertion is the earliest failure.
POSTCONDITIONS = {'apply-advance': '((res.seq_ == conversation.seq_) || (res.seq_ == (conversation.seq_ + 1)))',
 'apply-agent-name': '((event.seq_ == (conversation.seq_ + 1)) ==> event.ReplyStarted? ==> '
                     '(!conversation.agent.working?) ==> (event.id != "") ==> (forall i: int :: ((0 <= i) ==> (i '
                     '< |conversation.entries|) ==> (conversation.entries[i].id != event.id))) ==> '
                     '(event.inReplyTo != "") ==> (exists i: int :: ((((0 <= i) && (i < |conversation.entries|)) '
                     '&& conversation.entries[i].author.person?) && (conversation.entries[i].id == '
                     'event.inReplyTo))) ==> (forall i: int :: ((0 <= i) ==> (i < |conversation.entries|) ==> '
                     'conversation.entries[i].author.agent? ==> (conversation.entries[i].inReplyTo != '
                     'event.inReplyTo))) ==> (((|res.entries| == (|conversation.entries| + 1)) && '
                     '(res.entries[|conversation.entries|].name == AGENT_NAME)) && '
                     '(res.entries[|conversation.entries|].inReplyTo == event.inReplyTo)))',
 'apply-answer-once': '((forall i: int, j: int :: ((0 <= i) ==> (i < j) ==> (j < |conversation.entries|) ==> '
                      'conversation.entries[i].author.agent? ==> conversation.entries[j].author.agent? ==> '
                      '(conversation.entries[i].inReplyTo != "") ==> (conversation.entries[i].inReplyTo != '
                      'conversation.entries[j].inReplyTo))) ==> forall i: int, j: int :: ((0 <= i) ==> (i < j) '
                      '==> (j < |res.entries|) ==> res.entries[i].author.agent? ==> res.entries[j].author.agent? '
                      '==> (res.entries[i].inReplyTo != "") ==> (res.entries[i].inReplyTo != '
                      'res.entries[j].inReplyTo)))',
 'apply-bound': '((forall i: int :: ((0 <= i) ==> (i < |conversation.entries|) ==> (conversation.entries[i].seq_ '
                '<= conversation.seq_))) ==> forall i: int :: ((0 <= i) ==> (i < |res.entries|) ==> '
                '(res.entries[i].seq_ <= res.seq_)))',
 'apply-client-id': '((forall i: int, j: int :: ((0 <= i) ==> (i < j) ==> (j < |conversation.entries|) ==> '
                    'conversation.entries[i].author.person? ==> conversation.entries[j].author.person? ==> '
                    '(conversation.entries[i].clientId != "") ==> (conversation.entries[i].clientId != '
                    'conversation.entries[j].clientId))) ==> forall i: int, j: int :: ((0 <= i) ==> (i < j) ==> '
                    '(j < |res.entries|) ==> res.entries[i].author.person? ==> res.entries[j].author.person? ==> '
                    '(res.entries[i].clientId != "") ==> (res.entries[i].clientId != res.entries[j].clientId)))',
 'apply-delta-after-end': '((event.seq_ == (conversation.seq_ + 1)) ==> (((event.ReplyDelta? || '
                          'event.ReplyRestarted?) || event.ReplyFinished?) || event.ReplyFailed?) ==> '
                          '(((!conversation.agent.working?) || (conversation.replying != event.id)) || (event.id '
                          '== "")) ==> (((res.entries == conversation.entries) && (res.agent == '
                          'conversation.agent)) && (res.replying == conversation.replying)))',
 'apply-delta-text': '((event.seq_ == (conversation.seq_ + 1)) ==> event.ReplyDelta? ==> '
                     'conversation.agent.working? ==> (conversation.replying == event.id) ==> (event.id != "") '
                     '==> ((|res.entries| == |conversation.entries|) && forall i: int :: ((0 <= i) ==> (i < '
                     '|res.entries|) ==> (if (conversation.entries[i].id == event.id) then (res.entries[i].text '
                     '== (conversation.entries[i].text + event.text)) else (res.entries[i] == '
                     'conversation.entries[i])))))',
 'apply-empty-client': '((forall i: int :: ((0 <= i) ==> (i < |conversation.entries|) ==> '
                       'conversation.entries[i].author.person? ==> (conversation.entries[i].clientId != ""))) ==> '
                       'forall i: int :: ((0 <= i) ==> (i < |res.entries|) ==> res.entries[i].author.person? ==> '
                       '(res.entries[i].clientId != "")))',
 'apply-entry-id': '((forall i: int, j: int :: ((0 <= i) ==> (i < j) ==> (j < |conversation.entries|) ==> '
                   '(conversation.entries[i].id != conversation.entries[j].id))) ==> forall i: int, j: int :: ((0 '
                   '<= i) ==> (i < j) ==> (j < |res.entries|) ==> (res.entries[i].id != res.entries[j].id)))',
 'apply-failure-reason': '((event.seq_ == (conversation.seq_ + 1)) ==> event.ReplyFailed? ==> '
                         'conversation.agent.working? ==> (conversation.replying == event.id) ==> (event.id != '
                         '"") ==> (((res.agent.failed? && (res.replying == "")) && (|res.entries| == '
                         '|conversation.entries|)) && forall i: int :: ((0 <= i) ==> (i < |res.entries|) ==> '
                         '(conversation.entries[i].id == event.id) ==> (res.entries[i].done && '
                         '(res.entries[i].error == (if (event.reason == "") then "failed" else event.reason))))))',
 'apply-finish-text': '((event.seq_ == (conversation.seq_ + 1)) ==> event.ReplyFinished? ==> '
                      'conversation.agent.working? ==> (conversation.replying == event.id) ==> (event.id != "") '
                      '==> (((res.agent.idle? && (res.replying == "")) && (|res.entries| == '
                      '|conversation.entries|)) && forall i: int :: ((0 <= i) ==> (i < |res.entries|) ==> '
                      '((res.entries[i].text == conversation.entries[i].text) && ((conversation.entries[i].id == '
                      'event.id) ==> res.entries[i].done)))))',
 'apply-ignore': '((event.seq_ == (conversation.seq_ + 1)) ==> (res.seq_ == event.seq_))',
 'apply-one-open': '((forall i: int :: ((0 <= i) ==> (i < |conversation.entries|) ==> '
                   '!(conversation.entries[i].done) ==> ((conversation.agent.working? && '
                   '(conversation.entries[i].id == conversation.replying)) && '
                   'conversation.entries[i].author.agent?))) ==> forall i: int :: ((0 <= i) ==> (i < '
                   '|res.entries|) ==> !(res.entries[i].done) ==> ((res.agent.working? && (res.entries[i].id == '
                   'res.replying)) && res.entries[i].author.agent?)))',
 'apply-open-exists': '((conversation.agent.working? ==> exists i: int :: (((0 <= i) && (i < '
                      '|conversation.entries|)) && !(conversation.entries[i].done))) ==> res.agent.working? ==> '
                      'exists i: int :: (((0 <= i) && (i < |res.entries|)) && !(res.entries[i].done)))',
 'apply-open-owner': '((forall i: int :: ((0 <= i) ==> (i < |conversation.entries|) ==> '
                     '!(conversation.entries[i].done) ==> ((conversation.agent.working? && '
                     '(conversation.entries[i].id == conversation.replying)) && '
                     'conversation.entries[i].author.agent?))) ==> forall i: int :: ((0 <= i) ==> (i < '
                     '|res.entries|) ==> !(res.entries[i].done) ==> ((res.agent.working? && (res.entries[i].id == '
                     'res.replying)) && res.entries[i].author.agent?)))',
 'apply-order': '((forall i: int :: ((0 < i) ==> (i < |conversation.entries|) ==> (conversation.entries[(i - '
                '1)].seq_ < conversation.entries[i].seq_))) ==> (forall i: int :: ((0 <= i) ==> (i < '
                '|conversation.entries|) ==> (conversation.entries[i].seq_ <= conversation.seq_))) ==> forall i: '
                'int :: ((0 < i) ==> (i < |res.entries|) ==> (res.entries[(i - 1)].seq_ < res.entries[i].seq_)))',
 'apply-pane': '((event.seq_ == (conversation.seq_ + 1)) ==> event.PaneOpened? ==> conversation.agent.working? '
               '==> (conversation.replying == event.id) ==> (event.id != "") ==> (event.url != "") ==> '
               '(((res.pane == event.url) && (res.entries == conversation.entries)) && (res.agent == '
               'conversation.agent)))',
 'apply-pane-guard': '((res.pane != conversation.pane) ==> (((event.PaneOpened? && conversation.agent.working?) '
                     '&& (conversation.replying == event.id)) && (event.url != "")))',
 'apply-person-id': '((forall i: int :: ((0 <= i) ==> (i < |conversation.entries|) ==> '
                    'conversation.entries[i].author.person? ==> (conversation.entries[i].clientId != ""))) ==> '
                    'forall i: int :: ((0 <= i) ==> (i < |res.entries|) ==> res.entries[i].author.person? ==> '
                    '(res.entries[i].clientId != "")))',
 'apply-phase': '((conversation.agent.working? == (conversation.replying != "")) ==> (res.agent.working? == '
                '(res.replying != "")))',
 'apply-reply-correlation': '((event.seq_ == (conversation.seq_ + 1)) ==> event.ReplyStarted? ==> '
                            '(!conversation.agent.working?) ==> (event.id != "") ==> (forall i: int :: ((0 <= i) '
                            '==> (i < |conversation.entries|) ==> (conversation.entries[i].id != event.id))) ==> '
                            '(event.inReplyTo != "") ==> (exists i: int :: ((((0 <= i) && (i < '
                            '|conversation.entries|)) && conversation.entries[i].author.person?) && '
                            '(conversation.entries[i].id == event.inReplyTo))) ==> (forall i: int :: ((0 <= i) '
                            '==> (i < |conversation.entries|) ==> conversation.entries[i].author.agent? ==> '
                            '(conversation.entries[i].inReplyTo != event.inReplyTo))) ==> (((|res.entries| == '
                            '(|conversation.entries| + 1)) && (res.entries[|conversation.entries|].name == '
                            'AGENT_NAME)) && (res.entries[|conversation.entries|].inReplyTo == event.inReplyTo)))',
 'apply-restart-text': '((event.seq_ == (conversation.seq_ + 1)) ==> event.ReplyRestarted? ==> '
                       'conversation.agent.working? ==> (conversation.replying == event.id) ==> (event.id != "") '
                       '==> ((|res.entries| == |conversation.entries|) && forall i: int :: ((0 <= i) ==> (i < '
                       '|res.entries|) ==> (res.entries[i].id == event.id) ==> (res.entries[i].text == ""))))',
 'apply-tour-busy': '((forall i: int :: ((0 <= i) ==> (i < |conversation.entries|) ==> '
                    '!(conversation.entries[i].done) ==> ((conversation.agent.working? && '
                    '(conversation.entries[i].id == conversation.replying)) && '
                    'conversation.entries[i].author.agent?))) ==> forall i: int :: ((0 <= i) ==> (i < '
                    '|res.entries|) ==> !(res.entries[i].done) ==> ((res.agent.working? && (res.entries[i].id == '
                    'res.replying)) && res.entries[i].author.agent?)))',
 'apply-tour-end-guard': '((forall i: int :: ((0 <= i) ==> (i < |conversation.entries|) ==> '
                         '!(conversation.entries[i].done) ==> ((conversation.agent.working? && '
                         '(conversation.entries[i].id == conversation.replying)) && '
                         'conversation.entries[i].author.agent?))) ==> forall i: int :: ((0 <= i) ==> (i < '
                         '|res.entries|) ==> !(res.entries[i].done) ==> ((res.agent.working? && '
                         '(res.entries[i].id == res.replying)) && res.entries[i].author.agent?)))',
 'apply-tour-end-idle': '((conversation.agent.working? == (conversation.replying != "")) ==> (res.agent.working? '
                        '== (res.replying != "")))',
 'apply-tour-end-text': '((event.seq_ == (conversation.seq_ + 1)) ==> event.TourEnded? ==> '
                        'conversation.agent.working? ==> (conversation.replying == event.id) ==> (event.id != "") '
                        '==> (exists i: int :: (((((0 <= i) && (i < |conversation.entries|)) && '
                        '(conversation.entries[i].id == event.id)) && conversation.entries[i].author.agent?) && '
                        '(conversation.entries[i].inReplyTo == ""))) ==> (((res.agent.idle? && (res.replying == '
                        '"")) && (|res.entries| == |conversation.entries|)) && forall i: int :: ((0 <= i) ==> (i '
                        '< |res.entries|) ==> ((res.entries[i].text == conversation.entries[i].text) && '
                        '((res.entries[i].id == event.id) ==> res.entries[i].done)))))',
 'apply-tour-phase': '((conversation.agent.working? == (conversation.replying != "")) ==> (res.agent.working? == '
                     '(res.replying != "")))',
 'history-amend-empty-guard': '((event.seq_ == (history.seq_ + 1)) ==> event.Amended? ==> !((((event.task != "") '
                              '&& exists j: int :: ((((0 <= j) && (j < |history.commits|)) && '
                              '(history.commits[j].id == event.id)) && history.commits[j].state.landed?)) && '
                              'exists j: int :: (((((0 <= j) && (j < |history.commits|)) && '
                              '(history.commits[j].id == event.id)) && (history.commits[j].task == "")) && forall '
                              'k: int :: ((0 <= k) ==> (k < j) ==> (history.commits[k].id != event.id))))) ==> '
                              '((((res.commits == history.commits) && (res.epics == history.epics)) && (res.real_ '
                              '== history.real_)) && (res.main == history.main)))',
 'history-apply-next': '((event.seq_ == (history.seq_ + 1)) ==> (res.seq_ == event.seq_))',
 'history-apply-number': '((res.seq_ == history.seq_) || (res.seq_ == (history.seq_ + 1)))',
 'history-approval-frame': '((event.Approved? || event.Noted?) ==> forall i: int :: ((0 <= i) ==> (i < '
                           '|history.commits|) ==> ((res.commits[i].task == history.commits[i].task) && '
                           '(res.commits[i].lane == history.commits[i].lane))))',
 'history-approve-empty-guard': '((event.seq_ == (history.seq_ + 1)) ==> event.Approved? ==> !(((event.by_ != "") '
                                '&& exists j: int :: ((((0 <= j) && (j < |history.commits|)) && '
                                '(history.commits[j].id == event.id)) && history.commits[j].state.working?))) ==> '
                                '((((res.commits == history.commits) && (res.epics == history.epics)) && '
                                '(res.real_ == history.real_)) && (res.main == history.main)))',
 'history-commit-identity': '((forall i: int, j: int :: ((0 <= i) ==> (i < j) ==> (j < |history.commits|) ==> '
                            '(history.commits[i].id != history.commits[j].id))) ==> forall i: int, j: int :: ((0 '
                            '<= i) ==> (i < j) ==> (j < |res.commits|) ==> (res.commits[i].id != '
                            'res.commits[j].id)))',
 'history-epic-identity': '((forall i: int, j: int :: ((0 <= i) ==> (i < j) ==> (j < |history.epics|) ==> '
                          '(history.epics[i].id != history.epics[j].id))) ==> forall i: int, j: int :: ((0 <= i) '
                          '==> (i < j) ==> (j < |res.epics|) ==> (res.epics[i].id != res.epics[j].id)))',
 'history-epic-title-guard': '((event.seq_ == (history.seq_ + 1)) ==> event.EpicOpened? ==> !((((event.title != '
                             '"") && (event.id != "")) && !(exists j: int :: (((0 <= j) && (j < |history.epics|)) '
                             '&& (history.epics[j].id == event.id))))) ==> ((((res.commits == history.commits) && '
                             '(res.epics == history.epics)) && (res.real_ == history.real_)) && (res.main == '
                             'history.main)))',
 'history-fold-change': '((event.seq_ == (history.seq_ + 1)) ==> event.Folded? ==> (event.sha != "") ==> '
                        '(event.into != "") ==> !(exists j: int :: (((0 <= j) && (j < |history.real_|)) && '
                        '(history.real_[j].sha == event.sha))) ==> (exists j: int :: (((0 <= j) && (j < '
                        '|history.commits|)) && (history.commits[j].id == event.into))) ==> ((((((|res.real_| == '
                        '(|history.real_| + 1)) && (res.real_[|history.real_|].sha == event.sha)) && '
                        '(res.real_[|history.real_|].mythical == event.into)) && '
                        '(res.real_[|history.real_|].change == event.change)) && '
                        '(res.real_[|history.real_|].title == event.title)) && (res.main == event.sha)))',
 'history-fold-duplicate': '((forall i: int, j: int :: ((0 <= i) ==> (i < j) ==> (j < |history.real_|) ==> '
                           '(history.real_[i].sha != history.real_[j].sha))) ==> forall i: int, j: int :: ((0 <= '
                           'i) ==> (i < j) ==> (j < |res.real_|) ==> (res.real_[i].sha != res.real_[j].sha)))',
 'history-fold-landing': '((event.seq_ == (history.seq_ + 1)) ==> event.Folded? ==> (event.sha != "") ==> '
                         '(event.into != "") ==> !(exists j: int :: (((0 <= j) && (j < |history.real_|)) && '
                         '(history.real_[j].sha == event.sha))) ==> (exists j: int :: (((0 <= j) && (j < '
                         '|history.commits|)) && (history.commits[j].id == event.into))) ==> forall i: int :: ((0 '
                         '<= i) ==> (i < |history.commits|) ==> (if (history.commits[i].id == event.into) then '
                         '(((res.commits[i].state.landed? && (res.commits[i].task == "")) && (res.commits[i].lane '
                         '== "")) && (res.commits[i].notes == history.commits[i].notes)) else (res.commits[i] == '
                         'history.commits[i]))))',
 'history-fold-main': '((|res.real_| == (|history.real_| + 1)) ==> (((event.Folded? && '
                      '(res.real_[|history.real_|].sha == event.sha)) && (res.real_[|history.real_|].mythical == '
                      'event.into)) && (res.main == event.sha)))',
 'history-fold-target': '((forall i: int :: ((0 <= i) ==> (i < |history.real_|) ==> exists j: int :: (((0 <= j) '
                        '&& (j < |history.commits|)) && (history.commits[j].id == history.real_[i].mythical)))) '
                        '==> forall i: int :: ((0 <= i) ==> (i < |res.real_|) ==> exists j: int :: (((0 <= j) && '
                        '(j < |res.commits|)) && (res.commits[j].id == res.real_[i].mythical))))',
 'history-fold-title': '((event.seq_ == (history.seq_ + 1)) ==> event.Folded? ==> (event.sha != "") ==> '
                       '(event.into != "") ==> !(exists j: int :: (((0 <= j) && (j < |history.real_|)) && '
                       '(history.real_[j].sha == event.sha))) ==> (exists j: int :: (((0 <= j) && (j < '
                       '|history.commits|)) && (history.commits[j].id == event.into))) ==> ((((((|res.real_| == '
                       '(|history.real_| + 1)) && (res.real_[|history.real_|].sha == event.sha)) && '
                       '(res.real_[|history.real_|].mythical == event.into)) && '
                       '(res.real_[|history.real_|].change == event.change)) && (res.real_[|history.real_|].title '
                       '== event.title)) && (res.main == event.sha)))',
 'history-note-by-guard': '((event.seq_ == (history.seq_ + 1)) ==> event.Noted? ==> !((((event.text != "") && '
                          '(event.by_ != "")) && ((event.id == "") || exists j: int :: (((0 <= j) && (j < '
                          '|history.commits|)) && (history.commits[j].id == event.id))))) ==> ((((res.commits == '
                          'history.commits) && (res.epics == history.epics)) && (res.real_ == history.real_)) && '
                          '(res.main == history.main)))',
 'history-note-empty-guard': '((event.seq_ == (history.seq_ + 1)) ==> event.Noted? ==> !((((event.text != "") && '
                             '(event.by_ != "")) && ((event.id == "") || exists j: int :: (((0 <= j) && (j < '
                             '|history.commits|)) && (history.commits[j].id == event.id))))) ==> ((((res.commits '
                             '== history.commits) && (res.epics == history.epics)) && (res.real_ == '
                             'history.real_)) && (res.main == history.main)))',
 'history-plan-epic': '((forall i: int :: ((0 <= i) ==> (i < |history.commits|) ==> exists k: int :: (((0 <= k) '
                      '&& (k < |history.epics|)) && (history.epics[k].id == history.commits[i].epic)))) ==> '
                      'forall i: int :: ((0 <= i) ==> (i < |res.commits|) ==> exists k: int :: (((0 <= k) && (k < '
                      '|res.epics|)) && (res.epics[k].id == res.commits[i].epic))))',
 'history-plan-frame': '((forall i: int :: ((0 <= i) ==> (i < |history.commits|) ==> exists k: int :: (((0 <= k) '
                       '&& (k < |history.epics|)) && (history.epics[k].id == history.commits[i].epic)))) ==> '
                       'forall i: int :: ((0 <= i) ==> (i < |res.commits|) ==> exists k: int :: (((0 <= k) && (k '
                       '< |res.epics|)) && (res.epics[k].id == res.commits[i].epic))))',
 'history-plan-new-lane': '((event.seq_ == (history.seq_ + 1)) ==> event.Planned? ==> (event.title != "") ==> '
                          '(event.rank >= 0) ==> (event.epic != "") ==> (event.id != "") ==> !(exists j: int :: '
                          '(((0 <= j) && (j < |history.commits|)) && (history.commits[j].id == event.id))) ==> '
                          '(exists j: int :: (((0 <= j) && (j < |history.epics|)) && (history.epics[j].id == '
                          'event.epic))) ==> (((((((((|res.commits| == (|history.commits| + 1)) && '
                          '(res.commits[|history.commits|].id == event.id)) && '
                          '(res.commits[|history.commits|].epic == event.epic)) && '
                          '(res.commits[|history.commits|].rank == event.rank)) && '
                          '(res.commits[|history.commits|].title == event.title)) && '
                          'res.commits[|history.commits|].state.planned?) && (res.commits[|history.commits|].task '
                          '== event.task)) && (res.commits[|history.commits|].lane == "")) && '
                          '(|res.commits[|history.commits|].notes| == 0)))',
 'history-plan-new-rank': '((event.seq_ == (history.seq_ + 1)) ==> event.Planned? ==> (event.title != "") ==> '
                          '(event.rank >= 0) ==> (event.epic != "") ==> (event.id != "") ==> !(exists j: int :: '
                          '(((0 <= j) && (j < |history.commits|)) && (history.commits[j].id == event.id))) ==> '
                          '(exists j: int :: (((0 <= j) && (j < |history.epics|)) && (history.epics[j].id == '
                          'event.epic))) ==> (((((((((|res.commits| == (|history.commits| + 1)) && '
                          '(res.commits[|history.commits|].id == event.id)) && '
                          '(res.commits[|history.commits|].epic == event.epic)) && '
                          '(res.commits[|history.commits|].rank == event.rank)) && '
                          '(res.commits[|history.commits|].title == event.title)) && '
                          'res.commits[|history.commits|].state.planned?) && (res.commits[|history.commits|].task '
                          '== event.task)) && (res.commits[|history.commits|].lane == "")) && '
                          '(|res.commits[|history.commits|].notes| == 0)))',
 'history-plan-new-state': '((event.seq_ == (history.seq_ + 1)) ==> event.Planned? ==> (event.title != "") ==> '
                           '(event.rank >= 0) ==> (event.epic != "") ==> (event.id != "") ==> !(exists j: int :: '
                           '(((0 <= j) && (j < |history.commits|)) && (history.commits[j].id == event.id))) ==> '
                           '(exists k: int :: (((0 <= k) && (k < |history.epics|)) && (history.epics[k].id == '
                           'event.epic))) ==> (((|res.commits| == (|history.commits| + 1)) && '
                           '(res.commits[|history.commits|].id == event.id)) && '
                           'res.commits[|history.commits|].state.planned?))',
 'history-plan-new-task': '((event.seq_ == (history.seq_ + 1)) ==> event.Planned? ==> (event.title != "") ==> '
                          '(event.rank >= 0) ==> (event.epic != "") ==> (event.id != "") ==> !(exists j: int :: '
                          '(((0 <= j) && (j < |history.commits|)) && (history.commits[j].id == event.id))) ==> '
                          '(exists j: int :: (((0 <= j) && (j < |history.epics|)) && (history.epics[j].id == '
                          'event.epic))) ==> (((((((((|res.commits| == (|history.commits| + 1)) && '
                          '(res.commits[|history.commits|].id == event.id)) && '
                          '(res.commits[|history.commits|].epic == event.epic)) && '
                          '(res.commits[|history.commits|].rank == event.rank)) && '
                          '(res.commits[|history.commits|].title == event.title)) && '
                          'res.commits[|history.commits|].state.planned?) && (res.commits[|history.commits|].task '
                          '== event.task)) && (res.commits[|history.commits|].lane == "")) && '
                          '(|res.commits[|history.commits|].notes| == 0)))',
 'history-plan-new-title': '((event.seq_ == (history.seq_ + 1)) ==> event.Planned? ==> (event.title != "") ==> '
                           '(event.rank >= 0) ==> (event.epic != "") ==> (event.id != "") ==> !(exists j: int :: '
                           '(((0 <= j) && (j < |history.commits|)) && (history.commits[j].id == event.id))) ==> '
                           '(exists j: int :: (((0 <= j) && (j < |history.epics|)) && (history.epics[j].id == '
                           'event.epic))) ==> (((((((((|res.commits| == (|history.commits| + 1)) && '
                           '(res.commits[|history.commits|].id == event.id)) && '
                           '(res.commits[|history.commits|].epic == event.epic)) && '
                           '(res.commits[|history.commits|].rank == event.rank)) && '
                           '(res.commits[|history.commits|].title == event.title)) && '
                           'res.commits[|history.commits|].state.planned?) && '
                           '(res.commits[|history.commits|].task == event.task)) && '
                           '(res.commits[|history.commits|].lane == "")) && '
                           '(|res.commits[|history.commits|].notes| == 0)))',
 'history-plan-rank-guard': '((forall i: int :: ((0 <= i) ==> (i < |history.commits|) ==> '
                            '(history.commits[i].rank >= 0))) ==> forall i: int :: ((0 <= i) ==> (i < '
                            '|res.commits|) ==> (res.commits[i].rank >= 0)))',
 'history-plan-shift': '((forall i: int, j: int :: ((0 <= i) ==> (i < j) ==> (j < |history.commits|) ==> '
                       '(history.commits[i].epic == history.commits[j].epic) ==> (history.commits[i].rank != '
                       'history.commits[j].rank))) ==> forall i: int, j: int :: ((0 <= i) ==> (i < j) ==> (j < '
                       '|res.commits|) ==> (res.commits[i].epic == res.commits[j].epic) ==> (res.commits[i].rank '
                       '!= res.commits[j].rank)))',
 'history-plan-shift-boundary': '((forall i: int, j: int :: ((0 <= i) ==> (i < j) ==> (j < |history.commits|) ==> '
                                '(history.commits[i].epic == history.commits[j].epic) ==> '
                                '(history.commits[i].rank != history.commits[j].rank))) ==> forall i: int, j: int '
                                ':: ((0 <= i) ==> (i < j) ==> (j < |res.commits|) ==> (res.commits[i].epic == '
                                'res.commits[j].epic) ==> (res.commits[i].rank != res.commits[j].rank)))',
 'history-plan-shift-epic': '((event.seq_ == (history.seq_ + 1)) ==> event.Planned? ==> (event.title != "") ==> '
                            '(event.rank >= 0) ==> (event.epic != "") ==> (event.id != "") ==> !(exists j: int :: '
                            '(((0 <= j) && (j < |history.commits|)) && (history.commits[j].id == event.id))) ==> '
                            '(exists j: int :: (((0 <= j) && (j < |history.epics|)) && (history.epics[j].id == '
                            'event.epic))) ==> forall i: int :: ((0 <= i) ==> (i < |history.commits|) ==> '
                            '((((((res.commits[i].rank == (if ((history.commits[i].epic == event.epic) && '
                            '(history.commits[i].rank >= event.rank)) then (history.commits[i].rank + 1) else '
                            'history.commits[i].rank)) && (res.commits[i].title == history.commits[i].title)) && '
                            '(res.commits[i].state == history.commits[i].state)) && (res.commits[i].task == '
                            'history.commits[i].task)) && (res.commits[i].lane == history.commits[i].lane)) && '
                            '(res.commits[i].notes == history.commits[i].notes))))',
 'history-start-empty-guard': '((event.seq_ == (history.seq_ + 1)) ==> event.Started? ==> !(((event.lane != "") '
                              '&& exists j: int :: ((((0 <= j) && (j < |history.commits|)) && '
                              '(history.commits[j].id == event.id)) && history.commits[j].state.planned?))) ==> '
                              '((((res.commits == history.commits) && (res.epics == history.epics)) && (res.real_ '
                              '== history.real_)) && (res.main == history.main)))',
 'myth-fold-duplicate': '((forall i: int, j: int :: ((0 <= i) ==> (i < j) ==> (j < |history.real_|) ==> '
                        '(history.real_[i].sha != history.real_[j].sha))) ==> forall i: int, j: int :: ((0 <= i) '
                        '==> (i < j) ==> (j < |res.real_|) ==> (res.real_[i].sha != res.real_[j].sha)))',
 'myth-fold-target': '((forall i: int :: ((0 <= i) ==> (i < |history.real_|) ==> exists j: int :: (((0 <= j) && '
                     '(j < |history.commits|)) && (history.commits[j].id == history.real_[i].mythical)))) ==> '
                     'forall i: int :: ((0 <= i) ==> (i < |res.real_|) ==> exists j: int :: (((0 <= j) && (j < '
                     '|res.commits|)) && (res.commits[j].id == res.real_[i].mythical))))',
 'myth-plan-epic': '((forall i: int :: ((0 <= i) ==> (i < |history.commits|) ==> exists k: int :: (((0 <= k) && '
                   '(k < |history.epics|)) && (history.epics[k].id == history.commits[i].epic)))) ==> forall i: '
                   'int :: ((0 <= i) ==> (i < |res.commits|) ==> exists k: int :: (((0 <= k) && (k < '
                   '|res.epics|)) && (res.epics[k].id == res.commits[i].epic))))',
 'myth-plan-id': '((forall i: int, j: int :: ((0 <= i) ==> (i < j) ==> (j < |history.commits|) ==> '
                 '(history.commits[i].id != history.commits[j].id))) ==> forall i: int, j: int :: ((0 <= i) ==> '
                 '(i < j) ==> (j < |res.commits|) ==> (res.commits[i].id != res.commits[j].id)))',
 'myth-plan-shift': '((forall i: int, j: int :: ((0 <= i) ==> (i < j) ==> (j < |history.commits|) ==> '
                    '(history.commits[i].epic == history.commits[j].epic) ==> (history.commits[i].rank != '
                    'history.commits[j].rank))) ==> forall i: int, j: int :: ((0 <= i) ==> (i < j) ==> (j < '
                    '|res.commits|) ==> (res.commits[i].epic == res.commits[j].epic) ==> (res.commits[i].rank != '
                    'res.commits[j].rank)))'}

# Exact positively verified clauses include person openings as well as guarded agent openings.
POSTCONDITIONS.update({'apply-pane': '((event.seq_ == (conversation.seq_ + 1)) ==> event.PaneOpened? ==> ((event.id == "") || ((conversation.agent.working? && (conversation.replying == event.id)) && (event.id != ""))) ==> (event.url != "") ==> (((res.pane == event.url) && (res.entries == conversation.entries)) && (res.agent == conversation.agent)))', 'apply-pane-guard': '((res.pane != conversation.pane) ==> ((event.PaneOpened? && ((event.id == "") || (conversation.agent.working? && (conversation.replying == event.id)))) && (event.url != "")))', 'decide-pane-guard': '(decide(conversation, intent).true_? ==> decide(conversation, intent).event.PaneOpened? ==> (((decide(conversation, intent).event.id == "") || ((conversation.agent.working? && (conversation.replying == decide(conversation, intent).event.id)) && (decide(conversation, intent).event.id != ""))) && (decide(conversation, intent).event.url != "")))', 'wiki-person-apply': '((event.seq_ == (conversation.seq_ + 1)) ==> event.PaneOpened? ==> ((event.id == "") || ((conversation.agent.working? && (conversation.replying == event.id)) && (event.id != ""))) ==> (event.url != "") ==> (((res.pane == event.url) && (res.entries == conversation.entries)) && (res.agent == conversation.agent)))'})

def postcondition_line(generated, function, contains):
    import re
    lines=generated.splitlines()
    # A pure function carries its postconditions on the generated `_ensures` lemma, a method on its own header.
    start=next((i for i,line in enumerate(lines) if re.match(r'lemma '+re.escape(function)+r'_ensures(?:<[^>(]*>)?\(',line)),None)
    if start is None:
        from sources import dafny_name
        start=next((i for i,line in enumerate(lines) if re.match(r'(?:ghost )?(?:method|function) '+re.escape(dafny_name(function))+r'(?:<[^>(]*>)?\(',line)),None)
    if start is None: raise ValueError('Missing target function '+function)
    end=next((i for i in range(start+1,len(lines)) if lines[i]=='{'),len(lines))
    matches=[i+1 for i in range(start,end) if lines[i].lstrip().startswith('ensures ') and contains in lines[i]]
    if len(matches)!=1: raise ValueError(f'Expected one production postcondition, got {len(matches)}: {contains}')
    return matches[0]

# Exact full-result clauses; all production assertions remain checked by the positive gate.
POSTCONDITIONS.update({'apply-frame-author': 'forall i: int :: ((0 <= i) ==> (i < |conversation.entries|) ==> (res.entries[i].author == '
                       'conversation.entries[i].author))',
 'apply-frame-clientId': 'forall i: int :: ((0 <= i) ==> (i < |conversation.entries|) ==> (res.entries[i].clientId == '
                         'conversation.entries[i].clientId))',
 'apply-frame-error': 'forall i: int :: ((0 <= i) ==> (i < |conversation.entries|) ==> (res.entries[i].error == (if '
                      '((((((event.seq_ == (conversation.seq_ + 1)) && conversation.agent.working?) && '
                      '(conversation.replying == event.id)) && (event.id != "")) && (conversation.entries[i].id == '
                      'event.id)) && event.ReplyFailed?) then (if (event.reason == "") then "failed" else event.reason) '
                      'else conversation.entries[i].error)))',
 'apply-frame-id': 'forall i: int :: ((0 <= i) ==> (i < |conversation.entries|) ==> (res.entries[i].id == '
                   'conversation.entries[i].id))',
 'apply-frame-inReplyTo': 'forall i: int :: ((0 <= i) ==> (i < |conversation.entries|) ==> (res.entries[i].inReplyTo == '
                          'conversation.entries[i].inReplyTo))',
 'apply-frame-name': 'forall i: int :: ((0 <= i) ==> (i < |conversation.entries|) ==> (res.entries[i].name == '
                     'conversation.entries[i].name))',
 'apply-frame-seq': 'forall i: int :: ((0 <= i) ==> (i < |conversation.entries|) ==> (res.entries[i].seq_ == '
                    'conversation.entries[i].seq_))',
 'apply-post-done': '((event.seq_ == (conversation.seq_ + 1)) ==> event.Posted? ==> (event.text != "") ==> (event.clientId '
                    '!= "") ==> (event.id != "") ==> (forall j: int :: ((0 <= j) ==> (j < |conversation.entries|) ==> '
                    '(conversation.entries[j].id != event.id))) ==> (forall j: int :: ((0 <= j) ==> (j < '
                    '|conversation.entries|) ==> (conversation.entries[j].clientId != event.clientId))) ==> '
                    '(((((((((res.entries[|conversation.entries|].id == event.id) && '
                    '(res.entries[|conversation.entries|].seq_ == event.seq_)) && '
                    '(res.entries[|conversation.entries|].clientId == event.clientId)) && '
                    '(res.entries[|conversation.entries|].inReplyTo == "")) && '
                    'res.entries[|conversation.entries|].author.person?) && (res.entries[|conversation.entries|].name == '
                    'event.name)) && (res.entries[|conversation.entries|].text == event.text)) && '
                    '(res.entries[|conversation.entries|].done == true)) && (res.entries[|conversation.entries|].error == '
                    '"")))',
 'apply-post-name': '((event.seq_ == (conversation.seq_ + 1)) ==> event.Posted? ==> (event.text != "") ==> (event.clientId '
                    '!= "") ==> (event.id != "") ==> (forall j: int :: ((0 <= j) ==> (j < |conversation.entries|) ==> '
                    '(conversation.entries[j].id != event.id))) ==> (forall j: int :: ((0 <= j) ==> (j < '
                    '|conversation.entries|) ==> (conversation.entries[j].clientId != event.clientId))) ==> '
                    '(((((((((res.entries[|conversation.entries|].id == event.id) && '
                    '(res.entries[|conversation.entries|].seq_ == event.seq_)) && '
                    '(res.entries[|conversation.entries|].clientId == event.clientId)) && '
                    '(res.entries[|conversation.entries|].inReplyTo == "")) && '
                    'res.entries[|conversation.entries|].author.person?) && (res.entries[|conversation.entries|].name == '
                    'event.name)) && (res.entries[|conversation.entries|].text == event.text)) && '
                    '(res.entries[|conversation.entries|].done == true)) && (res.entries[|conversation.entries|].error == '
                    '"")))',
 'apply-post-text': '((event.seq_ == (conversation.seq_ + 1)) ==> event.Posted? ==> (event.text != "") ==> (event.clientId '
                    '!= "") ==> (event.id != "") ==> (forall j: int :: ((0 <= j) ==> (j < |conversation.entries|) ==> '
                    '(conversation.entries[j].id != event.id))) ==> (forall j: int :: ((0 <= j) ==> (j < '
                    '|conversation.entries|) ==> (conversation.entries[j].clientId != event.clientId))) ==> '
                    '(((((((((res.entries[|conversation.entries|].id == event.id) && '
                    '(res.entries[|conversation.entries|].seq_ == event.seq_)) && '
                    '(res.entries[|conversation.entries|].clientId == event.clientId)) && '
                    '(res.entries[|conversation.entries|].inReplyTo == "")) && '
                    'res.entries[|conversation.entries|].author.person?) && (res.entries[|conversation.entries|].name == '
                    'event.name)) && (res.entries[|conversation.entries|].text == event.text)) && '
                    '(res.entries[|conversation.entries|].done == true)) && (res.entries[|conversation.entries|].error == '
                    '"")))',
 'apply-unmatched-done': 'forall i: int :: ((0 <= i) ==> (i < |conversation.entries|) ==> (res.entries[i].done == '
                         '(conversation.entries[i].done || (((event.seq_ == (conversation.seq_ + 1)) && '
                         '(conversation.entries[i].id == event.id)) && ((((conversation.agent.working? && '
                         '(conversation.replying == event.id)) && (event.id != "")) && (event.ReplyFinished? || '
                         'event.ReplyFailed?)) || ((((event.TourEnded? && conversation.agent.working?) && '
                         '(conversation.replying == event.id)) && (event.id != "")) && exists j: int :: (((((0 <= j) && (j '
                         '< |conversation.entries|)) && (conversation.entries[j].id == event.id)) && '
                         'conversation.entries[j].author.agent?) && (conversation.entries[j].inReplyTo == ""))))))))',
 'receive-agent-frame': '(res.conversation.agent == (if ((event.seq_ == (client.conversation.seq_ + 1)) && '
                        '(((((((event.ReplyStarted? && (!client.conversation.agent.working?)) && (event.id != "")) && '
                        'forall j: int :: ((0 <= j) ==> (j < |client.conversation.entries|) ==> '
                        '(client.conversation.entries[j].id != event.id))) && (event.inReplyTo != "")) && exists j: int :: '
                        '((((0 <= j) && (j < |client.conversation.entries|)) && '
                        'client.conversation.entries[j].author.person?) && (client.conversation.entries[j].id == '
                        'event.inReplyTo))) && forall j: int :: ((0 <= j) ==> (j < |client.conversation.entries|) ==> '
                        'client.conversation.entries[j].author.agent? ==> (client.conversation.entries[j].inReplyTo != '
                        'event.inReplyTo))) || (((event.TourStarted? && (!client.conversation.agent.working?)) && (event.id '
                        '!= "")) && forall j: int :: ((0 <= j) ==> (j < |client.conversation.entries|) ==> '
                        '(client.conversation.entries[j].id != event.id))))) then AgentPhase.working else (if '
                        '(((((event.seq_ == (client.conversation.seq_ + 1)) && event.ReplyFailed?) && '
                        'client.conversation.agent.working?) && (client.conversation.replying == event.id)) && (event.id != '
                        '"")) then AgentPhase.failed else (if ((event.seq_ == (client.conversation.seq_ + 1)) && '
                        '((((event.ReplyFinished? && client.conversation.agent.working?) && (client.conversation.replying '
                        '== event.id)) && (event.id != "")) || ((((event.TourEnded? && client.conversation.agent.working?) '
                        '&& (client.conversation.replying == event.id)) && (event.id != "")) && exists j: int :: (((((0 <= '
                        'j) && (j < |client.conversation.entries|)) && (client.conversation.entries[j].id == event.id)) && '
                        'client.conversation.entries[j].author.agent?) && (client.conversation.entries[j].inReplyTo == '
                        '""))))) then AgentPhase.idle else client.conversation.agent))))',
 'receive-entries-frame': '(|res.conversation.entries| == (|client.conversation.entries| + (if ((event.seq_ == '
                          '(client.conversation.seq_ + 1)) && (((((((event.Posted? && (event.text != "")) && '
                          '(event.clientId != "")) && (event.id != "")) && forall j: int :: ((0 <= j) ==> (j < '
                          '|client.conversation.entries|) ==> (client.conversation.entries[j].id != event.id))) && forall '
                          'j: int :: ((0 <= j) ==> (j < |client.conversation.entries|) ==> '
                          '(client.conversation.entries[j].clientId != event.clientId))) || ((((((event.ReplyStarted? && '
                          '(!client.conversation.agent.working?)) && (event.id != "")) && forall j: int :: ((0 <= j) ==> (j '
                          '< |client.conversation.entries|) ==> (client.conversation.entries[j].id != event.id))) && '
                          '(event.inReplyTo != "")) && exists j: int :: ((((0 <= j) && (j < |client.conversation.entries|)) '
                          '&& client.conversation.entries[j].author.person?) && (client.conversation.entries[j].id == '
                          'event.inReplyTo))) && forall j: int :: ((0 <= j) ==> (j < |client.conversation.entries|) ==> '
                          'client.conversation.entries[j].author.agent? ==> (client.conversation.entries[j].inReplyTo != '
                          'event.inReplyTo)))) || (((event.TourStarted? && (!client.conversation.agent.working?)) && '
                          '(event.id != "")) && forall j: int :: ((0 <= j) ==> (j < |client.conversation.entries|) ==> '
                          '(client.conversation.entries[j].id != event.id))))) then 1 else 0)))',
 'receive-field-author': 'forall i: int :: ((0 <= i) ==> (i < |client.conversation.entries|) ==> '
                         '(res.conversation.entries[i].author == client.conversation.entries[i].author))',
 'receive-field-clientId': 'forall i: int :: ((0 <= i) ==> (i < |client.conversation.entries|) ==> '
                           '(res.conversation.entries[i].clientId == client.conversation.entries[i].clientId))',
 'receive-field-done': 'forall i: int :: ((0 <= i) ==> (i < |client.conversation.entries|) ==> '
                       '(res.conversation.entries[i].done == (client.conversation.entries[i].done || (((event.seq_ == '
                       '(client.conversation.seq_ + 1)) && (client.conversation.entries[i].id == event.id)) && '
                       '((((client.conversation.agent.working? && (client.conversation.replying == event.id)) && (event.id '
                       '!= "")) && (event.ReplyFinished? || event.ReplyFailed?)) || ((((event.TourEnded? && '
                       'client.conversation.agent.working?) && (client.conversation.replying == event.id)) && (event.id != '
                       '"")) && exists j: int :: (((((0 <= j) && (j < |client.conversation.entries|)) && '
                       '(client.conversation.entries[j].id == event.id)) && client.conversation.entries[j].author.agent?) '
                       '&& (client.conversation.entries[j].inReplyTo == ""))))))))',
 'receive-field-error': 'forall i: int :: ((0 <= i) ==> (i < |client.conversation.entries|) ==> '
                        '(res.conversation.entries[i].error == (if ((((((event.seq_ == (client.conversation.seq_ + 1)) && '
                        'client.conversation.agent.working?) && (client.conversation.replying == event.id)) && (event.id != '
                        '"")) && (client.conversation.entries[i].id == event.id)) && event.ReplyFailed?) then (if '
                        '(event.reason == "") then "failed" else event.reason) else client.conversation.entries[i].error)))',
 'receive-field-id': 'forall i: int :: ((0 <= i) ==> (i < |client.conversation.entries|) ==> '
                     '(res.conversation.entries[i].id == client.conversation.entries[i].id))',
 'receive-field-inReplyTo': 'forall i: int :: ((0 <= i) ==> (i < |client.conversation.entries|) ==> '
                            '(res.conversation.entries[i].inReplyTo == client.conversation.entries[i].inReplyTo))',
 'receive-field-name': 'forall i: int :: ((0 <= i) ==> (i < |client.conversation.entries|) ==> '
                       '(res.conversation.entries[i].name == client.conversation.entries[i].name))',
 'receive-field-seq': 'forall i: int :: ((0 <= i) ==> (i < |client.conversation.entries|) ==> '
                      '(res.conversation.entries[i].seq_ == client.conversation.entries[i].seq_))',
 'receive-field-text': 'forall i: int :: ((0 <= i) ==> (i < |client.conversation.entries|) ==> '
                       '(res.conversation.entries[i].text == (if ((((((event.seq_ == (client.conversation.seq_ + 1)) && '
                       'client.conversation.agent.working?) && (client.conversation.replying == event.id)) && (event.id != '
                       '"")) && (client.conversation.entries[i].id == event.id)) && event.ReplyDelta?) then '
                       '(client.conversation.entries[i].text + event.text) else (if ((((((event.seq_ == '
                       '(client.conversation.seq_ + 1)) && client.conversation.agent.working?) && '
                       '(client.conversation.replying == event.id)) && (event.id != "")) && '
                       '(client.conversation.entries[i].id == event.id)) && event.ReplyRestarted?) then "" else '
                       'client.conversation.entries[i].text))))',
 'receive-pane-frame': '(res.conversation.pane == (if ((((event.seq_ == (client.conversation.seq_ + 1)) && '
                       'event.PaneOpened?) && ((event.id == "") || '
                       '((client.conversation.agent.working? && (client.conversation.replying == event.id)) && '
                       '(event.id != "")))) && (event.url != "")) then event.url else client.conversation.pane))',
 'receive-replying-frame': '(res.conversation.replying == (if ((event.seq_ == (client.conversation.seq_ + 1)) && '
                           '(((((((event.ReplyStarted? && (!client.conversation.agent.working?)) && (event.id != "")) && '
                           'forall j: int :: ((0 <= j) ==> (j < |client.conversation.entries|) ==> '
                           '(client.conversation.entries[j].id != event.id))) && (event.inReplyTo != "")) && exists j: int '
                           ':: ((((0 <= j) && (j < |client.conversation.entries|)) && '
                           'client.conversation.entries[j].author.person?) && (client.conversation.entries[j].id == '
                           'event.inReplyTo))) && forall j: int :: ((0 <= j) ==> (j < |client.conversation.entries|) ==> '
                           'client.conversation.entries[j].author.agent? ==> (client.conversation.entries[j].inReplyTo != '
                           'event.inReplyTo))) || (((event.TourStarted? && (!client.conversation.agent.working?)) && '
                           '(event.id != "")) && forall j: int :: ((0 <= j) ==> (j < |client.conversation.entries|) ==> '
                           '(client.conversation.entries[j].id != event.id))))) then event.id else (if ((event.seq_ == '
                           '(client.conversation.seq_ + 1)) && ((((client.conversation.agent.working? && '
                           '(client.conversation.replying == event.id)) && (event.id != "")) && (event.ReplyFinished? || '
                           'event.ReplyFailed?)) || ((((event.TourEnded? && client.conversation.agent.working?) && '
                           '(client.conversation.replying == event.id)) && (event.id != "")) && exists j: int :: (((((0 <= '
                           'j) && (j < |client.conversation.entries|)) && (client.conversation.entries[j].id == event.id)) '
                           '&& client.conversation.entries[j].author.agent?) && (client.conversation.entries[j].inReplyTo '
                           '== ""))))) then "" else client.conversation.replying)))'})

# A checked assertion must be selected before it can mask a later isolated postcondition.
ASSERTIONS = {
    'apply-unmatched-done': ('ReplyDelta', 'forall i: int :: ((0 <= i) ==> (i < |conversation.entries|) ==> (entries[i].done == conversation.entries[i].done))'),
    'apply-delta-done': ('ReplyDelta', 'forall i: int :: ((0 <= i) ==> (i < |conversation.entries|) ==> (entries[i].done == conversation.entries[i].done))'),
    'apply-prefix': ('Posted', 'forall i: int :: ((0 <= i) ==> (i < |conversation.entries|) ==> (entries[i] == conversation.entries[i]))'),
}
for _name in ASSERTIONS:
    POSTCONDITIONS.pop(_name, None)

def case_assertion_line(generated, function, case, clause):
    import re
    lines = generated.splitlines()
    starts = [i for i, line in enumerate(lines) if re.match(r'(?:ghost )?(?:method|function) '+re.escape(function)+r'(?:<[^>(]*>)?\(', line)]
    if len(starts) != 1: raise ValueError('Missing or ambiguous target function '+function)
    start = starts[0]
    end = next((i for i in range(start+1, len(lines)) if re.match(r'(?:ghost )?(?:method|function|lemma) ', lines[i])), len(lines))
    if case is None:
        branch, branch_end = start, end
    else:
        branches = [i for i in range(start, end) if re.match(r'\s+case '+re.escape(case)+r'\(', lines[i])]
        if len(branches) != 1: raise ValueError('Missing or ambiguous case '+case)
        branch = branches[0]
        indent = lines[branch][:len(lines[branch])-len(lines[branch].lstrip())]
        branch_end = next((i for i in range(branch+1, end) if lines[i].startswith(indent+'case ') or lines[i] == '}'), end)
    matches = [i+1 for i in range(branch+1, branch_end) if lines[i].strip() == 'assert '+clause+';']
    if len(matches) != 1: raise ValueError('Missing or ambiguous checked assertion '+clause)
    return matches[0]

# Small redundant production guarantees precede the complete relational clauses.
POSTCONDITIONS.update({'apply-post-done': '(event.Posted? ==> (|res.entries| > |conversation.entries|) ==> '
                    '(res.entries[|conversation.entries|].done == true))',
 'apply-post-name': '(event.Posted? ==> (|res.entries| > |conversation.entries|) ==> '
                    '(res.entries[|conversation.entries|].name == event.name))',
 'apply-post-text': '(event.Posted? ==> (|res.entries| > |conversation.entries|) ==> '
                    '(res.entries[|conversation.entries|].text == event.text))',
 'receive-agent-frame': '(match event { case Posted(i_event_seq, i_event_id, i_event_clientId, i_event_name, i_event_text) '
                        '=> (res.conversation.agent == client.conversation.agent) case _ => true })',
 'receive-field-author': '((|client.conversation.entries| > 1) ==> (res.conversation.entries[1].author == '
                         'client.conversation.entries[1].author))',
 'receive-field-clientId': '((|client.conversation.entries| > 0) ==> (res.conversation.entries[0].clientId == '
                           'client.conversation.entries[0].clientId))',
 'receive-field-done': '((|client.conversation.entries| > 0) ==> event.ReplyDelta? ==> (res.conversation.entries[0].done == '
                       'client.conversation.entries[0].done))',
 'receive-field-error': '((|client.conversation.entries| > 0) ==> (!event.ReplyFailed?) ==> '
                        '(res.conversation.entries[0].error == client.conversation.entries[0].error))',
 'receive-field-id': '((|client.conversation.entries| > 0) ==> (res.conversation.entries[0].id == '
                     'client.conversation.entries[0].id))',
 'receive-field-inReplyTo': '((|client.conversation.entries| > 0) ==> (res.conversation.entries[0].inReplyTo == '
                            'client.conversation.entries[0].inReplyTo))',
 'receive-field-name': '((|client.conversation.entries| > 0) ==> (res.conversation.entries[0].name == '
                       'client.conversation.entries[0].name))',
 'receive-field-seq': '((|client.conversation.entries| > 0) ==> (res.conversation.entries[0].seq_ == '
                      'client.conversation.entries[0].seq_))',
 'receive-field-text': '((|client.conversation.entries| > 0) ==> (!event.ReplyDelta?) ==> (!event.ReplyRestarted?) ==> '
                       '(res.conversation.entries[0].text == client.conversation.entries[0].text))'})

# First affected role-ledger and admission clauses; positive checks remain unfiltered.
POSTCONDITIONS.update({'apply-action-roles': '(|res.roles| == (|conversation.roles| + (if ((((event.seq_ == (conversation.seq_ + '
                       '1)) && event.RoleGranted?) && (event.id != "")) && (!event.role.viewer?)) then 1 '
                       'else 0)))',
 'apply-role': '((event.seq_ == (conversation.seq_ + 1)) ==> event.RoleGranted? ==> (event.id != "") ==> '
               '(!event.role.viewer?) ==> (((res.roles[0].id == event.id) && (res.roles[0].role == '
               'event.role)) && (res.roles[0].blocked == event.mode.person?)))',
 'apply-role-blocked': '((event.seq_ == (conversation.seq_ + 1)) ==> event.RoleGranted? ==> (event.id != "") '
                       '==> (!event.role.viewer?) ==> (((res.roles[0].id == event.id) && (res.roles[0].role '
                       '== event.role)) && (res.roles[0].blocked == event.mode.person?)))',
 'apply-role-empty': '(|res.roles| == (|conversation.roles| + (if ((((event.seq_ == (conversation.seq_ + 1)) '
                     '&& event.RoleGranted?) && (event.id != "")) && (!event.role.viewer?)) then 1 else 0)))',
 'apply-role-id': '((event.seq_ == (conversation.seq_ + 1)) ==> event.RoleGranted? ==> (event.id != "") ==> '
                  '(!event.role.viewer?) ==> (((res.roles[0].id == event.id) && (res.roles[0].role == '
                  'event.role)) && (res.roles[0].blocked == event.mode.person?)))',
 'apply-role-prefix': '(|res.roles| == (|conversation.roles| + (if ((((event.seq_ == (conversation.seq_ + '
                      '1)) && event.RoleGranted?) && (event.id != "")) && (!event.role.viewer?)) then 1 else '
                      '0)))',
 'apply-role-viewer': '(|res.roles| == (|conversation.roles| + (if ((((event.seq_ == (conversation.seq_ + '
                      '1)) && event.RoleGranted?) && (event.id != "")) && (!event.role.viewer?)) then 1 else '
                      '0)))',
 'decide-action-guard': '(decide(conversation, intent).true_? ==> intent.Authorize? ==> ((intent.action.merge? || '
                        'intent.action.settings?) || intent.action.roles?) ==> ((intent.by_ != "") && exists '
                        'i: int :: (((((0 <= i) && (i < |conversation.roles|)) && (conversation.roles[i].id '
                        '== intent.by_)) && conversation.roles[i].role.maintainer?) && forall j: int :: ((0 '
                        '<= j) ==> (j < i) ==> (conversation.roles[j].id != intent.by_)))))',
 'decide-role-guard': '(decide(conversation, intent).true_? ==> intent.GrantRole? ==> ((intent.id != "") && (!intent.role.viewer?)))',
 'receive-role-head': 'forall i: int :: ((0 <= i) ==> (i < |client.conversation.roles|) ==> '
                      '(res.conversation.roles[(i + (if ((((event.seq_ == (client.conversation.seq_ + 1)) && '
                      'event.RoleGranted?) && (event.id != "")) && (!event.role.viewer?)) then 1 else 0))] '
                      '== client.conversation.roles[i]))',
 'receive-role-ledger': '(|res.conversation.roles| == (|client.conversation.roles| + (if ((((event.seq_ == '
                        '(client.conversation.seq_ + 1)) && event.RoleGranted?) && (event.id != "")) && '
                        '(!event.role.viewer?)) then 1 else 0)))'})

# Receiver mutations select the first affected contract or checked membership assertion.
POSTCONDITIONS.update({'receive-next-gap': '((event.seq_ == (client.conversation.seq_ + 1)) ==> ((res.conversation.seq_ == '
                     'event.seq_) && !(res.gap)))',
 'receive-next-seq': '((event.seq_ == (client.conversation.seq_ + 1)) ==> ((res.conversation.seq_ == '
                     'event.seq_) && !(res.gap)))',
 'receive-stale': '((event.seq_ <= client.conversation.seq_) ==> (res == client))'})
ASSERTIONS.update({'receive-pending-filter': (None,
                            '((!event.Posted?) || forall i: int :: ((0 <= i) ==> (i < |pending|) ==> '
                            '((pending[i] in client.pending) && (pending[i].clientId != event.clientId))))'),
 'receive-pending-other': (None,
                           '((!event.Posted?) || forall i: int :: ((0 <= i) ==> (i < |client.pending|) ==> '
                           '(client.pending[i].clientId != event.clientId) ==> (client.pending[i] in '
                           'pending)))')})

# Initial pending is replaced for Posted; its mutation breaks the non-Posted frame.
ASSERTIONS.pop("receive-pending-other", None)
POSTCONDITIONS["receive-pending-other"] = '((event.seq_ == (client.conversation.seq_ + 1)) ==> (!event.Posted?) ==> (res.pending == client.pending))'

# Derived empty-input frame clauses make concrete counterexamples tractable; full relations stay proved.
POSTCONDITIONS.update({'receive-agent-frame': '(event.Posted? ==> client.conversation.agent.idle? ==> (|client.conversation.roles| '
                        '== 0) ==> (|client.conversation.entries| == 0) ==> (|client.pending| == 0) ==> '
                        'res.conversation.agent.idle?)',
 'receive-replying-frame': '(event.Posted? ==> client.conversation.agent.idle? ==> '
                           '(|client.conversation.roles| == 0) ==> (|client.conversation.entries| == 0) ==> '
                           '(|client.pending| == 0) ==> (res.conversation.replying == '
                           'client.conversation.replying))'})
# The strengthening lane's run and walkthrough frames: `apply` and `receive` are too large for a whole-function check.
POSTCONDITIONS.update({
    # The short actor clause: the whole appended-run clause takes Dafny past the mutation wall limit to refute.
    'apply-action-actor': '((|runsOf(res)| == (|runsOf(conversation)| + 1)) && (runsOf(res)[|runsOf(conversation)|].actor == event.actor)))',
    'apply-tour-end-runs': '(!event.ActionSettled?) ==> (res.runs == conversation.runs)',
    'apply-walkthrough-guard': '(event.WalkthroughDriven? ==> !((',
})

# These mutants already fail their gap contract, but unrelated receive obligations can time out first.
# Select the exact existing production clause; positive verification still checks the entire relation.
POSTCONDITIONS.update({
    'receive-gap': '((event.seq_ > (client.conversation.seq_ + 1)) ==> res.gap)',
    'receive-gap-frame': '((event.seq_ > (client.conversation.seq_ + 1)) ==> ((res.conversation == client.conversation) && (res.pending == client.pending)))',
})

# A loop invariant the mutant breaks, checked alone: unisolated, the loop's one verification condition carries the
# imported contract of `apply` and times out instead of failing (replay-skip and replay-order on a 4-vCPU box, 2026-11-10).
INVARIANTS = {'replay-skip': 'current == replayedLog(initial, events, i)',
              'replay-order': 'current == replayedLog(initial, events, i)'}

def invariant_line(generated, function, contains):
    import re
    lines = generated.splitlines()
    starts = [i for i, line in enumerate(lines) if re.match(r'(?:ghost )?method '+re.escape(function)+r'(?:<[^>(]*>)?\(', line)]
    if len(starts) != 1: raise ValueError('Missing or ambiguous target method '+function)
    start = starts[0]
    end = next((i for i in range(start+1, len(lines)) if re.match(r'(?:ghost )?(?:method|function|lemma) ', lines[i])), len(lines))
    matches = [i+1 for i in range(start+1, end) if lines[i].lstrip().startswith('invariant ') and contains in lines[i]]
    if len(matches) != 1: raise ValueError(f'Expected one loop invariant, got {len(matches)}: {contains}')
    return matches[0]


# Seconds Dafny may spend on each check of a named mutant. A timeout never counts as a rejection, so a mutant whose one
# isolated check is a contract failure Dafny needs about 30 s to find gets headroom: replay-order took 24-31 s alone on a
# 4-vCPU box and timed out at 30 s under load (2026-11-10); replay-skip timed out the same way. Unnamed mutants keep 30 s,
# and positive proofs default to 60 s (PROOF_TIME_LIMITS below).
TIME_LIMITS = {'replay-order': 120, 'replay-skip': 120}

# Whole-suite history composition hit 60 s although the same module completed in 38-42 s alone.
# Positive headroom is module-specific; it never changes a mutant's budget or rejection criteria.
PROOF_TIME_LIMITS = {'src/history/replayDecision.vibe': 180}

def time_limit(stem, mutation, source=None):
    return TIME_LIMITS.get(stem, 30) if mutation else PROOF_TIME_LIMITS.get(source, 60)

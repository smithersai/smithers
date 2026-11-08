"""Production postconditions selected for expensive negative cases; positive proofs still check every obligation."""
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

def postcondition_line(generated, function, contains):
    import re
    lines=generated.splitlines()
    start=next((i for i,line in enumerate(lines) if re.match(r'(?:ghost )?(?:method|function) '+re.escape(function)+r'\(',line)),None)
    if start is None: raise ValueError('Missing target function '+function)
    end=next((i for i in range(start+1,len(lines)) if lines[i]=='{'),len(lines))
    matches=[i+1 for i in range(start,end) if lines[i].lstrip().startswith('ensures ') and contains in lines[i]]
    if len(matches)!=1: raise ValueError(f'Expected one production postcondition, got {len(matches)}: {contains}')
    return matches[0]

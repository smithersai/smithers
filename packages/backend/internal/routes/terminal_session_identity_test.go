package routes

import "testing"

// When two callers race on the same terminal sessionID, the duplicate loser's
// teardown (onDone) must not evict the live winner from the manager map — doing
// so orphans the winner's SSH connection and goroutines. removeSession is
// identity-checked to prevent exactly that.
func TestTerminalSessionManager_removeSessionIsIdentityChecked(t *testing.T) {
	m := &TerminalSessionManager{sessions: map[string]*terminalSession{}}
	winner := &terminalSession{}
	loser := &terminalSession{}
	m.sessions["sess-1"] = winner

	// A different (loser) session removing itself must NOT evict the live winner.
	m.removeSession("sess-1", loser)
	if m.sessions["sess-1"] != winner {
		t.Fatal("removeSession evicted the live winner when a different session tore down")
	}

	// The tracked session removing itself works normally.
	m.removeSession("sess-1", winner)
	if _, ok := m.sessions["sess-1"]; ok {
		t.Fatal("removeSession did not remove the winner when identity matched")
	}
}

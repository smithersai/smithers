package repohostserver

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// terminalStageDecision is a permanent, token-scoped fence. A completion
// request can arrive before a stage request has finished reading its body; the
// fence prevents that delayed stage from installing a journal after the
// compensating completion already returned success.
type terminalStageDecision struct {
	Token  string `json:"token"`
	Action string `json:"action"`
}

func readTerminalStageDecision(root, expectedToken string) (terminalStageDecision, bool, error) {
	data, err := os.ReadFile(filepath.Join(root, expectedToken+".json"))
	if err != nil {
		if os.IsNotExist(err) {
			return terminalStageDecision{}, false, nil
		}
		return terminalStageDecision{}, false, err
	}

	var decision terminalStageDecision
	if err := json.Unmarshal(data, &decision); err != nil {
		return terminalStageDecision{}, false, err
	}
	if decision.Token != expectedToken || !validDeleteStageToken(decision.Token) {
		return terminalStageDecision{}, false, fmt.Errorf("invalid terminal stage decision token")
	}
	if strings.TrimSpace(decision.Action) == "" {
		return terminalStageDecision{}, false, fmt.Errorf("invalid terminal stage decision action")
	}
	return decision, true, nil
}

func writeTerminalStageDecision(root, token, action string) error {
	if err := ensureDurableDirectory(root, 0o700); err != nil {
		return err
	}
	encoded, err := json.Marshal(terminalStageDecision{Token: token, Action: action})
	if err != nil {
		return err
	}
	_, err = writeDurableJournal(root, token+".json", encoded, 0o600)
	return err
}

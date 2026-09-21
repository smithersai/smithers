package repohostserver

import (
	"strings"
	"testing"
)

func TestPushHook_H_MustMarshalJSONPanicsOnUnsupportedValue(t *testing.T) {
	defer func() {
		recovered := recover()
		if recovered == nil {
			t.Fatal("expected panic")
		}
		if !strings.Contains(recovered.(string), "marshal json") {
			t.Fatalf("unexpected panic: %v", recovered)
		}
	}()

	_ = mustMarshalJSON(func() {})
}

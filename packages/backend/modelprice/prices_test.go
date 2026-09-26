package modelprice

import "testing"

func TestCostNanosPreservesSubCentAndRejectsOverflow(t *testing.T) {
	price, ok := Lookup("gpt-oss-120b")
	if !ok {
		t.Fatal("missing model")
	}
	nanos, err := CostNanos(price, Usage{InputTokens: 1})
	if err != nil || nanos != 350 {
		t.Fatalf("one token=%d nanos err=%v", nanos, err)
	}
	nanos, err = CostNanos(price, Usage{InputTokens: 10_000, OutputTokens: 1_000})
	if err != nil || nanos != 4_250_000 {
		t.Fatalf("usage=%d nanos err=%v", nanos, err)
	}
	if _, err = CostNanos(price, Usage{InputTokens: -1}); err == nil {
		t.Fatal("negative usage accepted")
	}
	if _, err = CostNanos(price, Usage{InputTokens: 1 << 62}); err == nil {
		t.Fatal("overflow accepted")
	}
}

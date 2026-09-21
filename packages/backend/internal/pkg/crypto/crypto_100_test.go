package crypto

import (
	"errors"
	"testing"
)

func TestCrypto_H_MustReturnsValue(t *testing.T) {
	if got := must("value", nil); got != "value" {
		t.Fatalf("must returned %q, want value", got)
	}
}

func TestCrypto_H_MustPanicsOnError(t *testing.T) {
	want := errors.New("forced must failure")
	defer func() {
		if got := recover(); got != want {
			t.Fatalf("recover() = %v, want %v", got, want)
		}
	}()

	_ = must("", want)
}

package compose

import (
	"testing"
)

func TestFlowHostProductAPIURLUsesRuntimeReachableOrigin(t *testing.T) {
	cases := []struct {
		name    string
		options runOptions
		listen  string
		want    string
		fail    bool
	}{
		{name: "local listener", options: runOptions{Options: Options{Role: RoleLocal}}, listen: "0.0.0.0:4000", want: "http://127.0.0.1:4000"},
		{name: "hosted explicit internal", options: runOptions{Options: Options{Role: RoleHostedWorker, FlowHostProductAPIURL: "https://backend.internal/"}}, listen: ":4000", want: "https://backend.internal"},
		{name: "hosted no internal", options: runOptions{Options: Options{Role: RoleHostedWorker}}, listen: ":4000", fail: true},
		{name: "externally mounted listener", options: runOptions{Options: Options{Role: RoleLocal}, externalHTTP: true}, listen: ":4000", fail: true},
		{name: "ephemeral listener", options: runOptions{Options: Options{Role: RoleLocal}}, listen: ":0", fail: true},
		{name: "untrusted URL", options: runOptions{Options: Options{Role: RoleHostedWorker, FlowHostProductAPIURL: "https://backend.internal/path"}}, listen: ":4000", fail: true},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			got, err := flowHostProductAPIURL(test.options, test.listen)
			if (err != nil) != test.fail || got != test.want {
				t.Fatalf("origin = %q, error = %v; want %q, fail %v", got, err, test.want, test.fail)
			}
		})
	}
}

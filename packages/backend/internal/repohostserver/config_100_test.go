package repohostserver

import "testing"

func TestConfig_H_FFILibraryExtForOS(t *testing.T) {
	tests := []struct {
		name string
		goos string
		want string
	}{
		{name: "darwin", goos: "darwin", want: "dylib"},
		{name: "windows", goos: "windows", want: "dll"},
		{name: "linux", goos: "linux", want: "so"},
		{name: "unknown", goos: "plan9", want: "so"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := ffiLibraryExtForOS(tt.goos); got != tt.want {
				t.Fatalf("ffiLibraryExtForOS(%q) = %q, want %q", tt.goos, got, tt.want)
			}
		})
	}
}

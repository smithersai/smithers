package guest

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/user"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type handlerHTempFile struct {
	name     string
	writeErr error
	syncErr  error
	chmodErr error
	closeErr error
}

func (f *handlerHTempFile) Write(p []byte) (int, error) {
	if f.writeErr != nil {
		return 0, f.writeErr
	}
	return len(p), nil
}

func (f *handlerHTempFile) Sync() error {
	return f.syncErr
}

func (f *handlerHTempFile) Chmod(os.FileMode) error {
	return f.chmodErr
}

func (f *handlerHTempFile) Close() error {
	return f.closeErr
}

func (f *handlerHTempFile) Name() string {
	return f.name
}

func handlerHRestoreLookupUser(t *testing.T, fn func(string) (*user.User, error)) {
	t.Helper()
	orig := guestLookupUser
	guestLookupUser = fn
	t.Cleanup(func() { guestLookupUser = orig })
}

func handlerHWithSystemdUnitPath(t *testing.T) string {
	t.Helper()
	orig := guestSystemdUnitPath
	dir := t.TempDir()
	guestSystemdUnitPath = dir
	t.Cleanup(func() { guestSystemdUnitPath = orig })
	return dir
}

func handlerHInstallSystemctl(t *testing.T) string {
	t.Helper()
	argsFile := filepath.Join(t.TempDir(), "systemctl.args")
	handlerCovSetPathWithCommands(t, map[string]string{
		"systemctl": `printf '%s\n' "$@" >> "$HANDLER_H_SYSTEMCTL_ARGS"
case "${HANDLER_H_SYSTEMCTL_MODE}:$1" in
daemon-fail:daemon-reload)
  printf 'reload boom' >&2
  exit 21
  ;;
enable-fail:enable)
  printf 'enable boom' >&2
  exit 22
  ;;
start-fail:start)
  printf 'start boom' >&2
  exit 23
  ;;
*)
  exit 0
  ;;
esac
`,
	})
	t.Setenv("HANDLER_H_SYSTEMCTL_ARGS", argsFile)
	return argsFile
}

func TestHandler_H_EnsureUserCreatedSuccess(t *testing.T) {
	h := NewHandler(time.Hour)
	const username = "h-created-user"
	calls := 0
	handlerHRestoreLookupUser(t, func(got string) (*user.User, error) {
		if got != username {
			t.Fatalf("lookup username = %q, want %q", got, username)
		}
		calls++
		if calls == 1 {
			return nil, user.UnknownUserError(username)
		}
		return &user.User{
			Username: username,
			Uid:      "4321",
			HomeDir:  "/home/" + username,
		}, nil
	})
	handlerCovSetPathWithCommands(t, map[string]string{
		"useradd": `exit 0
`,
	})

	resp, err := h.handleEnsureUser(context.Background(), &EnsureUserRequest{Username: username})
	if err != nil {
		t.Fatalf("handleEnsureUser: %v", err)
	}
	if !resp.Created || resp.UID != 4321 || resp.Home != "/home/"+username {
		t.Fatalf("response = %+v, want created uid/home", resp)
	}
	if calls != 2 {
		t.Fatalf("lookup calls = %d, want 2", calls)
	}
}

func TestHandler_H_WriteFileInjectedTempFileErrors(t *testing.T) {
	cases := []struct {
		name      string
		configure func(*handlerHTempFile)
		wantSub   string
	}{
		{
			name:      "write",
			configure: func(f *handlerHTempFile) { f.writeErr = errors.New("write h boom") },
			wantSub:   "write temp file",
		},
		{
			name:      "sync",
			configure: func(f *handlerHTempFile) { f.syncErr = errors.New("sync h boom") },
			wantSub:   "fsync temp file",
		},
		{
			name:      "chmod",
			configure: func(f *handlerHTempFile) { f.chmodErr = errors.New("chmod h boom") },
			wantSub:   "chmod temp file",
		},
		{
			name:      "close",
			configure: func(f *handlerHTempFile) { f.closeErr = errors.New("close h boom") },
			wantSub:   "close temp file",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			origCreateTemp := guestCreateTemp
			origRemove := guestRemove
			t.Cleanup(func() {
				guestCreateTemp = origCreateTemp
				guestRemove = origRemove
			})

			tmp := &handlerHTempFile{name: filepath.Join(t.TempDir(), "h-tmp")}
			tc.configure(tmp)
			removed := false
			guestCreateTemp = func(string, string) (guestTempFile, error) { return tmp, nil }
			guestRemove = func(name string) error {
				if name == tmp.name {
					removed = true
				}
				return nil
			}

			h := NewHandler(time.Hour)
			_, err := h.handleWriteFile(&WriteFileRequest{
				Path:    filepath.Join(t.TempDir(), "out.txt"),
				Content: []byte("payload"),
			})
			if err == nil || !strings.Contains(err.Error(), tc.wantSub) {
				t.Fatalf("err = %v, want substring %q", err, tc.wantSub)
			}
			if !removed {
				t.Fatalf("temp file %q was not removed", tmp.name)
			}
		})
	}
}

func TestHandler_H_WriteFileInjectedChownError(t *testing.T) {
	origLookupUser := guestLookupUser
	origLookupGroup := guestLookupGroup
	origChown := guestChown
	origRemove := guestRemove
	t.Cleanup(func() {
		guestLookupUser = origLookupUser
		guestLookupGroup = origLookupGroup
		guestChown = origChown
		guestRemove = origRemove
	})

	guestLookupUser = func(name string) (*user.User, error) {
		if name != "h-user" {
			t.Fatalf("lookup user = %q, want h-user", name)
		}
		return &user.User{Uid: "1234"}, nil
	}
	guestLookupGroup = func(name string) (*user.Group, error) {
		if name != "h-group" {
			t.Fatalf("lookup group = %q, want h-group", name)
		}
		return &user.Group{Gid: "5678"}, nil
	}
	guestChown = func(name string, uid, gid int) error {
		if uid != 1234 || gid != 5678 {
			t.Fatalf("chown uid/gid = %d/%d, want 1234/5678", uid, gid)
		}
		return errors.New("chown h boom")
	}
	removed := false
	guestRemove = func(string) error {
		removed = true
		return nil
	}

	h := NewHandler(time.Hour)
	_, err := h.handleWriteFile(&WriteFileRequest{
		Path:       filepath.Join(t.TempDir(), "out.txt"),
		Content:    []byte("payload"),
		OwnerUser:  "h-user",
		OwnerGroup: "h-group",
	})
	if err == nil || !strings.Contains(err.Error(), "chown temp file") {
		t.Fatalf("err = %v, want chown temp file", err)
	}
	if !removed {
		t.Fatal("temp file was not removed after chown failure")
	}
}

func TestHandler_H_CreatePersistentUnitSystemctlErrors(t *testing.T) {
	cases := []struct {
		name    string
		mode    string
		enable  bool
		wantSub string
	}{
		{name: "daemon_reload", mode: "daemon-fail", wantSub: "daemon-reload failed: reload boom"},
		{name: "enable", mode: "enable-fail", enable: true, wantSub: "enable unit failed: enable boom"},
		{name: "start", mode: "start-fail", enable: true, wantSub: "start unit failed: start boom"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			handlerHWithSystemdUnitPath(t)
			handlerHInstallSystemctl(t)
			t.Setenv("HANDLER_H_SYSTEMCTL_MODE", tc.mode)

			h := NewHandler(time.Hour)
			_, err := h.handleCreatePersistentUnit(context.Background(), &CreatePersistentUnitRequest{
				Name:   "h-persistent-" + tc.name,
				Exec:   []string{"/bin/true"},
				Enable: tc.enable,
			})
			if err == nil || !strings.Contains(err.Error(), tc.wantSub) {
				t.Fatalf("err = %v, want substring %q", err, tc.wantSub)
			}
		})
	}
}

func TestHandler_H_HandleRequestPersistentUnitSuccess(t *testing.T) {
	unitDir := handlerHWithSystemdUnitPath(t)
	argsFile := handlerHInstallSystemctl(t)

	h := NewHandler(time.Hour)
	resp := h.HandleRequest(context.Background(), &Request{
		ID:     "h-persist-ok",
		Method: MethodCreatePersistentUnit,
		Params: MarshalResult(CreatePersistentUnitRequest{
			Name:   "h-dispatch-persistent",
			Exec:   []string{"/bin/true"},
			Enable: true,
		}),
	})
	if resp.Error != "" || resp.ErrorCode != "" {
		t.Fatalf("HandleRequest error = %q/%q", resp.Error, resp.ErrorCode)
	}

	var result CreatePersistentUnitResponse
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		t.Fatalf("unmarshal result: %v", err)
	}
	if result.UnitName != "h-dispatch-persistent.service" || !result.Enabled || !result.Started {
		t.Fatalf("result = %+v, want enabled started h-dispatch-persistent.service", result)
	}

	unitBytes, err := os.ReadFile(filepath.Join(unitDir, "h-dispatch-persistent.service"))
	if err != nil {
		t.Fatalf("read unit file: %v", err)
	}
	if !strings.Contains(string(unitBytes), `ExecStart="/bin/true"`) {
		t.Fatalf("unit file %q missing ExecStart", string(unitBytes))
	}

	args := "\n" + handlerCovReadTrimmed(t, argsFile) + "\n"
	for _, want := range []string{"\ndaemon-reload\n", "\nenable\n", "\nh-dispatch-persistent.service\n", "\nstart\n"} {
		if !strings.Contains(args, want) {
			t.Fatalf("systemctl args %q missing %q", args, want)
		}
	}
}

func TestHandler_H_WriteDevtoolsSnapshotValidJSONUnmarshalError(t *testing.T) {
	payload := json.RawMessage(`{"n":1e1000000000}`)
	if !json.Valid(payload) {
		t.Fatal("test payload must be valid JSON")
	}

	h := NewHandler(time.Hour)
	_, err := h.handleWriteDevtoolsSnapshot(&WriteDevtoolsSnapshotRequest{
		SessionID: "h-session",
		Kind:      "tool_state",
		Payload:   payload,
	})
	if err == nil || !strings.Contains(err.Error(), "payload is not valid JSON:") {
		t.Fatalf("err = %v, want unmarshal JSON error", err)
	}
}

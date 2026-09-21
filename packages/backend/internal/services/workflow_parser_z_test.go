package services

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type workflowParserZTempFile struct {
	name     string
	writeErr error
	closeErr error
}

func (f *workflowParserZTempFile) Name() string { return f.name }

func (f *workflowParserZTempFile) Write([]byte) (int, error) {
	if f.writeErr != nil {
		return 0, f.writeErr
	}
	return 1, nil
}

func (f *workflowParserZTempFile) Close() error { return f.closeErr }

func TestWorkflowParser_Z_TempFileErrorBranches(t *testing.T) {
	oldCreateTemp := workflowParserCreateTemp
	oldRemove := workflowParserRemove
	t.Cleanup(func() {
		workflowParserCreateTemp = oldCreateTemp
		workflowParserRemove = oldRemove
	})
	workflowParserRemove = func(string) error { return nil }

	workflowParserCreateTemp = func(string, string) (workflowParserTempFile, error) {
		return nil, errors.New("create failed")
	}
	_, err := NewWorkflowParser(WithWorkflowParserRunner(&mockWorkflowParserRunner{})).Parse(context.Background(), "wf.tsx", []byte("x"))
	require.Error(t, err)
	assert.Contains(t, err.Error(), "create temp workflow file")

	workflowParserCreateTemp = func(string, string) (workflowParserTempFile, error) {
		return &workflowParserZTempFile{name: "wf.tsx", writeErr: errors.New("write failed")}, nil
	}
	_, err = NewWorkflowParser(WithWorkflowParserRunner(&mockWorkflowParserRunner{})).Parse(context.Background(), "wf.tsx", []byte("x"))
	require.Error(t, err)
	assert.Contains(t, err.Error(), "write temp workflow file")

	workflowParserCreateTemp = func(string, string) (workflowParserTempFile, error) {
		return &workflowParserZTempFile{name: "wf.tsx", closeErr: errors.New("close failed")}, nil
	}
	_, err = NewWorkflowParser(WithWorkflowParserRunner(&mockWorkflowParserRunner{})).Parse(context.Background(), "wf.ts", []byte("x"))
	require.Error(t, err)
	assert.Contains(t, err.Error(), "close temp workflow file")
}

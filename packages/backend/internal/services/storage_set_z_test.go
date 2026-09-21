package services

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestStorageSet_Z_TemplateInvalidHostBranches(t *testing.T) {
	assert.Equal(t, "http://[::1", BuildStorageSetResolverTemplate("http://[::1", "set-a"))
	assert.Equal(t, "http://:8080/repos", BuildStorageSetResolverTemplate("http://:8080/repos", "set-a"))
	assert.Equal(t, "http://user:pass@set-a.example.test:8080/repos", BuildStorageSetResolverTemplate("http://user:pass@set-a.example.test:8080/repos", "missing"))
	assert.Equal(t, "http://%s.example.test:8080/repos", BuildStorageSetResolverTemplate("http://user:pass@set-a.example.test:8080/repos", "set-a"))
}

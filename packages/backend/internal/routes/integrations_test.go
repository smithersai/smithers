package routes

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestIntegrationsHandler_GetMCPIntegrations(t *testing.T) {
	t.Parallel()

	h := NewIntegrationsHandler()
	req := httptest.NewRequest(http.MethodGet, "/api/integrations/mcp", nil)
	rec := httptest.NewRecorder()
	h.GetMCPIntegrations(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var items []IntegrationCatalogItem
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &items))
	assert.NotEmpty(t, items)

	// Verify github-sync is present
	var found bool
	for _, item := range items {
		if item.ID == "github-sync" {
			found = true
			assert.Equal(t, "GitHub Mirror", item.Name)
			assert.Equal(t, "sync-service", item.Kind)
			assert.True(t, item.Installed)
			break
		}
	}
	assert.True(t, found, "expected github-sync integration in response")
}

func TestIntegrationsHandler_GetMCPIntegrations_HasMCPServers(t *testing.T) {
	t.Parallel()

	h := NewIntegrationsHandler()
	req := httptest.NewRequest(http.MethodGet, "/api/integrations/mcp", nil)
	rec := httptest.NewRecorder()
	h.GetMCPIntegrations(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var items []IntegrationCatalogItem
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &items))

	var mcpCount int
	for _, item := range items {
		if item.Kind == "mcp-server" {
			mcpCount++
		}
	}
	assert.GreaterOrEqual(t, mcpCount, 2, "expected at least 2 MCP server integrations")
}

func TestIntegrationsHandler_GetSkills(t *testing.T) {
	t.Parallel()

	h := NewIntegrationsHandler()
	req := httptest.NewRequest(http.MethodGet, "/api/integrations/skills", nil)
	rec := httptest.NewRecorder()
	h.GetSkills(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var skills []map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &skills))
	assert.Empty(t, skills)
}

func TestIntegrationsHandler_GetSkills_ReturnsEmptyCatalog(t *testing.T) {
	t.Parallel()

	h := NewIntegrationsHandler()
	req := httptest.NewRequest(http.MethodGet, "/api/integrations/skills", nil)
	rec := httptest.NewRecorder()
	h.GetSkills(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var skills []map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &skills))
	assert.Empty(t, skills)
}

func TestIntegrationsHandler_GetMCPIntegrations_AllHaveRequiredFields(t *testing.T) {
	t.Parallel()

	h := NewIntegrationsHandler()
	req := httptest.NewRequest(http.MethodGet, "/api/integrations/mcp", nil)
	rec := httptest.NewRecorder()
	h.GetMCPIntegrations(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var items []IntegrationCatalogItem
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &items))

	for _, item := range items {
		assert.NotEmpty(t, item.ID, "each integration must have an ID")
		assert.NotEmpty(t, item.Name, "each integration must have a name")
		assert.NotEmpty(t, item.Kind, "each integration must have a kind")
		assert.NotEmpty(t, item.Capabilities, "each integration must have capabilities")
	}
}

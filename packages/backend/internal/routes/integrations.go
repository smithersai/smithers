package routes

import (
	"net/http"

	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type IntegrationsHandler struct{}

func NewIntegrationsHandler() *IntegrationsHandler {
	return &IntegrationsHandler{}
}

type IntegrationCatalogItem struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	Description  string   `json:"description"`
	Icon         string   `json:"icon"`
	Color        string   `json:"color"`
	Status       string   `json:"status"`
	Installed    bool     `json:"installed"`
	Kind         string   `json:"kind"`
	Route        string   `json:"route,omitempty"`
	Capabilities []string `json:"capabilities"`
}

func (h *IntegrationsHandler) GetMCPIntegrations(w http.ResponseWriter, r *http.Request) {
	mcpIntegrations := []IntegrationCatalogItem{
		{
			ID:           "github-sync",
			Name:         "GitHub Mirror",
			Description:  "Gitea-style repository mirroring between Smithers and a pre-provisioned GitHub repository using webhook-driven and scheduled `git fetch` / `git push --mirror` runs.",
			Icon:         "github",
			Color:        "text-primary",
			Status:       "Built In",
			Installed:    true,
			Kind:         "sync-service",
			Route:        "/integrations/github",
			Capabilities: []string{"Push mirror", "Refs and tags", "Webhook driven", "Scheduled sync"},
		},
		{
			ID:           "notion-sync",
			Name:         "Notion Sync",
			Description:  "Poll Notion pages and databases into a git-backed `notion/` tree inside the repository documents sidecar.",
			Icon:         "file-text",
			Color:        "text-cyan",
			Status:       "Built In",
			Installed:    true,
			Kind:         "sync-service",
			Route:        "/integrations/notion",
			Capabilities: []string{"Markdown export", "Docs sidecar", "SQLite mappings", "Polling"},
		},
		{
			ID:           "linear",
			Name:         "Linear Sync",
			Description:  "Sync Smithers issues and comments with Linear using the existing production integration flow.",
			Icon:         "check-square",
			Color:        "text-blue",
			Status:       "Configure",
			Installed:    true,
			Kind:         "sync-service",
			Route:        "/integrations/linear",
			Capabilities: []string{"Issues", "Comments", "OAuth", "Webhooks"},
		},
		{
			ID:           "github-mcp",
			Name:         "GitHub MCP",
			Description:  "Expose GitHub repositories and pull-request context directly to agents through MCP.",
			Icon:         "github",
			Color:        "text-primary",
			Status:       "Connected",
			Installed:    true,
			Kind:         "mcp-server",
			Capabilities: []string{"Agent context", "Repository access"},
		},
		{
			ID:           "notion-mcp",
			Name:         "Notion MCP",
			Description:  "Give agents live read access to Notion workspace content through the Notion MCP server.",
			Icon:         "file-text",
			Color:        "text-cyan",
			Status:       "Configure",
			Installed:    true,
			Kind:         "mcp-server",
			Capabilities: []string{"Agent context", "Workspace docs"},
		},
		{
			ID:           "postgres",
			Name:         "PostgreSQL",
			Description:  "Direct database access for agents to inspect schemas and analyze repository metadata.",
			Icon:         "database",
			Color:        "text-cyan",
			Status:       "Configure",
			Installed:    false,
			Kind:         "mcp-server",
			Capabilities: []string{"SQL", "Schema introspection"},
		},
	}
	errors.WriteJSON(w, http.StatusOK, mcpIntegrations)
}

func (h *IntegrationsHandler) GetSkills(w http.ResponseWriter, r *http.Request) {
	// No real skills catalog is built yet; return empty rather than fabricate one.
	errors.WriteJSON(w, http.StatusOK, []map[string]any{})
}

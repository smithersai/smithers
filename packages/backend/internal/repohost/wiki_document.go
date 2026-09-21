package repohost

import (
	"context"
	"fmt"
	"net/http"
	"time"
)

// WikiDocumentRequest is the internal Yjs v1 merge contract. Markdown is a
// pointer so a seed/replace with empty text remains distinct from an apply.
// No request chooses a filesystem path; the API service owns persistence.
type WikiDocumentRequest struct {
	Operation string  `json:"operation"`
	State     string  `json:"state,omitempty"`
	Update    string  `json:"update,omitempty"`
	Markdown  *string `json:"markdown,omitempty"`
}

type WikiDocumentResult struct {
	State       string `json:"state"`
	StateVector string `json:"state_vector"`
	Markdown    string `json:"markdown"`
}

func (c *Client) MergeWikiDocument(ctx context.Context, owner, repo string, input WikiDocumentRequest) (WikiDocumentResult, error) {
	defer c.observeOperationDuration("MergeWikiDocument", time.Now())
	baseURL, err := c.resolver.ResolveURL(ctx, owner, repo)
	if err != nil {
		return WikiDocumentResult{}, fmt.Errorf("resolve storage set url: %w", err)
	}
	var out WikiDocumentResult
	err = c.doJSON(ctx, http.MethodPost, repoByIDEndpoint(baseURL, owner, repo)+"/wiki/document",
		input, http.StatusOK, &out)
	return out, err
}

// WikiRevisionProjection is an immutable accepted page revision. The native
// sidecar writes one atomic JJ commit and recognizes retries by this receipt.
type WikiRevisionProjection struct {
	ID       int64  `json:"id"`
	PageID   int64  `json:"page_id"`
	Revision int64  `json:"revision"`
	Slug     string `json:"slug"`
	Title    string `json:"title"`
	Body     string `json:"body"`
	Author   string `json:"author"`
	Deleted  bool   `json:"deleted"`
}

func (c *Client) ProjectWikiRevision(ctx context.Context, owner, repo string, input WikiRevisionProjection) (string, error) {
	baseURL, err := c.resolver.ResolveURL(ctx, owner, repo)
	if err != nil {
		return "", fmt.Errorf("resolve storage set: %w", err)
	}
	var out wikiCommitResponse
	err = c.doJSON(ctx, http.MethodPost, repoByIDEndpoint(baseURL, owner, repo)+"/wiki/revisions", input, http.StatusOK, &out)
	return out.CommitSHA, err
}

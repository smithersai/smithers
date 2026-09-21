package repohost

import (
	"context"
	"net/http"
)

type AppendPreparationRequest struct {
	TargetBookmark     string `json:"target_bookmark"`
	ExpectedCommitID   string `json:"expected_commit_id"`
	SourceCommitID     string `json:"source_commit_id"`
	SourceBaseCommitID string `json:"source_base_commit_id"`
}
type AppendPreparation struct {
	Status string `json:"status"`
	AppendPreparationRequest
	Changes []Change `json:"changes"`
}

func (c *Client) PrepareLandAppend(ctx context.Context, owner, repo string, request AppendPreparationRequest) (AppendPreparation, error) {
	base, err := c.resolver.ResolveURL(ctx, owner, repo)
	if err != nil {
		return AppendPreparation{}, err
	}
	var result AppendPreparation
	err = c.doJSON(ctx, http.MethodPost, repoByIDEndpoint(base, owner, repo)+"/land/append/prepare", request, http.StatusOK, &result)
	return result, err
}

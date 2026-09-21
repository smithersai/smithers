package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"strings"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// GatewayWikiPublisher gives a gateway only the Wiki write authority of its
// owning user and repository. The guest never receives a general API token.
type GatewayWikiPublisher struct {
	gateway interface {
		AuthorizeRelay(context.Context, string, string) (RepoGatewayRelayTarget, error)
	}
	users interface {
		GetUserByIDNotDeleted(context.Context, int64) (db.User, error)
	}
	wiki *WikiService
}

func NewGatewayWikiPublisher(gateway *RepoGatewayService, users interface {
	GetUserByIDNotDeleted(context.Context, int64) (db.User, error)
}, wiki *WikiService) *GatewayWikiPublisher {
	return &GatewayWikiPublisher{gateway: gateway, users: users, wiki: wiki}
}

type GatewayWikiPage struct {
	ID    string `json:"id"`
	Path  string `json:"path"`
	Title string `json:"title"`
	Body  string `json:"body"`
}

type GatewayWikiPublishInput struct {
	Repo       string            `json:"repo"`
	SourceHead string            `json:"sourceHead"`
	Pages      []GatewayWikiPage `json:"pages"`
}

type GatewayWikiPublishedPage struct {
	ID   string `json:"id"`
	Slug string `json:"slug"`
}

type GatewayWikiPublishResult struct {
	Pages []GatewayWikiPublishedPage `json:"pages"`
}

func (s *GatewayWikiPublisher) Publish(ctx context.Context, gatewayID, token string, input GatewayWikiPublishInput) (GatewayWikiPublishResult, error) {
	target, err := s.gateway.AuthorizeRelay(ctx, gatewayID, token)
	if err != nil {
		return GatewayWikiPublishResult{}, err
	}
	owner, repo, found := strings.Cut(input.Repo, "/")
	if !found || owner == "" || repo == "" || strings.Contains(repo, "/") {
		return GatewayWikiPublishResult{}, pkgerrors.BadRequest("repo must be owner/name")
	}
	repository, err := s.wiki.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return GatewayWikiPublishResult{}, err
	}
	if repository.ID != target.RepositoryID {
		return GatewayWikiPublishResult{}, pkgerrors.Forbidden("gateway cannot publish to another repository")
	}
	actor, err := s.users.GetUserByIDNotDeleted(ctx, target.UserID)
	if err != nil {
		return GatewayWikiPublishResult{}, pkgerrors.Unauthorized("gateway user is unavailable")
	}
	if !actor.IsActive || actor.ProhibitLogin {
		return GatewayWikiPublishResult{}, pkgerrors.Unauthorized("gateway user is unavailable")
	}
	// Recheck current write permission even for an idempotent retry. The reaper
	// is asynchronous; revocation must take effect before it next visits the VM.
	if err := s.wiki.requireWriteAccess(ctx, repository, &actor); err != nil {
		return GatewayWikiPublishResult{}, err
	}
	head, err := hex.DecodeString(input.SourceHead)
	if err != nil || (len(head) != 20 && len(head) != 32) {
		return GatewayWikiPublishResult{}, pkgerrors.BadRequest("sourceHead must be a full Git commit hash")
	}
	if len(input.Pages) == 0 || len(input.Pages) > 200 {
		return GatewayWikiPublishResult{}, pkgerrors.BadRequest("publish between 1 and 200 wiki pages")
	}
	seen := make(map[string]bool, len(input.Pages))
	paths := make(map[string]bool, len(input.Pages))
	links := make([]string, 0, len(input.Pages)*2)
	for _, page := range input.Pages {
		if strings.TrimSpace(page.ID) == "" || len(page.ID) > 1024 || seen[page.ID] || len(page.Body) > maxWikiBodyBytes {
			return GatewayWikiPublishResult{}, pkgerrors.BadRequest("invalid or duplicate wiki page")
		}
		if _, err := normalizeWikiTitle(page.Title); err != nil {
			return GatewayWikiPublishResult{}, err
		}
		seen[page.ID] = true
		if page.Path != "" {
			if paths[page.Path] {
				return GatewayWikiPublishResult{}, pkgerrors.BadRequest("duplicate wiki page path")
			}
			paths[page.Path] = true
			links = append(links, "[["+page.Path+"]]", "[["+gatewayWikiSlug(input.SourceHead, page.ID)+"]]")
		}
	}
	linkRewriter := strings.NewReplacer(links...)
	result := GatewayWikiPublishResult{Pages: make([]GatewayWikiPublishedPage, 0, len(input.Pages))}
	for _, page := range input.Pages {
		slug := gatewayWikiSlug(input.SourceHead, page.ID)
		body := linkRewriter.Replace(page.Body)
		_, err := s.wiki.CreateWikiPage(ctx, &actor, owner, repo, CreateWikiPageInput{Slug: slug, Title: page.Title, Body: body})
		if err != nil {
			var apiErr *pkgerrors.APIError
			if !errors.As(err, &apiErr) || apiErr.Status != http.StatusConflict {
				return GatewayWikiPublishResult{}, err
			}
			existing, readErr := s.wiki.GetWikiPage(ctx, &actor, owner, repo, slug)
			if readErr != nil {
				return GatewayWikiPublishResult{}, readErr
			}
			if existing.Title != strings.TrimSpace(page.Title) || existing.Body != body {
				return GatewayWikiPublishResult{}, pkgerrors.Conflict("wiki source page already exists with different content")
			}
		}
		result.Pages = append(result.Pages, GatewayWikiPublishedPage{ID: page.ID, Slug: slug})
	}
	return result, nil
}

func gatewayWikiSlug(head, id string) string {
	digest := sha256.Sum256([]byte(id))
	return "source-" + strings.ToLower(head) + "-" + hex.EncodeToString(digest[:8])
}

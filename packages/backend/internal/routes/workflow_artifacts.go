package routes

import (
	"context"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type WorkflowArtifactRouteService interface {
	IssueUploadURL(ctx context.Context, run db.WorkflowRun, input services.WorkflowArtifactUploadInput) (services.WorkflowArtifactUploadResult, error)
	ConfirmUpload(ctx context.Context, run db.WorkflowRun, name, declaredSHA256 string) (db.WorkflowArtifact, error)
	ListArtifacts(ctx context.Context, repositoryID, runID int64) ([]db.WorkflowArtifact, error)
	GetDownloadURL(ctx context.Context, repositoryID, runID int64, name string) (services.WorkflowArtifactDownloadResult, error)
	DeleteArtifact(ctx context.Context, repositoryID, runID int64, name string) error
}

type WorkflowArtifactHandler struct {
	Service            WorkflowArtifactRouteService
	MaxUploadBodyBytes int64
}

type workflowArtifactUploadRequest struct {
	Name        string `json:"name"`
	Size        int64  `json:"size"`
	ContentType string `json:"content_type,omitempty"`
}

type workflowArtifactConfirmRequest struct {
	Name   string `json:"name"`
	SHA256 string `json:"sha256,omitempty"`
}

type workflowArtifactResponse struct {
	ID                int64      `json:"id"`
	RepositoryID      int64      `json:"repository_id"`
	WorkflowRunID     int64      `json:"workflow_run_id"`
	Name              string     `json:"name"`
	Size              int64      `json:"size"`
	ContentType       string     `json:"content_type"`
	Status            string     `json:"status"`
	ConfirmedAt       *time.Time `json:"confirmed_at,omitempty"`
	ExpiresAt         time.Time  `json:"expires_at"`
	ReleaseTag        *string    `json:"release_tag,omitempty"`
	ReleaseAssetName  *string    `json:"release_asset_name,omitempty"`
	ReleaseAttachedAt *time.Time `json:"release_attached_at,omitempty"`
	CreatedAt         time.Time  `json:"created_at"`
	UpdatedAt         time.Time  `json:"updated_at"`
}

type workflowArtifactUploadResponse struct {
	workflowArtifactResponse
	UploadURL     string            `json:"upload_url"`
	UploadHeaders map[string]string `json:"upload_headers,omitempty"`
}

type workflowArtifactDownloadResponse struct {
	workflowArtifactResponse
	DownloadURL string `json:"download_url"`
}

type listArtifactsResponse struct {
	Artifacts []workflowArtifactResponse `json:"artifacts"`
}

func toWorkflowArtifactResponse(artifact db.WorkflowArtifact) workflowArtifactResponse {
	resp := workflowArtifactResponse{
		ID:            artifact.ID,
		RepositoryID:  artifact.RepositoryID,
		WorkflowRunID: artifact.WorkflowRunID,
		Name:          artifact.Name,
		Size:          artifact.Size,
		ContentType:   artifact.ContentType,
		Status:        artifact.Status,
		ExpiresAt:     artifact.ExpiresAt,
		CreatedAt:     artifact.CreatedAt,
		UpdatedAt:     artifact.UpdatedAt,
	}
	if artifact.ConfirmedAt.Valid {
		t := artifact.ConfirmedAt.Time
		resp.ConfirmedAt = &t
	}
	if artifact.ReleaseTag.Valid {
		tag := artifact.ReleaseTag.String
		resp.ReleaseTag = &tag
	}
	if artifact.ReleaseAssetName.Valid {
		assetName := artifact.ReleaseAssetName.String
		resp.ReleaseAssetName = &assetName
	}
	if artifact.ReleaseAttachedAt.Valid {
		t := artifact.ReleaseAttachedAt.Time
		resp.ReleaseAttachedAt = &t
	}
	return resp
}

func (h *WorkflowArtifactHandler) PostInternalUploadURL(w http.ResponseWriter, r *http.Request) {
	if h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("workflow artifact service unavailable"))
		return
	}

	run, err := internalWorkflowRunForRequest(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, h.maxUploadBodyBytes())

	var req workflowArtifactUploadRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}

	result, err := h.Service.IssueUploadURL(r.Context(), *run, services.WorkflowArtifactUploadInput{
		Name:        req.Name,
		Size:        req.Size,
		ContentType: req.ContentType,
	})
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	pkgerrors.WriteJSON(w, http.StatusCreated, workflowArtifactUploadResponse{
		workflowArtifactResponse: toWorkflowArtifactResponse(result.Artifact),
		UploadURL:                result.UploadURL,
		UploadHeaders:            result.UploadHeaders,
	})
}

func (h *WorkflowArtifactHandler) maxUploadBodyBytes() int64 {
	if h.MaxUploadBodyBytes > 0 {
		return h.MaxUploadBodyBytes
	}
	return services.MaxWorkflowArtifactUploadSizeBytes
}

func (h *WorkflowArtifactHandler) PostInternalConfirm(w http.ResponseWriter, r *http.Request) {
	if h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("workflow artifact service unavailable"))
		return
	}

	run, err := internalWorkflowRunForRequest(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	var req workflowArtifactConfirmRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}

	artifact, err := h.Service.ConfirmUpload(r.Context(), *run, req.Name, req.SHA256)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	pkgerrors.WriteJSON(w, http.StatusOK, toWorkflowArtifactResponse(artifact))
}

func (h *WorkflowArtifactHandler) GetInternalDownloadURL(w http.ResponseWriter, r *http.Request) {
	if h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("workflow artifact service unavailable"))
		return
	}

	run, err := internalWorkflowRunForRequest(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	name := chi.URLParam(r, "name")
	if name == "" {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("artifact name is required"))
		return
	}

	result, err := h.Service.GetDownloadURL(r.Context(), run.RepositoryID, run.ID, name)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	pkgerrors.WriteJSON(w, http.StatusOK, workflowArtifactDownloadResponse{
		workflowArtifactResponse: toWorkflowArtifactResponse(result.Artifact),
		DownloadURL:              result.DownloadURL,
	})
}

func (h *WorkflowArtifactHandler) ListArtifacts(w http.ResponseWriter, r *http.Request) {
	if h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("workflow artifact service unavailable"))
		return
	}

	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("repository context not loaded"))
		return
	}

	runID, err := parseWorkflowArtifactRunID(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	artifacts, err := h.Service.ListArtifacts(r.Context(), repoCtx.Repository.ID, runID)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	response := listArtifactsResponse{Artifacts: make([]workflowArtifactResponse, len(artifacts))}
	for i, artifact := range artifacts {
		response.Artifacts[i] = toWorkflowArtifactResponse(artifact)
	}
	pkgerrors.WriteJSON(w, http.StatusOK, response)
}

func (h *WorkflowArtifactHandler) GetDownloadURL(w http.ResponseWriter, r *http.Request) {
	if h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("workflow artifact service unavailable"))
		return
	}

	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("repository context not loaded"))
		return
	}

	runID, err := parseWorkflowArtifactRunID(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	name := chi.URLParam(r, "name")
	if name == "" {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("artifact name is required"))
		return
	}

	result, err := h.Service.GetDownloadURL(r.Context(), repoCtx.Repository.ID, runID, name)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	pkgerrors.WriteJSON(w, http.StatusOK, workflowArtifactDownloadResponse{
		workflowArtifactResponse: toWorkflowArtifactResponse(result.Artifact),
		DownloadURL:              result.DownloadURL,
	})
}

func (h *WorkflowArtifactHandler) DeleteArtifact(w http.ResponseWriter, r *http.Request) {
	if h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("workflow artifact service unavailable"))
		return
	}

	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("repository context not loaded"))
		return
	}

	runID, err := parseWorkflowArtifactRunID(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	name := chi.URLParam(r, "name")
	if name == "" {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("artifact name is required"))
		return
	}

	if err := h.Service.DeleteArtifact(r.Context(), repoCtx.Repository.ID, runID, name); err != nil {
		writeRouteError(w, r, err)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

func parseWorkflowArtifactRunID(r *http.Request) (int64, error) {
	rawID := chi.URLParam(r, "id")
	runID, err := strconv.ParseInt(rawID, 10, 64)
	if err != nil || runID <= 0 {
		return 0, pkgerrors.BadRequest("invalid run id")
	}
	return runID, nil
}

func internalWorkflowRunForRequest(r *http.Request) (*db.WorkflowRun, error) {
	run := middleware.WorkflowRunFromContext(r.Context())
	if run == nil {
		return nil, pkgerrors.Internal("workflow run context not loaded")
	}

	runID, err := parseWorkflowArtifactRunID(r)
	if err != nil {
		return nil, err
	}
	if run.ID != runID {
		return nil, pkgerrors.Forbidden("workflow run token is not authorized for this run")
	}
	return run, nil
}

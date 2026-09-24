package compose

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type repositorySetupAPI struct {
	repos *services.RepoService
	setup *services.RepositorySetupService
}

func (api *repositorySetupAPI) serve(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user := middleware.UserFromContext(r.Context())
	if user == nil {
		pkgerrors.WriteError(w, pkgerrors.Unauthorized("Sign in to configure repository jobs"))
		return
	}
	part := strings.TrimPrefix(r.URL.Path, "/api/repository-setup/")
	repo, job, requestID := r.URL.Query().Get("repo"), r.URL.Query().Get("job"), r.URL.Query().Get("requestId")
	var input services.SetupInput
	if r.Method == http.MethodPost {
		if !services.SetupOperationValid(part) {
			pkgerrors.WriteError(w, pkgerrors.NotFound("Unknown setup operation"))
			return
		}
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64000))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&input) != nil || decoder.Decode(new(any)) != io.EOF {
			pkgerrors.WriteError(w, pkgerrors.BadRequest("Invalid setup draft"))
			return
		}
		input.Operation = part
		if err := services.ValidateSetupInput(&input); err != nil {
			pkgerrors.WriteError(w, pkgerrors.BadRequest(err.Error()))
			return
		}
		repo, job = input.Repo, input.Job
	} else if r.Method != http.MethodGet || !((part == "state") || (part == "request" || part == "observe") && services.SetupRequestIDValid(requestID)) {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("Choose a setup request"))
		return
	}
	if !services.SetupRepoValid(repo) || !services.SetupJobValid(job) {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("Choose a repository setup"))
		return
	}
	owner, name, _ := strings.Cut(repo, "/")
	view, err := api.repos.GetRepoView(r.Context(), user, owner, name)
	if err != nil || r.Method == http.MethodPost && !view.CanWrite {
		pkgerrors.WriteError(w, pkgerrors.NotFound("Repository unavailable"))
		return
	}
	if part == "state" {
		result, err := api.setup.Recover(r.Context(), view.Repository.ID, user.ID, user.Username, repo, job)
		if err != nil {
			repositorySetupError(w, err)
			return
		}
		pkgerrors.WriteJSON(w, http.StatusOK, result)
		return
	}
	var record services.SetupRecord
	if r.Method == http.MethodPost {
		record, err = api.setup.Request(r.Context(), view.Repository.ID, user.ID, input)
	} else {
		record, err = api.setup.Read(r.Context(), view.Repository.ID, user.ID, repo, job, requestID)
	}
	if err != nil {
		repositorySetupError(w, err)
		return
	}
	if record.ObservationError != "" {
		pkgerrors.WriteError(w, pkgerrors.New(pkgerrors.CodeServiceUnavailable, record.ObservationError))
		return
	}
	status := http.StatusAccepted
	if record.Terminal {
		status = http.StatusOK
	}
	pkgerrors.WriteJSON(w, status, record.Response)
}

func repositorySetupError(w http.ResponseWriter, err error) {
	var apiError *pkgerrors.APIError
	if errors.As(err, &apiError) {
		pkgerrors.WriteError(w, apiError)
		return
	}
	pkgerrors.WriteError(w, pkgerrors.Internal("Repository setup unavailable"))
}

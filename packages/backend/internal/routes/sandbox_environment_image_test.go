package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type fakeEnvironmentImageRouteService struct {
	registered []services.RegisterSandboxEnvironmentImageInput
}

func (f *fakeEnvironmentImageRouteService) Register(_ context.Context, input services.RegisterSandboxEnvironmentImageInput) (services.SandboxEnvironmentImageResponse, error) {
	f.registered = append(f.registered, input)
	return services.SandboxEnvironmentImageResponse{ID: "image-id", RepositoryID: input.RepositoryID, Kind: input.Kind}, nil
}

func (*fakeEnvironmentImageRouteService) List(context.Context, int64) ([]services.SandboxEnvironmentImageResponse, error) {
	return nil, nil
}

func (*fakeEnvironmentImageRouteService) Retire(context.Context, int64, string) (services.SandboxEnvironmentImageResponse, error) {
	return services.SandboxEnvironmentImageResponse{}, nil
}

func TestSandboxEnvironmentImageHandlerRegisterBaseImageUsesPlatformScope(t *testing.T) {
	service := &fakeEnvironmentImageRouteService{}
	handler := &SandboxEnvironmentImageHandler{Service: service}
	body := `{"kind":"vm","closure_hash":"0123456789abcdefghijklmnopqrstuv","image":"registry/base:0123456789abcdefghijklmnopqrstuv"}`
	request := withAuth(httptest.NewRequest(http.MethodPost, "/api/admin/sandbox/environment-images", strings.NewReader(body)), 19, "admin")
	recorder := httptest.NewRecorder()

	handler.RegisterBaseImage(recorder, request)

	require.Equal(t, http.StatusCreated, recorder.Code)
	require.Len(t, service.registered, 1)
	assert.Zero(t, service.registered[0].RepositoryID)
	assert.Equal(t, int64(19), service.registered[0].CreatedBy)
}

func TestSandboxEnvironmentImageHandlerRegisterRepoImageUsesRouteRepository(t *testing.T) {
	service := &fakeEnvironmentImageRouteService{}
	handler := &SandboxEnvironmentImageHandler{Service: service}
	body := `{"kind":"desktop","closure_hash":"0123456789abcdefghijklmnopqrstuv","image":"registry/repo:0123456789abcdefghijklmnopqrstuv"}`
	request := withAuth(httptest.NewRequest(http.MethodPost, "/api/repos/acme/widgets/environment-images", strings.NewReader(body)), 7, "owner")
	request = request.WithContext(middleware.ContextWithRepoContext(request.Context(), &middleware.RepoContext{
		Owner: "acme", Repository: &db.Repository{ID: 42, Name: "widgets"},
	}, middleware.PermissionAdmin))
	recorder := httptest.NewRecorder()

	handler.RegisterRepoImage(recorder, request)

	require.Equal(t, http.StatusCreated, recorder.Code)
	require.Len(t, service.registered, 1)
	assert.Equal(t, int64(42), service.registered[0].RepositoryID)
	assert.Equal(t, int64(7), service.registered[0].CreatedBy)
}

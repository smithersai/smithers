package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/go-chi/chi/v5"
	chiMiddleware "github.com/go-chi/chi/v5/middleware"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/database"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	processruntime "github.com/smithersai/smithers/packages/backend/process"
)

const workspacePreviewHelperEnv = "SMITHERS_WORKSPACE_PREVIEW_HELPER"

type processWorkspaceUser struct {
	ID       int64
	Username string
}

type processWorkspaceRepo struct {
	ID    int64
	Owner string
	Name  string
}

func TestWorkspaceRuntimeProcessRequestPath(t *testing.T) {
	if address := os.Getenv(workspacePreviewHelperEnv); address != "" {
		server := &http.Server{Addr: address, Handler: http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
			if request.Header.Get("Authorization") != "" || request.Header.Get("Cookie") != "" {
				http.Error(response, "product credentials reached preview", http.StatusInternalServerError)
				return
			}
			_, _ = response.Write([]byte("preview-ok\n"))
		})}
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			os.Exit(2)
		}
		return
	}

	pool := setupProcessWorkspacePool(t)
	queries := db.New(pool)
	user := processWorkspaceCreateUser(t, pool, "process_workspace_user")
	repo := processWorkspaceCreateRepo(t, pool, user, "process_workspace_repo", false)

	runtime, err := processruntime.New(processruntime.Config{Root: t.TempDir(), MaxConcurrent: 4})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, runtime.Close()) })
	service := services.NewWorkspaceService(queries, services.WithWorkspaceRuntime(runtime))
	workspaceHandler := &WorkspaceHandler{Service: service}
	terminalHandler := &WorkspaceTerminalHandler{Service: service, AllowedOrigins: []string{"https://smithers.test"}}
	t.Cleanup(func() {
		if terminalHandler.TerminalSessions != nil {
			terminalHandler.TerminalSessions.Close()
		}
	})

	router := chi.NewRouter()
	router.Use(chiMiddleware.RequestID)
	router.Use(middleware.AuthLoader(queries, config.AuthConfig{}))
	router.Route("/api/repos/{owner}/{repo}", func(router chi.Router) {
		router.Use(middleware.LoadRepoContext(queries))
		read := []func(http.Handler) http.Handler{
			middleware.RequireAuth,
			middleware.RequireScope(middleware.ScopeReadRepository),
			middleware.RequireRepoPermission(middleware.PermissionRead),
		}
		write := []func(http.Handler) http.Handler{
			middleware.RequireAuth,
			middleware.RequireScope(middleware.ScopeWriteRepository),
			middleware.RequireRepoPermission(middleware.PermissionWrite),
		}
		router.With(write...).Post("/workspaces", workspaceHandler.CreateWorkspace)
		router.With(write...).Post("/workspaces/{id}/suspend", workspaceHandler.SuspendWorkspace)
		router.With(write...).Post("/workspaces/{id}/resume", workspaceHandler.ResumeWorkspace)
		router.With(write...).Put("/workspaces/{id}/files/content", workspaceHandler.WriteWorkspaceFile)
		router.With(read...).Get("/workspaces/{id}/files/content", workspaceHandler.ReadWorkspaceFile)
		RegisterWorkspaceRuntimeRoutes(router, workspaceHandler, read, write)
		router.With(write...).Post("/workspace/sessions", workspaceHandler.CreateSession)
		router.With(read...).Get("/workspace/sessions/{id}/terminal", terminalHandler.TerminalWebSocket)
	})

	server := httptest.NewServer(router)
	t.Cleanup(server.Close)
	basePath := fmt.Sprintf("/api/repos/%s/%s", repo.Owner, repo.Name)

	// The same middleware stack rejects the execution path before the runtime
	// can observe an unauthenticated request.
	unauthorized := processWorkspaceDoRequest(t, server.Client(), server.URL, http.MethodPost, basePath+"/workspaces/missing/commands", []byte(`{"operation_id":"unauthorized","args":["/bin/true"]}`))
	require.Equal(t, http.StatusUnauthorized, unauthorized.StatusCode)
	_ = processWorkspaceReadBody(t, unauthorized)

	cookie := processWorkspaceCreateSessionCookie(t, queries, user)
	client := processWorkspaceAuthenticatedClient(t, server, cookie)
	createdResponse := processWorkspaceDoRequest(t, client, server.URL, http.MethodPost, basePath+"/workspaces", []byte(`{"name":"local-process"}`))
	require.Equal(t, http.StatusAccepted, createdResponse.StatusCode)
	var created services.WorkspaceResponse
	processWorkspaceDecodeJSON(t, createdResponse, &created)
	require.NotEmpty(t, created.ID)
	require.Empty(t, created.VMID, "trusted process execution must not be presented as a VM")
	require.Equal(t, "trusted_process", string(created.Isolation))
	waitForRuntimeWorkspaceStatus(t, queries, created.ID, "running")

	commandResponse := processWorkspaceDoRequest(t, client, server.URL, http.MethodPost, basePath+"/workspaces/"+created.ID+"/commands", []byte(`{"operation_id":"command-1","args":["/bin/sh","-c","printf command-ok"]}`))
	require.Equal(t, http.StatusOK, commandResponse.StatusCode)
	var command services.WorkspaceCommandResult
	processWorkspaceDecodeJSON(t, commandResponse, &command)
	require.Equal(t, 0, command.ExitCode)
	require.Equal(t, "command-ok", command.Stdout)

	writeResponse := processWorkspaceDoRequest(t, client, server.URL, http.MethodPut, basePath+"/workspaces/"+created.ID+"/files/content?path=note.txt", []byte(`{"content":"persisted-local-file"}`))
	require.Equal(t, http.StatusOK, writeResponse.StatusCode)
	_ = processWorkspaceReadBody(t, writeResponse)
	readResponse := processWorkspaceDoRequest(t, client, server.URL, http.MethodGet, basePath+"/workspaces/"+created.ID+"/files/content?path=note.txt", nil)
	require.Equal(t, http.StatusOK, readResponse.StatusCode)
	var file services.WorkspaceFileContent
	processWorkspaceDecodeJSON(t, readResponse, &file)
	require.Equal(t, "persisted-local-file", file.Content)

	suspendResponse := processWorkspaceDoRequest(t, client, server.URL, http.MethodPost, basePath+"/workspaces/"+created.ID+"/suspend", nil)
	require.Equal(t, http.StatusOK, suspendResponse.StatusCode)
	var suspended services.WorkspaceResponse
	processWorkspaceDecodeJSON(t, suspendResponse, &suspended)
	require.Equal(t, "suspended", suspended.Status)
	stoppedRuntime, err := runtime.InspectWorkspace(context.Background(), created.ID)
	require.NoError(t, err)
	require.Equal(t, "stopped", string(stoppedRuntime.State))

	resumeResponse := processWorkspaceDoRequest(t, client, server.URL, http.MethodPost, basePath+"/workspaces/"+created.ID+"/resume", nil)
	require.Equal(t, http.StatusOK, resumeResponse.StatusCode)
	var resumed services.WorkspaceResponse
	processWorkspaceDecodeJSON(t, resumeResponse, &resumed)
	require.Equal(t, "running", resumed.Status)
	readAfterResume := processWorkspaceDoRequest(t, client, server.URL, http.MethodGet, basePath+"/workspaces/"+created.ID+"/files/content?path=note.txt", nil)
	require.Equal(t, http.StatusOK, readAfterResume.StatusCode)
	processWorkspaceDecodeJSON(t, readAfterResume, &file)
	require.Equal(t, "persisted-local-file", file.Content)

	previewAddress := reserveLoopbackAddress(t)
	_, rawPort, err := net.SplitHostPort(previewAddress)
	require.NoError(t, err)
	port, err := strconv.ParseUint(rawPort, 10, 16)
	require.NoError(t, err)
	launchBody, err := json.Marshal(services.WorkspaceServiceLaunchInput{
		OperationID: "preview-service-1",
		Name:        "preview",
		Args:        []string{os.Args[0], "-test.run=^TestWorkspaceRuntimeProcessRequestPath$"},
		Environment: map[string]string{workspacePreviewHelperEnv: previewAddress},
		Port:        uint16(port),
	})
	require.NoError(t, err)
	launchResponse := processWorkspaceDoRequest(t, client, server.URL, http.MethodPost, basePath+"/workspaces/"+created.ID+"/services", launchBody)
	require.Equal(t, http.StatusCreated, launchResponse.StatusCode, string(routesIntegrationReadBodyOnFailure(t, launchResponse)))
	if launchResponse.Body != nil {
		_ = launchResponse.Body.Close()
	}
	previewResponse := processWorkspaceDoRequest(t, client, server.URL, http.MethodGet, basePath+"/workspaces/"+created.ID+"/preview/"+rawPort+"/", nil)
	require.Equal(t, http.StatusOK, previewResponse.StatusCode)
	require.Equal(t, "preview-ok\n", string(processWorkspaceReadBody(t, previewResponse)))

	sessionResponse := processWorkspaceDoRequest(t, client, server.URL, http.MethodPost, basePath+"/workspace/sessions", []byte(`{"workspace_id":"`+created.ID+`","cols":90,"rows":30}`))
	require.Equal(t, http.StatusCreated, sessionResponse.StatusCode)
	var session services.WorkspaceSessionResponse
	processWorkspaceDecodeJSON(t, sessionResponse, &session)
	require.Equal(t, "running", session.Status)

	terminalURL := "ws" + strings.TrimPrefix(server.URL, "http") + basePath + "/workspace/sessions/" + session.ID + "/terminal"
	header := http.Header{}
	header.Set("Origin", "https://smithers.test")
	header.Set("Cookie", cookie.String())
	terminal, response, err := websocket.Dial(context.Background(), terminalURL, &websocket.DialOptions{HTTPHeader: header, Subprotocols: []string{"terminal"}})
	if response != nil && response.Body != nil {
		defer response.Body.Close()
	}
	require.NoError(t, err)
	defer terminal.CloseNow()
	require.NoError(t, terminal.Write(context.Background(), websocket.MessageBinary, []byte("printf 'terminal-ok\\n'\n")))
	readCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var terminalOutput strings.Builder
	for !strings.Contains(terminalOutput.String(), "terminal-ok") {
		_, frame, readErr := terminal.Read(readCtx)
		require.NoError(t, readErr)
		terminalOutput.Write(frame)
	}
}

func waitForRuntimeWorkspaceStatus(t *testing.T, queries *db.Queries, workspaceID, want string) db.Workspace {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		row, err := queries.GetWorkspace(context.Background(), workspaceID)
		require.NoError(t, err)
		if row.Status == want {
			return row
		}
		if row.Status == "failed" || time.Now().After(deadline) {
			t.Fatalf("workspace status = %q; want %q", row.Status, want)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func reserveLoopbackAddress(t *testing.T) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	address := listener.Addr().String()
	require.NoError(t, listener.Close())
	return address
}

func routesIntegrationReadBodyOnFailure(t *testing.T, response *http.Response) []byte {
	t.Helper()
	if response.StatusCode >= 200 && response.StatusCode < 300 {
		return nil
	}
	return processWorkspaceReadBody(t, response)
}

func setupProcessWorkspacePool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	databaseURL := strings.TrimSpace(os.Getenv("SMITHERS_PROCESS_RUNTIME_TEST_DATABASE_URL"))
	if databaseURL == "" {
		t.Skip("SMITHERS_PROCESS_RUNTIME_TEST_DATABASE_URL is required for the process workspace request-path test")
	}
	parsed, err := url.Parse(databaseURL)
	require.NoError(t, err)
	databaseName := strings.TrimPrefix(parsed.Path, "/")
	require.NotEmpty(t, databaseName)
	adminURL := *parsed
	adminURL.Path = "/postgres"
	admin, err := pgx.Connect(context.Background(), adminURL.String())
	require.NoError(t, err)
	defer admin.Close(context.Background())
	var exists bool
	require.NoError(t, admin.QueryRow(context.Background(), `SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1)`, databaseName).Scan(&exists))
	if !exists {
		_, err = admin.Exec(context.Background(), `CREATE DATABASE "`+strings.ReplaceAll(databaseName, `"`, `""`)+`"`)
		require.NoError(t, err)
	}

	connection, err := pgx.Connect(context.Background(), databaseURL)
	require.NoError(t, err)
	defer connection.Close(context.Background())
	_, err = connection.Exec(context.Background(), `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()`)
	require.NoError(t, err)
	schema, err := os.ReadFile(filepath.Join("..", "..", "db", "schema.sql"))
	require.NoError(t, err)
	_, err = connection.Exec(context.Background(), "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;\n"+string(schema))
	require.NoError(t, err)

	poolConfig, err := pgxpool.ParseConfig(databaseURL)
	require.NoError(t, err)
	poolConfig.AfterConnect = func(_ context.Context, connection *pgx.Conn) error {
		database.ConfigureSQLCTypes(connection.TypeMap())
		return nil
	}
	pool, err := pgxpool.NewWithConfig(context.Background(), poolConfig)
	require.NoError(t, err)
	t.Cleanup(pool.Close)
	return pool
}

func processWorkspaceCreateUser(t *testing.T, pool *pgxpool.Pool, prefix string) processWorkspaceUser {
	t.Helper()
	unique := strings.ToLower(strings.ReplaceAll(uuid.NewString(), "-", ""))[:12]
	username := prefix + "_" + unique
	var id int64
	err := pool.QueryRow(context.Background(), `INSERT INTO users (username, lower_username, email, lower_email, display_name) VALUES ($1,$1,$2,$2,$1) RETURNING id`, username, username+"@example.com").Scan(&id)
	require.NoError(t, err)
	return processWorkspaceUser{ID: id, Username: username}
}

func processWorkspaceCreateRepo(t *testing.T, pool *pgxpool.Pool, owner processWorkspaceUser, prefix string, public bool) processWorkspaceRepo {
	t.Helper()
	unique := strings.ToLower(strings.ReplaceAll(uuid.NewString(), "-", ""))[:12]
	name := prefix + "_" + unique
	var id int64
	err := pool.QueryRow(context.Background(), `INSERT INTO repositories (user_id,name,lower_name,description,storage_set_id,is_public,default_bookmark,next_issue_number,next_landing_number) VALUES ($1,$2,$2,'','s1',$3,'main',1,1) RETURNING id`, owner.ID, name, public).Scan(&id)
	require.NoError(t, err)
	return processWorkspaceRepo{ID: id, Owner: owner.Username, Name: name}
}

func processWorkspaceCreateSessionCookie(t *testing.T, queries *db.Queries, user processWorkspaceUser) *http.Cookie {
	t.Helper()
	session, err := queries.CreateAuthSession(context.Background(), db.CreateAuthSessionParams{
		SessionKey: uuid.NewString(), UserID: user.ID, Username: user.Username, ExpiresAt: time.Now().Add(24 * time.Hour),
	})
	require.NoError(t, err)
	return &http.Cookie{Name: "smithers_session", Value: session.SessionKey, Path: "/"}
}

func processWorkspaceAuthenticatedClient(t *testing.T, server *httptest.Server, cookie *http.Cookie) *http.Client {
	t.Helper()
	jar, err := cookiejar.New(nil)
	require.NoError(t, err)
	base, err := url.Parse(server.URL)
	require.NoError(t, err)
	jar.SetCookies(base, []*http.Cookie{cookie})
	client := *server.Client()
	client.Jar = jar
	return &client
}

func processWorkspaceDoRequest(t *testing.T, client *http.Client, baseURL, method, path string, body []byte) *http.Response {
	t.Helper()
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	request, err := http.NewRequest(method, baseURL+path, reader)
	require.NoError(t, err)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := client.Do(request)
	require.NoError(t, err)
	return response
}

func processWorkspaceReadBody(t *testing.T, response *http.Response) []byte {
	t.Helper()
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	require.NoError(t, err)
	return body
}

func processWorkspaceDecodeJSON(t *testing.T, response *http.Response, target any) {
	t.Helper()
	defer response.Body.Close()
	require.NoError(t, json.NewDecoder(response.Body).Decode(target))
}

package repohostffi

/*
#cgo linux LDFLAGS: -ldl
#include <dlfcn.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

typedef char* (*smithers_init_repo_fn)(const char*);
typedef char* (*smithers_auto_init_repo_fn)(const char*, const char*, const char*);
typedef char* (*smithers_delete_repo_fn)(const char*);
typedef char* (*smithers_import_git_refs_fn)(const char*);
typedef char* (*smithers_export_git_refs_fn)(const char*);
typedef char* (*smithers_init_wiki_repo_fn)(const char*);
typedef char* (*smithers_wiki_document_fn)(const char*);
typedef char* (*smithers_project_wiki_revision_fn)(const char*, const char*);
typedef char* (*smithers_init_docs_repo_fn)(const char*);
typedef char* (*smithers_commit_wiki_page_fn)(const char*, const char*, const char*, const char*, const char*, const char*);
typedef char* (*smithers_commit_doc_fn)(const char*, const char*, const char*, const char*, const char*, const char*);
typedef char* (*smithers_get_wiki_page_content_fn)(const char*, const char*, const char*);
typedef char* (*smithers_get_doc_content_fn)(const char*, const char*, const char*);
typedef char* (*smithers_list_wiki_page_history_fn)(const char*, const char*, uint32_t);
typedef char* (*smithers_list_doc_history_fn)(const char*, const char*, uint32_t);
typedef char* (*smithers_delete_wiki_page_fn)(const char*, const char*, const char*, const char*);
typedef char* (*smithers_delete_doc_fn)(const char*, const char*, const char*, const char*);
typedef char* (*smithers_list_changes_fn)(const char*, uint32_t, uint32_t);
typedef char* (*smithers_get_change_fn)(const char*, const char*);
typedef char* (*smithers_backout_change_fn)(const char*, const char*, const char*, const char*);
typedef char* (*smithers_split_change_fn)(const char*, const char*, const char*, const char*);
typedef char* (*smithers_get_diff_fn)(const char*, const char*);
typedef char* (*smithers_get_revision_diff_fn)(const char*, const char*, const char*, const char*);
typedef char* (*smithers_get_files_fn)(const char*, const char*);
typedef char* (*smithers_list_tree_files_fn)(const char*, const char*, const char*);
typedef char* (*smithers_list_directory_fn)(const char*, const char*, const char*, const char*, uint32_t);
typedef char* (*smithers_get_conflicts_fn)(const char*, const char*);
typedef char* (*smithers_land_changes_fn)(const char*, const char*);
typedef char* (*smithers_land_change_fn)(const char*, const char*, const char*);
typedef char* (*smithers_list_bookmarks_fn)(const char*, uint32_t, uint32_t);
typedef char* (*smithers_create_bookmark_fn)(const char*, const char*, const char*);
typedef char* (*smithers_create_bookmark_if_absent_fn)(const char*, const char*, const char*);
typedef char* (*smithers_delete_bookmark_fn)(const char*, const char*);
typedef char* (*smithers_get_file_content_fn)(const char*, const char*, const char*);
typedef char* (*smithers_create_snapshot_fn)(const char*, const char*);
typedef char* (*smithers_list_operations_fn)(const char*, uint32_t, uint32_t);
typedef char* (*smithers_get_working_tree_status_fn)(const char*);
typedef char* (*smithers_compose_superproject_fn)(const char*, const char*);
typedef char* (*smithers_read_superproject_fn)(const char*, const char*);
typedef void (*smithers_free_string_fn)(char*);

static void *smithers_handle = NULL;
static const char *smithers_last_error = NULL;
static __thread char smithers_last_error_buf[256];

static int smithers_load_library(const char *path) {
	if (smithers_handle != NULL) {
		return 0;
	}
	if (path == NULL || path[0] == '\0') {
		smithers_last_error = "smithers ffi library path is empty";
		return -1;
	}
	smithers_handle = dlopen(path, RTLD_NOW | RTLD_LOCAL);
	if (smithers_handle == NULL) {
		const char *e = dlerror();
		snprintf(smithers_last_error_buf, sizeof smithers_last_error_buf, "%s", e ? e : "unknown");
		smithers_last_error = smithers_last_error_buf;
		return -1;
	}
	return 0;
}

static const char *smithers_last_error_message(void) {
	return smithers_last_error;
}

static void *smithers_lookup_symbol(const char *name) {
	void *sym;
	const char *err;

	if (smithers_handle == NULL) {
		smithers_last_error = "smithers ffi library is not loaded";
		return NULL;
	}

	dlerror();
	sym = dlsym(smithers_handle, name);
	err = dlerror();
	if (err != NULL) {
		snprintf(smithers_last_error_buf, sizeof smithers_last_error_buf, "%s", err);
		smithers_last_error = smithers_last_error_buf;
		return NULL;
	}
	return sym;
}

static char *smithers_call_init_repo(const char *store_path) {
	smithers_init_repo_fn fn = (smithers_init_repo_fn)smithers_lookup_symbol("smithers_init_repo");
	return fn == NULL ? NULL : fn(store_path);
}

static char *smithers_call_project_wiki_revision(const char *path, const char *json) {
 smithers_project_wiki_revision_fn fn = (smithers_project_wiki_revision_fn)smithers_lookup_symbol("smithers_project_wiki_revision");
 return fn == NULL ? NULL : fn(path, json);
}

static char *smithers_call_wiki_document(const char *request_json) {
	smithers_wiki_document_fn fn = (smithers_wiki_document_fn)smithers_lookup_symbol("smithers_wiki_document");
	return fn == NULL ? NULL : fn(request_json);
}

static char *smithers_call_auto_init_repo(const char *store_path, const char *bookmark_name, const char *repo_name) {
	smithers_auto_init_repo_fn fn = (smithers_auto_init_repo_fn)smithers_lookup_symbol("smithers_auto_init_repo");
	return fn == NULL ? NULL : fn(store_path, bookmark_name, repo_name);
}

static char *smithers_call_delete_repo(const char *store_path) {
	smithers_delete_repo_fn fn = (smithers_delete_repo_fn)smithers_lookup_symbol("smithers_delete_repo");
	return fn == NULL ? NULL : fn(store_path);
}

static char *smithers_call_import_git_refs(const char *store_path) {
	smithers_import_git_refs_fn fn = (smithers_import_git_refs_fn)smithers_lookup_symbol("smithers_import_git_refs");
	return fn == NULL ? NULL : fn(store_path);
}

static char *smithers_call_export_git_refs(const char *store_path) {
	smithers_export_git_refs_fn fn = (smithers_export_git_refs_fn)smithers_lookup_symbol("smithers_export_git_refs");
	return fn == NULL ? NULL : fn(store_path);
}

static char *smithers_call_init_wiki_repo(const char *store_path) {
	smithers_init_wiki_repo_fn fn = (smithers_init_wiki_repo_fn)smithers_lookup_symbol("smithers_init_wiki_repo");
	return fn == NULL ? NULL : fn(store_path);
}

static char *smithers_call_init_docs_repo(const char *store_path) {
	smithers_init_docs_repo_fn fn = (smithers_init_docs_repo_fn)smithers_lookup_symbol("smithers_init_docs_repo");
	return fn == NULL ? NULL : fn(store_path);
}

static char *smithers_call_commit_wiki_page(
	const char *store_path,
	const char *page_name,
	const char *content,
	const char *author_name,
	const char *author_email,
	const char *message
) {
	smithers_commit_wiki_page_fn fn = (smithers_commit_wiki_page_fn)smithers_lookup_symbol("smithers_commit_wiki_page");
	return fn == NULL ? NULL : fn(store_path, page_name, content, author_name, author_email, message);
}

static char *smithers_call_commit_doc(
	const char *store_path,
	const char *file_path,
	const char *content,
	const char *author_name,
	const char *author_email,
	const char *message
) {
	smithers_commit_doc_fn fn = (smithers_commit_doc_fn)smithers_lookup_symbol("smithers_commit_doc");
	return fn == NULL ? NULL : fn(store_path, file_path, content, author_name, author_email, message);
}

static char *smithers_call_get_wiki_page_content(const char *store_path, const char *page_name, const char *commit_sha) {
	smithers_get_wiki_page_content_fn fn = (smithers_get_wiki_page_content_fn)smithers_lookup_symbol("smithers_get_wiki_page_content");
	return fn == NULL ? NULL : fn(store_path, page_name, commit_sha);
}

static char *smithers_call_get_doc_content(const char *store_path, const char *file_path, const char *commit_sha) {
	smithers_get_doc_content_fn fn = (smithers_get_doc_content_fn)smithers_lookup_symbol("smithers_get_doc_content");
	return fn == NULL ? NULL : fn(store_path, file_path, commit_sha);
}

static char *smithers_call_list_wiki_page_history(const char *store_path, const char *page_name, uint32_t limit) {
	smithers_list_wiki_page_history_fn fn = (smithers_list_wiki_page_history_fn)smithers_lookup_symbol("smithers_list_wiki_page_history");
	return fn == NULL ? NULL : fn(store_path, page_name, limit);
}

static char *smithers_call_list_doc_history(const char *store_path, const char *file_path, uint32_t limit) {
	smithers_list_doc_history_fn fn = (smithers_list_doc_history_fn)smithers_lookup_symbol("smithers_list_doc_history");
	return fn == NULL ? NULL : fn(store_path, file_path, limit);
}

static char *smithers_call_delete_wiki_page(const char *store_path, const char *page_name, const char *author_name, const char *author_email) {
	smithers_delete_wiki_page_fn fn = (smithers_delete_wiki_page_fn)smithers_lookup_symbol("smithers_delete_wiki_page");
	return fn == NULL ? NULL : fn(store_path, page_name, author_name, author_email);
}

static char *smithers_call_delete_doc(const char *store_path, const char *file_path, const char *author_name, const char *author_email) {
	smithers_delete_doc_fn fn = (smithers_delete_doc_fn)smithers_lookup_symbol("smithers_delete_doc");
	return fn == NULL ? NULL : fn(store_path, file_path, author_name, author_email);
}

static char *smithers_call_list_changes(const char *store_path, uint32_t page, uint32_t per_page) {
	smithers_list_changes_fn fn = (smithers_list_changes_fn)smithers_lookup_symbol("smithers_list_changes");
	return fn == NULL ? NULL : fn(store_path, page, per_page);
}

static char *smithers_call_get_change(const char *store_path, const char *change_id) {
	smithers_get_change_fn fn = (smithers_get_change_fn)smithers_lookup_symbol("smithers_get_change");
	return fn == NULL ? NULL : fn(store_path, change_id);
}

static char *smithers_call_backout_change(const char *store_path, const char *change_id, const char *revision, const char *target_bookmark) {
	smithers_backout_change_fn fn = (smithers_backout_change_fn)smithers_lookup_symbol("smithers_backout_change");
	return fn == NULL ? NULL : fn(store_path, change_id, revision, target_bookmark);
}

static char *smithers_call_split_change(const char *store_path, const char *change_id, const char *paths_json, const char *description) {
	smithers_split_change_fn fn = (smithers_split_change_fn)smithers_lookup_symbol("smithers_split_change");
	return fn == NULL ? NULL : fn(store_path, change_id, paths_json, description);
}

static char *smithers_call_get_diff(const char *store_path, const char *change_id) {
	smithers_get_diff_fn fn = (smithers_get_diff_fn)smithers_lookup_symbol("smithers_get_diff");
	return fn == NULL ? NULL : fn(store_path, change_id);
}

static char *smithers_call_get_revision_diff(const char *store_path, const char *from_commit_id, const char *to_commit_id, const char *path) {
	smithers_get_revision_diff_fn fn = (smithers_get_revision_diff_fn)smithers_lookup_symbol("smithers_get_revision_diff");
	return fn == NULL ? NULL : fn(store_path, from_commit_id, to_commit_id, path);
}

static char *smithers_call_get_files(const char *store_path, const char *change_id) {
	smithers_get_files_fn fn = (smithers_get_files_fn)smithers_lookup_symbol("smithers_get_files");
	return fn == NULL ? NULL : fn(store_path, change_id);
}

static char *smithers_call_list_tree_files(const char *store_path, const char *change_id, const char *prefix) {
	smithers_list_tree_files_fn fn = (smithers_list_tree_files_fn)smithers_lookup_symbol("smithers_list_tree_files");
	return fn == NULL ? NULL : fn(store_path, change_id, prefix);
}

static char *smithers_call_list_directory(const char *store_path, const char *change_id, const char *prefix, const char *after, uint32_t limit) {
	smithers_list_directory_fn fn = (smithers_list_directory_fn)smithers_lookup_symbol("smithers_list_directory");
	return fn == NULL ? NULL : fn(store_path, change_id, prefix, after, limit);
}

static char *smithers_call_get_conflicts(const char *store_path, const char *change_id) {
	smithers_get_conflicts_fn fn = (smithers_get_conflicts_fn)smithers_lookup_symbol("smithers_get_conflicts");
	return fn == NULL ? NULL : fn(store_path, change_id);
}

static char *smithers_call_land_changes(const char *store_path, const char *request_json) {
    smithers_land_changes_fn fn = (smithers_land_changes_fn)smithers_lookup_symbol("smithers_land_changes");
    return fn == NULL ? NULL : fn(store_path, request_json);
}

static char *smithers_call_read_workspace_source(const char *path, const char *request) {
    smithers_land_changes_fn fn = (smithers_land_changes_fn)smithers_lookup_symbol("smithers_read_workspace_source");
    return fn == NULL ? NULL : fn(path, request);
}

static char *smithers_call_prepare_land_append(const char *path, const char *request) {
 smithers_land_changes_fn fn = (smithers_land_changes_fn)smithers_lookup_symbol("smithers_prepare_land_append");
 return fn == NULL ? NULL : fn(path, request);
}

static char *smithers_call_land_append(const char *store_path, const char *request_json) {
    smithers_land_changes_fn fn = (smithers_land_changes_fn)smithers_lookup_symbol("smithers_land_append");
    return fn == NULL ? NULL : fn(store_path, request_json);
}

static char *smithers_call_land_change(const char *store_path, const char *change_id, const char *target_bookmark) {
	smithers_land_change_fn fn = (smithers_land_change_fn)smithers_lookup_symbol("smithers_land_change");
	return fn == NULL ? NULL : fn(store_path, change_id, target_bookmark);
}

static char *smithers_call_compose_superproject(const char *store_path, const char *request_json) {
	smithers_compose_superproject_fn fn = (smithers_compose_superproject_fn)smithers_lookup_symbol("smithers_compose_superproject");
	return fn == NULL ? NULL : fn(store_path, request_json);
}

static char *smithers_call_read_superproject(const char *store_path, const char *revision) {
	smithers_read_superproject_fn fn = (smithers_read_superproject_fn)smithers_lookup_symbol("smithers_read_superproject");
	return fn == NULL ? NULL : fn(store_path, revision);
}

static char *smithers_call_list_bookmarks(const char *store_path, uint32_t page, uint32_t per_page) {
	smithers_list_bookmarks_fn fn = (smithers_list_bookmarks_fn)smithers_lookup_symbol("smithers_list_bookmarks");
	return fn == NULL ? NULL : fn(store_path, page, per_page);
}

static char *smithers_call_create_bookmark(const char *store_path, const char *name, const char *change_id) {
	smithers_create_bookmark_fn fn = (smithers_create_bookmark_fn)smithers_lookup_symbol("smithers_create_bookmark");
	return fn == NULL ? NULL : fn(store_path, name, change_id);
}

static char *smithers_call_create_bookmark_if_absent(const char *store_path, const char *name, const char *change_id) {
	smithers_create_bookmark_if_absent_fn fn = (smithers_create_bookmark_if_absent_fn)smithers_lookup_symbol("smithers_create_bookmark_if_absent");
	return fn == NULL ? NULL : fn(store_path, name, change_id);
}

static char *smithers_call_delete_bookmark(const char *store_path, const char *name) {
	smithers_delete_bookmark_fn fn = (smithers_delete_bookmark_fn)smithers_lookup_symbol("smithers_delete_bookmark");
	return fn == NULL ? NULL : fn(store_path, name);
}

static char *smithers_call_get_file_content(const char *store_path, const char *change_id, const char *path) {
	smithers_get_file_content_fn fn = (smithers_get_file_content_fn)smithers_lookup_symbol("smithers_get_file_content");
	return fn == NULL ? NULL : fn(store_path, change_id, path);
}

static char *smithers_call_create_snapshot(const char *store_path, const char *change_id) {
	smithers_create_snapshot_fn fn = (smithers_create_snapshot_fn)smithers_lookup_symbol("smithers_create_snapshot");
	return fn == NULL ? NULL : fn(store_path, change_id);
}

static char *smithers_call_list_operations(const char *store_path, uint32_t page, uint32_t per_page) {
	smithers_list_operations_fn fn = (smithers_list_operations_fn)smithers_lookup_symbol("smithers_list_operations");
	return fn == NULL ? NULL : fn(store_path, page, per_page);
}

static char *smithers_call_get_working_tree_status(const char *store_path) {
	smithers_get_working_tree_status_fn fn = (smithers_get_working_tree_status_fn)smithers_lookup_symbol("smithers_get_working_tree_status");
	return fn == NULL ? NULL : fn(store_path);
}

static void smithers_call_free_string(char *ptr) {
	smithers_free_string_fn fn = (smithers_free_string_fn)smithers_lookup_symbol("smithers_free_string");
	if (fn != NULL) {
		fn(ptr);
	}
}
*/
import "C"

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"unsafe"

	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

type Client struct {
	libPath string
}

type Error struct {
	Code    string `json:"code"`
	Message string `json:"error"`
}

type InitRepoResult struct {
	Status string `json:"status"`
	Path   string `json:"path"`
}

type StatusResult struct {
	Status string `json:"status"`
}

type InitWikiRepoResult struct {
	Created bool `json:"created"`
}

type Paginated[T any] struct {
	Items      []T `json:"items"`
	TotalCount int `json:"total_count"`
}

func New(libPath string) *Client {
	return &Client{libPath: libPath}
}

func (c *Client) Load() error {
	if c.libPath == "" {
		return errors.New("smithers ffi library path is not configured")
	}
	cpath := C.CString(c.libPath)
	defer C.free(unsafe.Pointer(cpath))
	if rc := C.smithers_load_library(cpath); rc != 0 {
		return fmt.Errorf("load smithers ffi library %s: %s", c.libPath, lastCError())
	}
	return nil
}

func (e *Error) Error() string {
	if e.Message != "" {
		return e.Message
	}
	if e.Code != "" {
		return e.Code
	}
	return "smithers ffi error"
}

func (e *Error) StatusCode() int {
	switch e.Code {
	case "invalid_argument", "bad_request":
		return 400
	case "not_found", "landing_receipt_missing", "workspace_source_missing":
		return 404
	case "conflict":
		return 409
	case "unprocessable_entity":
		return 422
	default:
		return 500
	}
}

func (c *Client) InitRepo(storePath string) (InitRepoResult, error) {
	if err := rejectNUL(storePath); err != nil {
		return InitRepoResult{}, err
	}
	storePathC := cString(storePath)
	defer freeCString(storePathC)
	return decode[InitRepoResult](c, C.smithers_call_init_repo(storePathC))
}

func (c *Client) AutoInitRepo(storePath, bookmarkName, repoName string) (InitRepoResult, error) {
	if err := rejectNUL(storePath, bookmarkName, repoName); err != nil {
		return InitRepoResult{}, err
	}
	storePathC := cString(storePath)
	bookmarkNameC := cString(bookmarkName)
	repoNameC := cString(repoName)
	defer freeCString(storePathC)
	defer freeCString(bookmarkNameC)
	defer freeCString(repoNameC)
	return decode[InitRepoResult](c, C.smithers_call_auto_init_repo(storePathC, bookmarkNameC, repoNameC))
}

func (c *Client) DeleteRepo(storePath string) error {
	if err := rejectNUL(storePath); err != nil {
		return err
	}
	storePathC := cString(storePath)
	defer freeCString(storePathC)
	_, err := decode[StatusResult](c, C.smithers_call_delete_repo(storePathC))
	return err
}

func (c *Client) ImportGitRefs(storePath string) error {
	if err := rejectNUL(storePath); err != nil {
		return err
	}
	storePathC := cString(storePath)
	defer freeCString(storePathC)
	_, err := decode[StatusResult](c, C.smithers_call_import_git_refs(storePathC))
	return err
}

func (c *Client) ExportGitRefs(storePath string) error {
	if err := rejectNUL(storePath); err != nil {
		return err
	}
	storePathC := cString(storePath)
	defer freeCString(storePathC)
	_, err := decode[StatusResult](c, C.smithers_call_export_git_refs(storePathC))
	return err
}

func (c *Client) InitWikiRepo(storePath string) (bool, error) {
	if err := rejectNUL(storePath); err != nil {
		return false, err
	}
	storePathC := cString(storePath)
	defer freeCString(storePathC)
	result, err := decode[InitWikiRepoResult](c, C.smithers_call_init_wiki_repo(storePathC))
	if err != nil {
		return false, err
	}
	return result.Created, nil
}

func (c *Client) InitDocsRepo(storePath string) (bool, error) {
	if err := rejectNUL(storePath); err != nil {
		return false, err
	}
	storePathC := cString(storePath)
	defer freeCString(storePathC)
	result, err := decode[InitWikiRepoResult](c, C.smithers_call_init_docs_repo(storePathC))
	if err != nil {
		return false, err
	}
	return result.Created, nil
}

func (c *Client) ProjectWikiRevision(path, json string) (string, error) {
	if err := rejectNUL(path, json); err != nil {
		return "", err
	}
	pathC, jsonC := cString(path), cString(json)
	defer freeCString(pathC)
	defer freeCString(jsonC)
	result, err := decode[struct {
		CommitSHA string `json:"commit_sha"`
	}](c, C.smithers_call_project_wiki_revision(pathC, jsonC))
	if err != nil {
		return "", err
	}
	return result.CommitSHA, nil
}

func (c *Client) WikiDocument(requestJSON string) (repohost.WikiDocumentResult, error) {
	if err := rejectNUL(requestJSON); err != nil {
		return repohost.WikiDocumentResult{}, err
	}
	input := cString(requestJSON)
	defer freeCString(input)
	return decode[repohost.WikiDocumentResult](c, C.smithers_call_wiki_document(input))
}

func (c *Client) CommitWikiPage(storePath, pageName, content, authorName, authorEmail, message string) (string, error) {
	if err := rejectNUL(storePath, pageName, content, authorName, authorEmail, message); err != nil {
		return "", err
	}
	storePathC := cString(storePath)
	pageNameC := cString(pageName)
	contentC := cString(content)
	authorNameC := cString(authorName)
	authorEmailC := cString(authorEmail)
	messageC := cString(message)
	defer freeCString(storePathC)
	defer freeCString(pageNameC)
	defer freeCString(contentC)
	defer freeCString(authorNameC)
	defer freeCString(authorEmailC)
	defer freeCString(messageC)

	commitResult, err := decode[struct {
		CommitSHA string `json:"commit_sha"`
	}](c, C.smithers_call_commit_wiki_page(storePathC, pageNameC, contentC, authorNameC, authorEmailC, messageC))
	if err != nil {
		return "", err
	}
	return commitResult.CommitSHA, nil
}

func (c *Client) CommitDoc(storePath, filePath, content, authorName, authorEmail, message string) (string, error) {
	if err := rejectNUL(storePath, filePath, content, authorName, authorEmail, message); err != nil {
		return "", err
	}
	storePathC := cString(storePath)
	filePathC := cString(filePath)
	contentC := cString(content)
	authorNameC := cString(authorName)
	authorEmailC := cString(authorEmail)
	messageC := cString(message)
	defer freeCString(storePathC)
	defer freeCString(filePathC)
	defer freeCString(contentC)
	defer freeCString(authorNameC)
	defer freeCString(authorEmailC)
	defer freeCString(messageC)

	commitResult, err := decode[struct {
		CommitSHA string `json:"commit_sha"`
	}](c, C.smithers_call_commit_doc(storePathC, filePathC, contentC, authorNameC, authorEmailC, messageC))
	if err != nil {
		return "", err
	}
	return commitResult.CommitSHA, nil
}

func (c *Client) GetWikiPageContent(storePath, pageName, commitSHA string) (string, string, error) {
	if err := rejectNUL(storePath, pageName, commitSHA); err != nil {
		return "", "", err
	}
	storePathC := cString(storePath)
	pageNameC := cString(pageName)
	defer freeCString(storePathC)
	defer freeCString(pageNameC)

	var commitSHAC *C.char
	if commitSHA != "" {
		commitSHAC = cString(commitSHA)
		defer freeCString(commitSHAC)
	}

	result, err := decode[struct {
		Content   string `json:"content"`
		CommitSHA string `json:"commit_sha"`
	}](c, C.smithers_call_get_wiki_page_content(storePathC, pageNameC, commitSHAC))
	if err != nil {
		return "", "", err
	}
	return result.Content, result.CommitSHA, nil
}

func (c *Client) GetDocContent(storePath, filePath, commitSHA string) (string, string, error) {
	if err := rejectNUL(storePath, filePath, commitSHA); err != nil {
		return "", "", err
	}
	storePathC := cString(storePath)
	filePathC := cString(filePath)
	defer freeCString(storePathC)
	defer freeCString(filePathC)

	var commitSHAC *C.char
	if commitSHA != "" {
		commitSHAC = cString(commitSHA)
		defer freeCString(commitSHAC)
	}

	result, err := decode[struct {
		Content   string `json:"content"`
		CommitSHA string `json:"commit_sha"`
	}](c, C.smithers_call_get_doc_content(storePathC, filePathC, commitSHAC))
	if err != nil {
		return "", "", err
	}
	return result.Content, result.CommitSHA, nil
}

func (c *Client) ListWikiPageHistory(storePath, pageName string, limit uint32) ([]repohost.WikiRevision, error) {
	if err := rejectNUL(storePath, pageName); err != nil {
		return nil, err
	}
	storePathC := cString(storePath)
	pageNameC := cString(pageName)
	defer freeCString(storePathC)
	defer freeCString(pageNameC)
	return decode[[]repohost.WikiRevision](c, C.smithers_call_list_wiki_page_history(storePathC, pageNameC, C.uint32_t(limit)))
}

func (c *Client) ListDocHistory(storePath, filePath string, limit uint32) ([]repohost.WikiRevision, error) {
	if err := rejectNUL(storePath, filePath); err != nil {
		return nil, err
	}
	storePathC := cString(storePath)
	filePathC := cString(filePath)
	defer freeCString(storePathC)
	defer freeCString(filePathC)
	return decode[[]repohost.WikiRevision](c, C.smithers_call_list_doc_history(storePathC, filePathC, C.uint32_t(limit)))
}

func (c *Client) DeleteWikiPage(storePath, pageName, authorName, authorEmail string) error {
	if err := rejectNUL(storePath, pageName, authorName, authorEmail); err != nil {
		return err
	}
	storePathC := cString(storePath)
	pageNameC := cString(pageName)
	authorNameC := cString(authorName)
	authorEmailC := cString(authorEmail)
	defer freeCString(storePathC)
	defer freeCString(pageNameC)
	defer freeCString(authorNameC)
	defer freeCString(authorEmailC)
	_, err := decode[StatusResult](c, C.smithers_call_delete_wiki_page(storePathC, pageNameC, authorNameC, authorEmailC))
	return err
}

func (c *Client) DeleteDoc(storePath, filePath, authorName, authorEmail string) error {
	if err := rejectNUL(storePath, filePath, authorName, authorEmail); err != nil {
		return err
	}
	storePathC := cString(storePath)
	filePathC := cString(filePath)
	authorNameC := cString(authorName)
	authorEmailC := cString(authorEmail)
	defer freeCString(storePathC)
	defer freeCString(filePathC)
	defer freeCString(authorNameC)
	defer freeCString(authorEmailC)
	_, err := decode[StatusResult](c, C.smithers_call_delete_doc(storePathC, filePathC, authorNameC, authorEmailC))
	return err
}

func (c *Client) ListChanges(storePath string, page, perPage uint32) (Paginated[repohost.Change], error) {
	if err := rejectNUL(storePath); err != nil {
		return Paginated[repohost.Change]{}, err
	}
	storePathC := cString(storePath)
	defer freeCString(storePathC)
	return decode[Paginated[repohost.Change]](c, C.smithers_call_list_changes(storePathC, C.uint32_t(page), C.uint32_t(perPage)))
}

func (c *Client) GetChange(storePath, changeID string) (repohost.Change, error) {
	if err := rejectNUL(storePath, changeID); err != nil {
		return repohost.Change{}, err
	}
	storePathC := cString(storePath)
	changeIDC := cString(changeID)
	defer freeCString(storePathC)
	defer freeCString(changeIDC)
	return decode[repohost.Change](c, C.smithers_call_get_change(storePathC, changeIDC))
}

func (c *Client) BackoutChange(storePath, changeID, revision, targetBookmark string) (repohost.Change, error) {
	if err := rejectNUL(storePath, changeID, revision, targetBookmark); err != nil {
		return repohost.Change{}, err
	}
	storePathC := cString(storePath)
	changeIDC := cString(changeID)
	revisionC := cString(revision)
	targetBookmarkC := cString(targetBookmark)
	defer freeCString(storePathC)
	defer freeCString(changeIDC)
	defer freeCString(revisionC)
	defer freeCString(targetBookmarkC)
	return decode[repohost.Change](c, C.smithers_call_backout_change(storePathC, changeIDC, revisionC, targetBookmarkC))
}

func (c *Client) SplitChange(storePath, changeID string, paths []string, description string) (repohost.SplitChangeResult, error) {
	if err := rejectNUL(storePath, changeID, description); err != nil {
		return repohost.SplitChangeResult{}, err
	}
	pathsJSON, err := json.Marshal(paths)
	if err != nil {
		return repohost.SplitChangeResult{}, fmt.Errorf("encode split paths: %w", err)
	}
	storePathC := cString(storePath)
	changeIDC := cString(changeID)
	pathsJSONC := cString(string(pathsJSON))
	descriptionC := cString(description)
	defer freeCString(storePathC)
	defer freeCString(changeIDC)
	defer freeCString(pathsJSONC)
	defer freeCString(descriptionC)
	return decode[repohost.SplitChangeResult](c, C.smithers_call_split_change(storePathC, changeIDC, pathsJSONC, descriptionC))
}

func (c *Client) GetDiff(storePath, changeID string) (repohost.ChangeDiff, error) {
	if err := rejectNUL(storePath, changeID); err != nil {
		return repohost.ChangeDiff{}, err
	}
	storePathC := cString(storePath)
	changeIDC := cString(changeID)
	defer freeCString(storePathC)
	defer freeCString(changeIDC)
	return decode[repohost.ChangeDiff](c, C.smithers_call_get_diff(storePathC, changeIDC))
}

func (c *Client) GetRevisionDiff(storePath, fromCommitID, toCommitID, path string) (repohost.ChangeDiff, error) {
	if err := rejectNUL(storePath, fromCommitID, toCommitID, path); err != nil {
		return repohost.ChangeDiff{}, err
	}
	storePathC := cString(storePath)
	fromCommitIDC := cString(fromCommitID)
	toCommitIDC := cString(toCommitID)
	pathC := cString(path)
	defer freeCString(storePathC)
	defer freeCString(fromCommitIDC)
	defer freeCString(toCommitIDC)
	defer freeCString(pathC)
	return decode[repohost.ChangeDiff](c, C.smithers_call_get_revision_diff(storePathC, fromCommitIDC, toCommitIDC, pathC))
}

func (c *Client) GetFiles(storePath, changeID string) ([]repohost.ChangeFile, error) {
	if err := rejectNUL(storePath, changeID); err != nil {
		return nil, err
	}
	storePathC := cString(storePath)
	changeIDC := cString(changeID)
	defer freeCString(storePathC)
	defer freeCString(changeIDC)
	return decode[[]repohost.ChangeFile](c, C.smithers_call_get_files(storePathC, changeIDC))
}

func (c *Client) ListTreeFiles(storePath, changeID, prefix string) ([]repohost.ChangeFile, error) {
	if err := rejectNUL(storePath, changeID, prefix); err != nil {
		return nil, err
	}
	storePathC := cString(storePath)
	changeIDC := cString(changeID)
	defer freeCString(storePathC)
	defer freeCString(changeIDC)

	var prefixC *C.char
	if prefix != "" {
		prefixC = cString(prefix)
		defer freeCString(prefixC)
	}

	return decode[[]repohost.ChangeFile](c, C.smithers_call_list_tree_files(storePathC, changeIDC, prefixC))
}

func (c *Client) ListDirectory(storePath, changeID, prefix, after string, limit uint32) ([]repohost.TreeEntry, error) {
	if err := rejectNUL(storePath, changeID, prefix, after); err != nil {
		return nil, err
	}
	storeC, changeC, prefixC, afterC := cString(storePath), cString(changeID), cString(prefix), cString(after)
	defer freeCString(storeC)
	defer freeCString(changeC)
	defer freeCString(prefixC)
	defer freeCString(afterC)
	return decode[[]repohost.TreeEntry](c, C.smithers_call_list_directory(storeC, changeC, prefixC, afterC, C.uint32_t(limit)))
}

func (c *Client) GetConflicts(storePath, changeID string) ([]repohost.Conflict, error) {
	if err := rejectNUL(storePath, changeID); err != nil {
		return nil, err
	}
	storePathC := cString(storePath)
	changeIDC := cString(changeID)
	defer freeCString(storePathC)
	defer freeCString(changeIDC)
	return decode[[]repohost.Conflict](c, C.smithers_call_get_conflicts(storePathC, changeIDC))
}

func (c *Client) ReadWorkspaceSource(path, workspaceID string, source repohost.WorkspaceSource) (repohost.WorkspaceSourceReceipt, error) {
	payload, err := json.Marshal(repohost.WorkspaceSourceRequest{WorkspaceID: workspaceID, Source: source})
	if err != nil {
		return repohost.WorkspaceSourceReceipt{}, err
	}
	if err := rejectNUL(path, string(payload)); err != nil {
		return repohost.WorkspaceSourceReceipt{}, err
	}
	pathC, requestC := cString(path), cString(string(payload))
	defer freeCString(pathC)
	defer freeCString(requestC)
	return decode[repohost.WorkspaceSourceReceipt](c, C.smithers_call_read_workspace_source(pathC, requestC))
}

func (c *Client) PrepareLandAppend(path string, request repohost.AppendPreparationRequest) (repohost.AppendPreparation, error) {
	payload, err := json.Marshal(request)
	if err != nil {
		return repohost.AppendPreparation{}, err
	}
	if err = rejectNUL(path, string(payload)); err != nil {
		return repohost.AppendPreparation{}, err
	}
	pathC, requestC := cString(path), cString(string(payload))
	defer freeCString(pathC)
	defer freeCString(requestC)
	return decode[repohost.AppendPreparation](c, C.smithers_call_prepare_land_append(pathC, requestC))
}

func (c *Client) LandChanges(storePath, requestJSON string) (repohost.LandResult, error) {
	if err := rejectNUL(storePath, requestJSON); err != nil {
		return repohost.LandResult{}, err
	}
	pathC, requestC := cString(storePath), cString(requestJSON)
	defer freeCString(pathC)
	defer freeCString(requestC)
	var request repohost.LandRequest
	if err := json.Unmarshal([]byte(requestJSON), &request); err != nil {
		return repohost.LandResult{}, err
	}
	if request.Append != nil {
		return decode[repohost.LandResult](c, C.smithers_call_land_append(pathC, requestC))
	}
	return decode[repohost.LandResult](c, C.smithers_call_land_changes(pathC, requestC))
}

func (c *Client) LandChange(storePath, changeID, targetBookmark string) (repohost.LandResult, error) {
	if err := rejectNUL(storePath, changeID, targetBookmark); err != nil {
		return repohost.LandResult{}, err
	}
	storePathC := cString(storePath)
	changeIDC := cString(changeID)
	targetBookmarkC := cString(targetBookmark)
	defer freeCString(storePathC)
	defer freeCString(changeIDC)
	defer freeCString(targetBookmarkC)
	return decode[repohost.LandResult](c, C.smithers_call_land_change(storePathC, changeIDC, targetBookmarkC))
}

// ComposeSuperproject writes one organization-superproject commit (a gitlink
// per member plus .gitmodules) without moving any bookmark.
func (c *Client) ComposeSuperproject(storePath, requestJSON string) (repohost.SuperprojectCommit, error) {
	if err := rejectNUL(storePath, requestJSON); err != nil {
		return repohost.SuperprojectCommit{}, err
	}
	storePathC := cString(storePath)
	requestC := cString(requestJSON)
	defer freeCString(storePathC)
	defer freeCString(requestC)
	return decode[repohost.SuperprojectCommit](c, C.smithers_call_compose_superproject(storePathC, requestC))
}

// ReadSuperproject returns the member vector pinned by a superproject commit.
func (c *Client) ReadSuperproject(storePath, revision string) (repohost.SuperprojectCommit, error) {
	if err := rejectNUL(storePath, revision); err != nil {
		return repohost.SuperprojectCommit{}, err
	}
	storePathC := cString(storePath)
	revisionC := cString(revision)
	defer freeCString(storePathC)
	defer freeCString(revisionC)
	return decode[repohost.SuperprojectCommit](c, C.smithers_call_read_superproject(storePathC, revisionC))
}

func (c *Client) ListBookmarks(storePath string, page, perPage uint32) (Paginated[repohost.Bookmark], error) {
	if err := rejectNUL(storePath); err != nil {
		return Paginated[repohost.Bookmark]{}, err
	}
	storePathC := cString(storePath)
	defer freeCString(storePathC)
	return decode[Paginated[repohost.Bookmark]](c, C.smithers_call_list_bookmarks(storePathC, C.uint32_t(page), C.uint32_t(perPage)))
}

func (c *Client) CreateBookmark(storePath, name, changeID string) (repohost.Bookmark, error) {
	if err := rejectNUL(storePath, name, changeID); err != nil {
		return repohost.Bookmark{}, err
	}
	storePathC := cString(storePath)
	nameC := cString(name)
	changeIDC := cString(changeID)
	defer freeCString(storePathC)
	defer freeCString(nameC)
	defer freeCString(changeIDC)
	return decode[repohost.Bookmark](c, C.smithers_call_create_bookmark(storePathC, nameC, changeIDC))
}

func (c *Client) CreateBookmarkIfAbsent(storePath, name, changeID string) (repohost.Bookmark, error) {
	if err := rejectNUL(storePath, name, changeID); err != nil {
		return repohost.Bookmark{}, err
	}
	storePathC := cString(storePath)
	nameC := cString(name)
	changeIDC := cString(changeID)
	defer freeCString(storePathC)
	defer freeCString(nameC)
	defer freeCString(changeIDC)
	return decode[repohost.Bookmark](c, C.smithers_call_create_bookmark_if_absent(storePathC, nameC, changeIDC))
}

func (c *Client) DeleteBookmark(storePath, name string) error {
	if err := rejectNUL(storePath, name); err != nil {
		return err
	}
	storePathC := cString(storePath)
	nameC := cString(name)
	defer freeCString(storePathC)
	defer freeCString(nameC)
	_, err := decode[StatusResult](c, C.smithers_call_delete_bookmark(storePathC, nameC))
	return err
}

func (c *Client) GetFileContent(storePath, changeID, path string) (repohost.FileContent, error) {
	if err := rejectNUL(storePath, changeID, path); err != nil {
		return repohost.FileContent{}, err
	}
	storePathC := cString(storePath)
	changeIDC := cString(changeID)
	pathC := cString(path)
	defer freeCString(storePathC)
	defer freeCString(changeIDC)
	defer freeCString(pathC)
	return decode[repohost.FileContent](c, C.smithers_call_get_file_content(storePathC, changeIDC, pathC))
}

func (c *Client) CreateSnapshot(storePath, changeID string) (repohost.SnapshotResult, error) {
	if err := rejectNUL(storePath, changeID); err != nil {
		return repohost.SnapshotResult{}, err
	}
	storePathC := cString(storePath)
	changeIDC := cString(changeID)
	defer freeCString(storePathC)
	defer freeCString(changeIDC)
	return decode[repohost.SnapshotResult](c, C.smithers_call_create_snapshot(storePathC, changeIDC))
}

func (c *Client) ListOperations(storePath string, page, perPage uint32) (Paginated[repohost.Operation], error) {
	if err := rejectNUL(storePath); err != nil {
		return Paginated[repohost.Operation]{}, err
	}
	storePathC := cString(storePath)
	defer freeCString(storePathC)
	return decode[Paginated[repohost.Operation]](c, C.smithers_call_list_operations(storePathC, C.uint32_t(page), C.uint32_t(perPage)))
}

func (c *Client) GetWorkingTreeStatus(storePath string) (repohost.WorkingTreeStatus, error) {
	if err := rejectNUL(storePath); err != nil {
		return repohost.WorkingTreeStatus{}, err
	}
	storePathC := cString(storePath)
	defer freeCString(storePathC)
	return decode[repohost.WorkingTreeStatus](c, C.smithers_call_get_working_tree_status(storePathC))
}

func decode[T any](_ *Client, ptr *C.char) (T, error) {
	var zero T
	payload, err := takeJSON(ptr)
	if err != nil {
		return zero, err
	}

	if ffiErr, ok, err := parseFFIError(payload); err != nil {
		return zero, err
	} else if ok {
		return zero, ffiErr
	}

	var out T
	if err := json.Unmarshal(payload, &out); err != nil {
		return zero, fmt.Errorf("decode smithers ffi response: %w", err)
	}
	return out, nil
}

func parseFFIError(payload []byte) (*Error, bool, error) {
	trimmed := bytes.TrimSpace(payload)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return nil, false, nil
	}

	var envelope Error
	if err := json.Unmarshal(payload, &envelope); err != nil {
		return nil, false, fmt.Errorf("decode smithers ffi error envelope: %w", err)
	}
	if envelope.Code == "" {
		return nil, false, nil
	}
	return &envelope, true, nil
}

func takeJSON(ptr *C.char) ([]byte, error) {
	if ptr == nil {
		return nil, errors.New(lastCError())
	}
	defer C.smithers_call_free_string(ptr)
	return []byte(C.GoString(ptr)), nil
}

func lastCError() string {
	msg := C.smithers_last_error_message()
	if msg == nil {
		return "unknown cgo ffi error"
	}
	value := C.GoString(msg)
	if value == "" {
		return "unknown cgo ffi error"
	}
	return value
}

// rejectNUL guards the Go-to-Rust C-string boundary. C.CString output is read
// by Rust with CStr::from_ptr, which stops at the first NUL byte, so an
// interior NUL would silently truncate the argument (content, paths, bookmark
// names, author fields, messages) while the call still reports success. Every
// exported method must run its string arguments through this check before
// converting them with cString.
func rejectNUL(args ...string) error {
	for _, arg := range args {
		if strings.ContainsRune(arg, '\x00') {
			return &Error{Code: "invalid_argument", Message: "string argument must not contain a NUL byte"}
		}
	}
	return nil
}

func cString(value string) *C.char {
	return C.CString(value)
}

func freeCString(value *C.char) {
	if value != nil {
		C.free(unsafe.Pointer(value))
	}
}

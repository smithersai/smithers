package services

import (
	stdErrors "errors"
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func TestLandingHelpers_Matrix(t *testing.T) {
	t.Parallel()

	t.Run("allowed_state", func(t *testing.T) {
		tests := []struct {
			state string
			want  bool
		}{
			{state: landingStateOpen, want: true},
			{state: landingStateClosed, want: true},
			{state: landingStateDraft, want: true},
			{state: landingStateMerged, want: true},
			{state: landingStateFailed, want: true},
			{state: "", want: false},
			{state: "archived", want: false},
		}
		for _, tc := range tests {
			tc := tc
			t.Run(fmt.Sprintf("state_%q", tc.state), func(t *testing.T) {
				assert.Equal(t, tc.want, isAllowedLandingState(tc.state))
			})
		}
	})

	t.Run("allowed_conflict_status", func(t *testing.T) {
		tests := []struct {
			status string
			want   bool
		}{
			{status: "clean", want: true},
			{status: "conflicted", want: true},
			{status: "unknown", want: true},
			{status: "pending", want: false},
		}
		for _, tc := range tests {
			tc := tc
			t.Run(fmt.Sprintf("conflict_%q", tc.status), func(t *testing.T) {
				assert.Equal(t, tc.want, isAllowedConflictStatus(tc.status))
			})
		}
	})

	t.Run("normalize_filter_state", func(t *testing.T) {
		tests := []struct {
			input     string
			want      string
			wantField string
			wantCode  string
		}{
			{input: "", want: ""},
			{input: " OPEN ", want: "open"},
			{input: "Draft", want: "draft"},
			{input: "merged", want: "merged"},
			{input: "failed", want: "failed"},
			{input: "archived", wantField: "state", wantCode: "invalid"},
		}
		for _, tc := range tests {
			tc := tc
			t.Run(fmt.Sprintf("filter_%q", tc.input), func(t *testing.T) {
				got, err := normalizeLandingFilterState(tc.input)
				if tc.wantField != "" {
					requireValidationFieldError(t, err, tc.wantField, tc.wantCode)
					assert.Empty(t, got)
					return
				}
				require.NoError(t, err)
				assert.Equal(t, tc.want, got)
			})
		}
	})

	t.Run("valid_transition", func(t *testing.T) {
		tests := []struct {
			from string
			to   string
			want bool
		}{
			{from: landingStateOpen, to: landingStateOpen, want: true},
			{from: landingStateOpen, to: landingStateDraft, want: true},
			{from: landingStateOpen, to: landingStateClosed, want: true},
			{from: landingStateOpen, to: landingStateMerged, want: false},
			{from: landingStateDraft, to: landingStateOpen, want: true},
			{from: landingStateDraft, to: landingStateClosed, want: true},
			{from: landingStateDraft, to: landingStateMerged, want: false},
			{from: landingStateClosed, to: landingStateOpen, want: true},
			{from: landingStateClosed, to: landingStateDraft, want: false},
			{from: landingStateMerged, to: landingStateOpen, want: false},
			{from: landingStateFailed, to: landingStateClosed, want: true},
			{from: landingStateFailed, to: landingStateDraft, want: true},
			{from: landingStateFailed, to: landingStateOpen, want: true},
			{from: landingStateFailed, to: landingStateMerged, want: false},
			{from: landingStateOpen, to: landingStateFailed, want: false},
			{from: "unknown", to: landingStateOpen, want: false},
		}
		for _, tc := range tests {
			tc := tc
			t.Run(tc.from+"->"+tc.to, func(t *testing.T) {
				assert.Equal(t, tc.want, isValidLandingTransition(tc.from, tc.to))
			})
		}
	})

	t.Run("normalize_change_ids", func(t *testing.T) {
		tests := []struct {
			name      string
			input     []string
			want      []string
			wantField string
			wantCode  string
		}{
			{name: "preserves_order_and_trims", input: []string{" change-1 ", "change-2"}, want: []string{"change-1", "change-2"}},
			{name: "missing", input: nil, wantField: "change_ids", wantCode: "missing_field"},
			{name: "blank", input: []string{"change-1", ""}, wantField: "change_ids", wantCode: "invalid"},
		}
		for _, tc := range tests {
			tc := tc
			t.Run(tc.name, func(t *testing.T) {
				got, err := normalizeChangeIDs(tc.input)
				if tc.wantField != "" {
					requireValidationFieldError(t, err, tc.wantField, tc.wantCode)
					assert.Nil(t, got)
					return
				}
				require.NoError(t, err)
				assert.Equal(t, tc.want, got)
			})
		}
	})

	t.Run("allowed_review_type", func(t *testing.T) {
		tests := []struct {
			input string
			want  bool
		}{
			{input: "pending", want: true},
			{input: "approve", want: true},
			{input: "comment", want: true},
			{input: "request_changes", want: true},
			{input: "dismiss", want: false},
		}
		for _, tc := range tests {
			tc := tc
			t.Run(fmt.Sprintf("review_%q", tc.input), func(t *testing.T) {
				assert.Equal(t, tc.want, isAllowedReviewType(tc.input))
			})
		}
	})
}

func TestLandingCreateErrorNormalization_Matrix(t *testing.T) {
	t.Parallel()

	t.Run("nil", func(t *testing.T) {
		assert.NoError(t, normalizeLandingCreateError(nil, "fallback"))
	})

	t.Run("api_error_passthrough", func(t *testing.T) {
		original := pkgerrors.BadRequest("bad request")
		assert.Same(t, original, normalizeLandingCreateError(original, "fallback"))
	})

	t.Run("pg_unique_violation", func(t *testing.T) {
		err := normalizeLandingCreateError(&pgconn.PgError{Code: "23505"}, "fallback")
		requireAPIError(t, err, 409, "landing request already exists")
	})

	t.Run("pg_constraint_validation_fields", func(t *testing.T) {
		tests := []struct {
			constraint string
			wantField  string
		}{
			{constraint: "landing_requests_target_bookmark_check", wantField: "target_bookmark"},
			{constraint: "landing_requests_change_ids_check", wantField: "change_ids"},
			{constraint: "landing_requests_stack_size_check", wantField: "stack_size"},
			{constraint: "landing_requests_conflict_status_check", wantField: "conflict_status"},
			{constraint: "other_constraint", wantField: "landing_request"},
		}
		for _, tc := range tests {
			tc := tc
			t.Run(tc.constraint, func(t *testing.T) {
				err := normalizeLandingCreateError(&pgconn.PgError{
					Code:           "23514",
					ConstraintName: tc.constraint,
				}, "fallback")
				requireValidationFieldError(t, err, tc.wantField, "invalid")
			})
		}
	})

	t.Run("pg_not_null_and_fk_are_validation_errors", func(t *testing.T) {
		for _, code := range []string{"23502", "23503"} {
			code := code
			t.Run(code, func(t *testing.T) {
				err := normalizeLandingCreateError(&pgconn.PgError{Code: code}, "fallback")
				requireValidationFieldError(t, err, "landing_request", "invalid")
			})
		}
	})

	t.Run("generic_error_becomes_internal", func(t *testing.T) {
		err := normalizeLandingCreateError(stdErrors.New("boom"), "fallback")
		requireAPIError(t, err, 500, "fallback")
	})
}

func TestNormalizeWebhookPage_Matrix(t *testing.T) {
	t.Parallel()

	caseCount := 0
	for page := -2; page <= 3; page++ {
		page := page
		for perPage := -2; perPage <= 35; perPage++ {
			perPage := perPage
			t.Run(fmt.Sprintf("page_%d_per_%d", page, perPage), func(t *testing.T) {
				caseCount++
				size, offset, pageNum, pages := normalizeWebhookPage(page, perPage)
				if page < 1 {
					assert.Equal(t, 1, pageNum)
				} else {
					assert.Equal(t, page, pageNum)
				}
				if perPage < 1 || perPage > 30 {
					assert.Equal(t, 30, size)
				} else {
					assert.Equal(t, perPage, size)
				}
				assert.Equal(t, (pageNum-1)*size, offset)
				assert.Zero(t, pages)
			})
		}
	}
	assert.Equal(t, 228, caseCount)
}

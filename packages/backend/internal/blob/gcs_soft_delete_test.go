package blob

import (
	"context"
	"testing"

	"cloud.google.com/go/storage"
	"github.com/stretchr/testify/require"
	"google.golang.org/api/googleapi"
)

func TestHardDeleteGCSObjectGenerationsAcceptsDisabledSoftDeletePolicy(t *testing.T) {
	t.Parallel()
	visits := 0
	err := hardDeleteGCSObjectGenerationsWithHooks(
		context.Background(),
		"repos/1/lfs/object",
		func(_ context.Context, query *storage.Query, _ func(*storage.ObjectAttrs) error) error {
			visits++
			if query.SoftDeleted {
				return &googleapi.Error{
					Code:    400,
					Message: "Soft delete policy is required to list soft-deleted versions",
				}
			}
			return nil
		},
		func(context.Context, int64) error {
			t.Fatal("empty object listing must not delete a generation")
			return nil
		},
	)

	require.NoError(t, err)
	require.Equal(t, 2, visits)
}

func TestHardDeleteGCSObjectGenerationsPropagatesOtherSoftDeleteErrors(t *testing.T) {
	t.Parallel()
	expected := &googleapi.Error{Code: 400, Message: "invalid query"}
	err := hardDeleteGCSObjectGenerationsWithHooks(
		context.Background(),
		"repos/1/lfs/object",
		func(_ context.Context, query *storage.Query, _ func(*storage.ObjectAttrs) error) error {
			if query.SoftDeleted {
				return expected
			}
			return nil
		},
		func(context.Context, int64) error {
			t.Fatal("empty object listing must not delete a generation")
			return nil
		},
	)

	require.ErrorIs(t, err, expected)
}

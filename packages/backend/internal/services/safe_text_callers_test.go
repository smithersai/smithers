package services

import (
	"context"
	"testing"
)

// A NUL byte survives JSON decoding and, if it reaches a Postgres text column,
// fails the write (SQLSTATE 22021) as an opaque 500. These name/title write paths
// must reject it up front via validateSafeText (they previously did not).

func TestOrgService_CreateOrg_RejectsNULInName(t *testing.T) {
	svc := NewOrgService(&mockOrgQuerier{}) // no DB call is reached; validation happens first
	_, err := svc.CreateOrg(context.Background(), testOrgUser(1, "owner"), CreateOrgRequest{Name: "evil\x00org"})
	requireAPIErrorStatus(t, err, 422)
}

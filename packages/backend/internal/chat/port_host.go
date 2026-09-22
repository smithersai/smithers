package chat

import (
	"context"

	"github.com/smithersai/smithers/packages/backend/ports"
)

type PortHost struct {
	Host            ports.ChatHost
	ProducerBaseURL string
}

func (h PortHost) RunTurn(ctx context.Context, grant ProducerGrant) error {
	return h.Host.RunChatTurn(ctx, ports.ChatTurnGrant{
		TurnID: grant.TurnID, OwnerID: grant.OwnerID, RepositoryID: grant.RepositoryID, RunID: grant.RunID, LegID: grant.LegID,
		Generation: grant.Generation, Token: grant.Token, Cursor: ports.ChatTurnCursor{
			Version: grant.Cursor.Version, RunID: grant.Cursor.RunID, LegID: grant.Cursor.LegID,
			Batch: grant.Cursor.Batch, Position: grant.Cursor.Position, Hash: grant.Cursor.Hash,
		}, ExpiresAt: grant.ExpiresAt,
		Request: grant.Request, ProducerBaseURL: h.ProducerBaseURL,
	})
}

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
	grant.ProducerBaseURL = h.ProducerBaseURL
	return h.Host.RunChatTurn(ctx, grant)
}

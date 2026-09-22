package modelhost

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/ports"
)

// OwnerSecretResolver reads the same encrypted repository secrets written by
// the product API. The database address becomes available after native-owned
// PostgreSQL starts, so it is obtained at turn time.
type OwnerSecretResolver struct {
	databaseURL func() string
	secretKey   func() string
}

func NewOwnerSecretResolver(databaseURL, secretKey func() string) (*OwnerSecretResolver, error) {
	if databaseURL == nil || secretKey == nil {
		return nil, errors.New("owner model secrets require database and encryption key providers")
	}
	return &OwnerSecretResolver{databaseURL: databaseURL, secretKey: secretKey}, nil
}

func (resolver *OwnerSecretResolver) ResolveChatModel(ctx context.Context, ownerID, _ int64, request json.RawMessage) (Binding, error) {
	var input struct {
		RepositoryID int64           `json:"repositoryId"`
		Model        json.RawMessage `json:"model"`
	}
	var model struct {
		Protocol   string `json:"protocol"`
		ModelID    string `json:"modelId"`
		Credential string `json:"credential"`
	}
	if err := json.Unmarshal(request, &input); err != nil || json.Unmarshal(input.Model, &model) != nil || input.RepositoryID <= 0 ||
		model.Protocol == "" || model.ModelID == "" || !credentialNamePattern.MatchString(model.Credential) {
		return Binding{}, errors.New("model turn requires a repository and configured model")
	}
	if ownerID <= 0 || strings.TrimSpace(resolver.databaseURL()) == "" {
		return Binding{}, errors.New("owner model secret store is unavailable")
	}
	codec, err := webhook.NewSecretCodec(resolver.secretKey())
	if err != nil {
		return Binding{}, fmt.Errorf("open owner model secrets: %w", err)
	}
	pool, err := pgxpool.New(ctx, resolver.databaseURL())
	if err != nil {
		return Binding{}, fmt.Errorf("connect owner model secrets: %w", err)
	}
	defer pool.Close()
	read := func(name string) (string, error) {
		var encrypted []byte
		err := pool.QueryRow(ctx, `SELECT s.value_encrypted FROM repository_secrets s
			JOIN repositories r ON r.id=s.repository_id
			WHERE r.id=$1 AND r.user_id=$2 AND s.name=$3`, input.RepositoryID, ownerID, name).Scan(&encrypted)
		if errors.Is(err, pgx.ErrNoRows) {
			return "", ports.ErrModelCredentialMissing
		}
		if err != nil {
			return "", err
		}
		return codec.DecryptString(string(encrypted))
	}
	value, err := read(model.Credential)
	if err != nil {
		return Binding{}, fmt.Errorf("read owner model credential: %w", err)
	}
	if strings.TrimSpace(value) == "" {
		return Binding{}, ports.ErrModelCredentialMissing
	}
	binding := Binding{Model: input.Model, CredentialName: model.Credential, CredentialValue: value}
	if !builtinCredential(model.Credential) {
		origin, err := read(model.Credential + "_ORIGIN")
		if err != nil {
			return Binding{}, fmt.Errorf("read owner model origin: %w", err)
		}
		parsed, err := url.Parse(origin)
		if err != nil || parsed.Scheme == "" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.Path != "" {
			return Binding{}, errors.New("owner model origin is invalid")
		}
		binding.CredentialOrigin = origin
	}
	return binding, nil
}

func builtinCredential(name string) bool {
	switch name {
	case "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CEREBRAS_API_KEY", "OPENROUTER_API_KEY", "AI_GATEWAY_API_KEY":
		return true
	default:
		return false
	}
}

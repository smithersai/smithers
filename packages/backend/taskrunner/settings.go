package taskrunner

import (
	"fmt"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"io"
	"log/slog"
)

// Settings exposes only process logging; workers acquire every task over the API.
type Settings struct{ LogLevel string }

func LoadSettings(path string) (*Settings, error) {
	cfg, err := config.Load(path)
	if err != nil {
		return nil, err
	}
	return &Settings{LogLevel: cfg.Observability.LogLevel}, nil
}

func (s *Settings) Validate() error {
	if s == nil {
		return fmt.Errorf("config must not be nil")
	}
	return nil
}

func (s *Settings) Logger(w io.Writer) *slog.Logger {
	return middleware.NewServerLogger(w, s.LogLevel)
}

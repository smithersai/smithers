package ssh

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/database"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

// Settings uses the product configuration reader without exporting its full
// internal configuration or requiring hosts to maintain another parser.
type Settings struct {
	Server          Config
	ShutdownTimeout time.Duration
	database        config.DatabaseConfig
	logLevel        string
}

func LoadSettings(path string) (Settings, error) {
	cfg, err := config.Load(path)
	if err != nil {
		return Settings{}, err
	}
	settings := Settings{database: cfg.Database, logLevel: cfg.Observability.LogLevel}
	s := &settings.Server
	s.Addr, s.HostKeyDir = cfg.SSH.Addr, cfg.SSH.HostKeyDir
	s.LFSSigningSecret = cfg.Auth.LFSSigningSecret
	s.PublicAPIOrigin = cfg.Server.PublicURL
	s.AuthAttemptsPerMinute = cfg.SSH.AuthAttemptsPerMinute
	s.MaxConnections, s.MaxConnectionsPerIP = cfg.SSH.MaxConnections, cfg.SSH.MaxConnectionsPerIP
	s.MaxReceivePackSize, s.MaxUploadPackRequestSize = cfg.SSH.MaxReceivePackSize, cfg.SSH.MaxUploadPackRequestSize
	s.MaxSessionsPerConn = cfg.SSH.MaxSessionsPerConn
	for _, duration := range []struct {
		name, raw string
		target    *time.Duration
	}{
		{"receive_pack_timeout", cfg.SSH.ReceivePackTimeout, &s.ReceivePackTimeout},
		{"upload_pack_timeout", cfg.SSH.UploadPackTimeout, &s.UploadPackTimeout},
		{"idle_timeout", cfg.SSH.IdleTimeout, &s.IdleTimeout},
		{"max_timeout", cfg.SSH.MaxTimeout, &s.MaxTimeout},
		{"shutdown_drain_timeout", cfg.SSH.ShutdownDrainTimeout, &settings.ShutdownTimeout},
	} {
		if duration.raw == "" {
			continue
		}
		value, err := time.ParseDuration(duration.raw)
		if err != nil || value < 0 {
			return Settings{}, fmt.Errorf("invalid ssh.%s %q", duration.name, duration.raw)
		}
		*duration.target = value
	}
	if s.UploadPackTimeout == 0 {
		s.UploadPackTimeout = s.ReceivePackTimeout
	}
	if settings.ShutdownTimeout <= 0 {
		return Settings{}, fmt.Errorf("ssh.shutdown_drain_timeout must be positive")
	}
	return settings, nil
}

func (s Settings) OpenDatabase(ctx context.Context) (*pgxpool.Pool, error) {
	return database.NewPool(ctx, s.database)
}

func (s Settings) Logger(output io.Writer) *slog.Logger {
	return middleware.NewServerLogger(output, s.logLevel)
}

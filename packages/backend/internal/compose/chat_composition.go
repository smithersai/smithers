package compose

import (
	"errors"
	"fmt"
	"net"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/chat"
)

type chatComposition struct {
	runtime  *chat.Runtime
	listener net.Listener
	server   *http.Server
}

func newChatComposition(options runOptions, pool *pgxpool.Pool) (*chatComposition, error) {
	if options.ChatHost == nil {
		if options.ChatCallbackListener != nil || strings.TrimSpace(options.ChatProducerBaseURL) != "" {
			if options.ChatCallbackListener != nil {
				_ = options.ChatCallbackListener.Close()
			}
			return nil, errors.New("chat callback configuration requires a chat host")
		}
		return nil, nil
	}
	listener := options.ChatCallbackListener
	callbackURL := strings.TrimSpace(options.ChatProducerBaseURL)
	if !options.Role.hosted() && listener == nil {
		var err error
		listener, err = net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			return nil, fmt.Errorf("listen for local chat callbacks: %w", err)
		}
	}
	if !options.Role.hosted() && listener != nil {
		address, ok := listener.Addr().(*net.TCPAddr)
		if !ok || !address.IP.IsLoopback() {
			_ = listener.Close()
			return nil, errors.New("single-owner chat callbacks must bind loopback")
		}
	}
	if !options.Role.hosted() && listener != nil {
		actualURL := "http://" + listener.Addr().String()
		if callbackURL != "" && callbackURL != actualURL {
			if listener != nil {
				_ = listener.Close()
			}
			return nil, errors.New("single-owner chat callback URL must match its private listener")
		}
		callbackURL = actualURL
	}
	if callbackURL == "" {
		if listener != nil {
			_ = listener.Close()
		}
		return nil, errors.New("hosted chat requires an internal producer callback URL")
	}
	// Hosted workers dispatch into the shared journal through the hosted API's
	// callback URL. Only API replicas need to serve those capability-authenticated
	// routes, so workers require no listener of their own.
	runtime, err := chat.NewRuntime(pool, options.ChatHost, callbackURL, chat.RuntimeOptions{})
	if err != nil {
		if listener != nil {
			_ = listener.Close()
		}
		return nil, err
	}
	result := &chatComposition{runtime: runtime, listener: listener}
	if listener != nil {
		result.server = &http.Server{Handler: chatCallbackHandler(runtime)}
	}
	return result, nil
}

func (composition *chatComposition) close() {
	if composition != nil && composition.listener != nil {
		_ = composition.listener.Close()
	}
}

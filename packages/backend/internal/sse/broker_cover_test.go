package sse

import (
	"context"
	"errors"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

var brokerCovChannelSeq uint64

// brokerCovPool is a plain pool on the prepared test database (see
// cov_database_test.go for the readiness budget it connects under).
func brokerCovPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	covPrepareDatabase(t)
	return covOpenPool(t, covPoolConfig(t))
}

func brokerCovChannel() string {
	n := atomic.AddUint64(&brokerCovChannelSeq, 1)
	return "broker_cov_" + strconv.FormatInt(time.Now().UnixNano(), 36) + "_" + strconv.FormatUint(n, 36)
}

type brokerCovNopNotifier struct {
	listenErr error
}

func (n brokerCovNopNotifier) waitForNotificationWithChannel(ctx context.Context) (string, string, error) {
	<-ctx.Done()
	return "", "", ctx.Err()
}

func (n brokerCovNopNotifier) release() {}

func (n brokerCovNopNotifier) listen(context.Context, string) error {
	return n.listenErr
}

func (n brokerCovNopNotifier) unlisten(context.Context, string) error {
	return nil
}

type brokerCovNotification struct {
	channel string
	payload string
}

type brokerCovSequenceNotifier struct {
	notifications chan brokerCovNotification
}

func (n *brokerCovSequenceNotifier) waitForNotificationWithChannel(ctx context.Context) (string, string, error) {
	select {
	case notification := <-n.notifications:
		return notification.channel, notification.payload, nil
	case <-ctx.Done():
		return "", "", ctx.Err()
	}
}

func (n *brokerCovSequenceNotifier) release() {}

func (n *brokerCovSequenceNotifier) listen(context.Context, string) error {
	return nil
}

func (n *brokerCovSequenceNotifier) unlisten(context.Context, string) error {
	return nil
}

func TestBroker_Cov_StartSuccessSubscribesAndStops(t *testing.T) {
	applicationName := handlerCovChannel("broker_start_app")
	pool := handlerCovPoolWithApplicationName(t, applicationName)
	adminPool := brokerCovPool(t)
	broker := NewBroker(pool)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	require.NoError(t, broker.Start(ctx))
	// Stop before the pool cleanup closes: a failed assertion below must not
	// leave the broker holding its pooled connection, which would wedge
	// pool.Close() in t.Cleanup forever.
	t.Cleanup(broker.Stop)
	sub, err := broker.Subscribe(ctx, brokerCovChannel(), 101)
	require.NoError(t, err)
	assert.NotNil(t, sub.Events())

	// Kill the shared LISTEN connection out from under the broker (as a Cloud
	// SQL failover would). The broker must disconnect stale subscribers so
	// their clients reconnect, then self-heal onto a fresh pool connection
	// instead of dying until a restart.
	handlerCovTerminateBackend(t, adminPool, handlerCovFindBackendPID(t, adminPool, applicationName))

	select {
	case _, ok := <-sub.Events():
		require.False(t, ok, "subscriber channel must close on connection loss")
	case <-time.After(2 * time.Second):
		t.Fatal("subscriber was not disconnected after connection loss")
	}

	require.Eventually(t, func() bool {
		s, subErr := broker.Subscribe(context.Background(), brokerCovChannel(), 101)
		if subErr != nil {
			return false
		}
		broker.Unsubscribe(s)
		return true
	}, 5*time.Second, 50*time.Millisecond, "broker did not reconnect after connection loss")

	broker.Stop()
	select {
	case <-broker.connLost:
	case <-time.After(2 * time.Second):
		t.Fatal("broker dispatch did not stop")
	}
}

func TestBroker_Cov_StartAcquireError(t *testing.T) {
	pool := brokerCovPool(t)
	pool.Close()

	broker := NewBroker(pool)
	err := broker.Start(context.Background())
	require.Error(t, err)
	assert.Contains(t, err.Error(), "sse broker: acquire connection")
}

func TestBroker_Cov_SubscribeValidationAlreadyListeningAndRace(t *testing.T) {
	ctx := context.Background()

	broker := NewBroker(nil)
	_, err := broker.Subscribe(ctx, "bad-channel", 1)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "invalid character")

	broker.channels["already_listening"] = struct{}{}
	sub, err := broker.Subscribe(ctx, "already_listening", 2)
	require.NoError(t, err)
	assert.Equal(t, int64(2), sub.sub.userID)
	broker.Unsubscribe(sub)

	racing := NewBroker(nil)
	racing.MaxStreamsPerUser = 1
	racing.conn = brokerCovNopNotifier{}

	// Stand in for the dispatch goroutine, which drains b.control in a LOOP until
	// done/connLost. It must serve BOTH commands this path issues: the LISTEN, and
	// the UNLISTEN that cleans up the orphaned LISTEN once the cap re-check
	// rejects the subscribe. A one-shot fake would deadlock the (correct) cleanup.
	listened := make(chan struct{})
	unlistened := make(chan struct{})
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		for {
			select {
			case cmd := <-racing.control:
				if cmd.unlisten {
					close(unlistened)
				} else {
					// Simulate losing the cap race: another subscribe filled the slot
					// while this one was issuing its LISTEN outside the lock.
					racing.mu.Lock()
					racing.userCounts[7] = 1
					racing.mu.Unlock()
					close(listened)
				}
				cmd.resp <- nil
			case <-stop:
				return
			}
		}
	}()

	_, err = racing.Subscribe(ctx, "race_channel", 7)
	<-listened
	// The rejected subscribe must not strand its LISTEN on the shared connection.
	<-unlistened
	var tooMany *ErrTooManyStreams
	require.ErrorAs(t, err, &tooMany)
	assert.Equal(t, int64(7), tooMany.UserID)
	assert.Equal(t, 1, tooMany.Max)
}

func TestBroker_Cov_ListenErrors(t *testing.T) {
	t.Run("not_started", func(t *testing.T) {
		broker := NewBroker(nil)
		err := broker.listen(context.Background(), "missing_conn")
		require.Error(t, err)
		assert.Contains(t, err.Error(), "no notification connection")
	})

	t.Run("stopped_before_control_send", func(t *testing.T) {
		broker := NewBroker(nil)
		broker.conn = brokerCovNopNotifier{}
		close(broker.done)

		err := broker.listen(context.Background(), "stopped_channel")
		require.Error(t, err)
		assert.Contains(t, err.Error(), "stopped")
	})

	t.Run("listen_command_error", func(t *testing.T) {
		broker := NewBroker(nil)
		broker.conn = brokerCovNopNotifier{listenErr: errors.New("listen exploded")}
		go broker.dispatch()

		err := broker.listen(context.Background(), "error_channel")
		require.Error(t, err)
		assert.Contains(t, err.Error(), "sse broker: LISTEN error_channel")
		assert.Contains(t, err.Error(), "listen exploded")

		broker.Stop()
		select {
		case <-broker.connLost:
		case <-time.After(2 * time.Second):
			t.Fatal("broker dispatch did not stop after listen error test")
		}
	})
}

func TestBroker_Cov_ListenSecondSelectReturnsTerminalSignals(t *testing.T) {
	tests := []struct {
		name       string
		trigger    func(*Broker, context.CancelFunc)
		wantErrSub string
	}{
		{
			name: "done",
			trigger: func(b *Broker, _ context.CancelFunc) {
				close(b.done)
			},
			wantErrSub: "stopped",
		},
		{
			name: "connection_lost",
			trigger: func(b *Broker, _ context.CancelFunc) {
				close(b.connLost)
			},
			wantErrSub: "notification connection lost",
		},
		{
			name: "context_cancelled",
			trigger: func(_ *Broker, cancel context.CancelFunc) {
				cancel()
			},
			wantErrSub: context.Canceled.Error(),
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			broker := NewBroker(nil)
			broker.conn = brokerCovNopNotifier{}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()

			errCh := make(chan error, 1)
			go func() {
				errCh <- broker.listen(ctx, "blocked_response")
			}()

			cmd := <-broker.control
			require.NotNil(t, cmd.resp)
			tt.trigger(broker, cancel)

			select {
			case err := <-errCh:
				require.Error(t, err)
				assert.Contains(t, err.Error(), tt.wantErrSub)
			case <-time.After(2 * time.Second):
				t.Fatal("listen did not return after terminal signal")
			}
		})
	}
}

func TestBroker_Cov_UnsubscribeNilAndMissingSubscription(t *testing.T) {
	broker := NewBroker(nil)

	require.NotPanics(t, func() {
		broker.Unsubscribe(nil)
	})

	sub := &Subscription{
		broker:   broker,
		channels: []string{"missing"},
		sub: &subscriber{
			ch:     make(chan Event, 1),
			userID: 9,
		},
	}
	require.NotPanics(t, func() {
		broker.Unsubscribe(sub)
	})
	select {
	case <-sub.Events():
		t.Fatal("missing subscription should not have been closed")
	default:
	}
}

func TestBroker_Cov_DispatchDeliversNotificationResultBranch(t *testing.T) {
	fake := &brokerCovSequenceNotifier{
		notifications: make(chan brokerCovNotification, 1),
	}
	broker := NewBroker(nil)
	broker.conn = fake
	sub := &subscriber{ch: make(chan Event, subscriberBufSize), userID: 55}
	broker.subscribers["dispatch_channel"] = []*subscriber{sub}
	fake.notifications <- brokerCovNotification{channel: "dispatch_channel", payload: "dispatch_payload"}

	go broker.dispatch()

	select {
	case event := <-sub.ch:
		assert.Equal(t, "dispatch_channel", event.Type)
		assert.Equal(t, "dispatch_payload", event.Data)
	case <-time.After(2 * time.Second):
		t.Fatal("dispatch did not fan out notification")
	}

	broker.Stop()
	select {
	case <-broker.connLost:
	case <-time.After(2 * time.Second):
		t.Fatal("broker dispatch did not stop")
	}
}

func TestBroker_Cov_ErrTooManyStreamsError(t *testing.T) {
	err := (&ErrTooManyStreams{UserID: 42, Max: 3}).Error()
	assert.Equal(t, "sse: user 42 has reached the maximum of 3 concurrent SSE streams", err)
}

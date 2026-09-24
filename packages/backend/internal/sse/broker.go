package sse

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
)

// brokerStopTimeout bounds how long Stop waits for the dispatch goroutine to
// release its hold on the shared connection before releasing it anyway.
var brokerStopTimeout = 5 * time.Second

const brokerUnlistenTimeout = 3 * time.Second

// brokerListenTimeout bounds a LISTEN issued on the dispatch goroutine, which
// owns all NOTIFY fan-out: a stalled LISTEN must not freeze every subscriber.
// pgx closes a connection whose query is cancelled, so the next wait fails
// and dispatch recovers the connection.
const brokerListenTimeout = 3 * time.Second

// maxReconnectBackoff caps the exponential backoff between attempts to
// re-establish the shared notification connection after it is lost.
const maxReconnectBackoff = 30 * time.Second

const (
	// DefaultMaxStreamsPerUser is the maximum number of concurrent SSE streams
	// allowed per user. Callers may override this via Broker.MaxStreamsPerUser.
	DefaultMaxStreamsPerUser = 5

	// subscriberBufSize is the buffered channel depth for each subscriber.
	// It matches the pre-broker per-client listener buffer (100) so ordinary
	// jitter does not trip the slow-client disconnect in dispatchNotification.
	// A subscriber that cannot keep up even with this much headroom is
	// disconnected (not silently truncated) so its EventSource reconnects.
	subscriberBufSize = 100
)

// subscriber represents a single SSE client registered with the Broker.
//
// A subscriber may be registered under multiple channels (see SubscribeMulti),
// so it appears in more than one b.subscribers slice. The closed flag guards its
// event channel against a double close — both Unsubscribe and Stop consult it
// under b.mu so the chan is closed exactly once no matter how many channels the
// subscriber spans.
type subscriber struct {
	ch     chan Event
	userID int64
	// channels lists every distinct PostgreSQL channel this subscriber is
	// registered under, so a disconnect originating in dispatchNotification (which
	// only has the subscriber, not its Subscription) can remove it from all of
	// them. SubscribeMulti sets this to the same slice as Subscription.channels.
	channels []string
	closed   bool
}

// Broker multiplexes PostgreSQL LISTEN/NOTIFY over a single shared connection,
// fanning out each NOTIFY payload to all registered subscribers for that channel.
//
// # Connection model
//
// The Broker acquires ONE pgx connection from the pool on Start() and keeps it
// for its lifetime. All callers share that one connection, so SSE clients no
// longer consume one pool slot each.
//
// # Usage
//
//	broker := sse.NewBroker(pool)
//	broker.MaxStreamsPerUser = 5
//	if err := broker.Start(ctx); err != nil { ... }
//	defer broker.Stop()
//
//	// In an HTTP handler:
//	sub, err := broker.Subscribe(ctx, "user_notifications_42", userID)
//	if err != nil { /* handle 429 or other error */ }
//	defer broker.Unsubscribe(sub)
//	for event := range sub.Events() { ... }
type Broker struct {
	subscriptionCount atomic.Int64
	channelCount      atomic.Int64
	slowDisconnects   prometheus.Counter
	relistens         prometheus.Counter
	rejections        *prometheus.CounterVec
	// acquireConn obtains a fresh shared connection from the pool. It is set by
	// NewBroker (when given a non-nil pool) and used by Start and by the
	// reconnect path after a lost connection. When nil (tests that inject a fake
	// notifier directly), a lost connection is unrecoverable and dispatch exits.
	acquireConn func(ctx context.Context) (brokerNotifier, error)

	// MaxStreamsPerUser caps the number of concurrent SSE subscriptions per user.
	// Zero means DefaultMaxStreamsPerUser.
	MaxStreamsPerUser int

	mu          sync.Mutex
	subscribers map[string][]*subscriber // channel → slice of active subscribers
	userCounts  map[int64]int            // userID → current active subscription count
	channels    map[string]struct{}      // channels currently LISTENed on this connection
	// pendingSubs counts Subscribe calls that have passed the initial LISTEN
	// decision but have not yet registered their subscriber, per channel. It lets
	// an in-flight UNLISTEN see that a re-subscribe is racing and skip the
	// UNLISTEN, so a channel is never left LISTEN-less while a live subscriber
	// exists. When a channel's subscriber slice AND pendingSubs both reach zero we
	// UNLISTEN and drop the channel, so the LISTEN set on the single shared
	// connection does not grow without bound (e.g. per-workflow-step channels).
	pendingSubs map[string]int

	// conn is the single shared pgx connection. After Start it is mutated only
	// by the dispatch goroutine (the reconnect path swaps in a fresh connection,
	// clearing it to nil while disconnected); all writes and non-dispatch reads
	// happen under b.mu. Stop synchronizes with dispatch via connLost before
	// releasing it.
	conn    brokerNotifier
	control chan brokerControl
	done    chan struct{}
	// connLost is closed by dispatch() when it exits for good — on
	// Stop-triggered cancellation OR on a lost Postgres connection that cannot
	// be re-established (no acquireConn). Once it is closed nobody drains
	// `control`, so listen() must fail fast instead of blocking forever on the
	// unbuffered control send. A recoverable connection loss does NOT close it:
	// dispatch reconnects and keeps running.
	connLost chan struct{}
	// dispatching reports whether Start launched the dispatch goroutine, i.e.
	// whether anything actually owns the shared connection.
	dispatching atomic.Bool
	once        sync.Once
}

type brokerControl struct {
	channel string
	// unlisten selects UNLISTEN instead of LISTEN when the dispatch goroutine
	// processes this command. Both run on the dispatch goroutine because it owns
	// the shared connection.
	unlisten bool
	resp     chan error
}

// NewBroker creates a Broker backed by pool. Call Start to connect.
func NewBroker(pool *pgxpool.Pool) *Broker {
	b := &Broker{
		slowDisconnects: prometheus.NewCounter(prometheus.CounterOpts{Name: "smithers_sse_slow_client_disconnects_total", Help: "Subscriptions disconnected because their event buffer is full."}),
		relistens:       prometheus.NewCounter(prometheus.CounterOpts{Name: "smithers_sse_broker_relistens_total", Help: "Successful broker connection recoveries, including restoration of expected LISTENs."}),
		rejections:      prometheus.NewCounterVec(prometheus.CounterOpts{Name: "smithers_sse_subscribe_rejections_total", Help: "Rejected broker subscriptions by reason."}, []string{"reason"}),
		subscribers:     make(map[string][]*subscriber),
		userCounts:      make(map[int64]int),
		channels:        make(map[string]struct{}),
		pendingSubs:     make(map[string]int),
		control:         make(chan brokerControl),
		done:            make(chan struct{}),
		connLost:        make(chan struct{}),
	}
	if pool != nil {
		b.acquireConn = func(ctx context.Context) (brokerNotifier, error) {
			conn, err := pool.Acquire(ctx)
			if err != nil {
				return nil, err
			}
			return &pgxMultiNotifier{conn: conn}, nil
		}
	}
	return b
}

// Start acquires a shared connection from the pool and begins dispatching
// PostgreSQL notifications to subscribers. It must be called exactly once
// before any Subscribe calls.
//
// The provided context is used only for the initial connection acquisition;
// the dispatch loop runs until Stop is called.
func (b *Broker) Start(ctx context.Context) error {
	if b.acquireConn == nil {
		return fmt.Errorf("sse broker: no connection pool")
	}
	conn, err := b.acquireConn(ctx)
	if err != nil {
		return fmt.Errorf("sse broker: acquire connection: %w", err)
	}
	b.conn = conn
	// Set BEFORE launching dispatch so a Stop racing Start still observes that a
	// goroutine owns the connection and waits for it (see Stop).
	b.dispatching.Store(true)
	go b.dispatch()
	return nil
}

// Stop shuts down the broker, releases the shared connection, and closes all
// subscriber channels. Safe to call multiple times.
func (b *Broker) Stop() {
	b.once.Do(func() {
		close(b.done)
		// Wait for dispatch to exit before releasing the pooled connection: it
		// may still be blocked inside waitForNotification on THIS conn, and
		// releasing it back to the pool underneath would be a use-after-release
		// (another caller could acquire the same conn concurrently). close(b.done)
		// above cancels dispatch's wait; dispatch closes connLost as it exits.
		// If dispatch already died unrecoverably, connLost is closed and this
		// returns immediately. The timeout keeps a wedged pgx call from hanging
		// shutdown forever.
		//
		// Only wait when Start actually launched dispatch. A broker whose conn was
		// installed without Start (tests inject a fake notifier) has no goroutine
		// to wait for, and connLost would never close.
		straggler := false
		if b.dispatching.Load() {
			select {
			case <-b.connLost:
			case <-time.After(brokerStopTimeout):
				straggler = true
				slog.Warn("sse broker: dispatch goroutine did not exit before timeout; discarding connection")
			}
		}
		// Close all outstanding subscriber channels so range loops terminate.
		// A subscriber registered under N channels appears in N slices, so guard
		// on s.closed to close each distinct channel exactly once (a double close
		// would panic). b.conn is read under b.mu because the reconnect path
		// swaps it; the <-b.connLost above orders those writes before this read.
		b.mu.Lock()
		defer b.mu.Unlock()
		if b.conn != nil {
			if straggler {
				// dispatch may still be inside a call on this conn. Returning it
				// to the pool would hand it to a concurrent caller, so close the
				// physical connection instead; that also unblocks dispatch.
				discardNotifier(b.conn)
			} else {
				b.conn.release()
			}
			b.conn = nil
		}
		for _, subs := range b.subscribers {
			for _, s := range subs {
				if !s.closed {
					s.closed = true
					close(s.ch)
				}
			}
		}
		b.subscribers = make(map[string][]*subscriber)
		b.userCounts = make(map[int64]int)
		b.channels = make(map[string]struct{})
		b.subscriptionCount.Store(0)
		b.channelCount.Store(0)
	})
}

// Subscription is a handle returned by Subscribe/SubscribeMulti. Callers range
// over Events() and must call broker.Unsubscribe when done (usually via defer).
type Subscription struct {
	broker *Broker
	// channels lists every PostgreSQL channel this subscription is registered
	// under. Single-channel subscriptions have exactly one entry.
	channels []string
	sub      *subscriber
}

// Events returns the channel that receives fan-out events for this subscription.
// The channel is closed when the broker is stopped.
func (s *Subscription) Events() <-chan Event {
	return s.sub.ch
}

// ActiveConnections returns the number of live SSE streams this broker is
// serving, across every user. A multi-channel subscription counts once, the
// same way it counts against the per-user cap, so the number matches the
// smithers_sse_active_connections gauge the SSE handlers maintain.
//
// It reads only this pod's in-process state: a multi-pod deployment reports the
// fleet total by summing the pods. A nil broker reports 0, so a caller can wire
// it before the broker exists.
func (b *Broker) ActiveConnections() int {
	if b == nil {
		return 0
	}
	return int(b.subscriptionCount.Load())
}

// maxStreams returns the effective per-user cap.
func (b *Broker) maxStreams() int {
	if b.MaxStreamsPerUser > 0 {
		return b.MaxStreamsPerUser
	}
	return DefaultMaxStreamsPerUser
}

// Subscribe registers a new subscriber on the given PostgreSQL channel for
// the given user. If the user already has maxStreams active subscriptions,
// Subscribe returns ErrTooManyStreams.
//
// Subscribe issues a LISTEN statement for the channel if this is the first
// subscriber on that channel. The LISTEN is idempotent in PostgreSQL so
// repeated calls for the same channel are harmless.
func (b *Broker) Subscribe(ctx context.Context, channel string, userID int64) (*Subscription, error) {
	return b.SubscribeMulti(ctx, []string{channel}, userID)
}

// SubscribeMulti registers a single subscriber fanned in from several
// PostgreSQL channels at once. Every notification on any of the channels is
// delivered to the one returned Subscription, with Event.Type set to the
// originating channel.
//
// The whole subscription counts as ONE stream against the per-user cap. A
// LISTEN is issued for each channel not already listened on the shared
// connection; LISTEN is idempotent in PostgreSQL so repeats are harmless.
func (b *Broker) SubscribeMulti(ctx context.Context, channels []string, userID int64) (*Subscription, error) {
	if len(channels) == 0 {
		return nil, fmt.Errorf("sse broker: no channels")
	}
	for _, channel := range channels {
		if err := validateChannel(channel); err != nil {
			return nil, err
		}
	}

	// The distinct channels this subscription fans in from, in first-seen order.
	distinct := make([]string, 0, len(channels))
	seen := make(map[string]struct{}, len(channels))
	for _, channel := range channels {
		if _, dup := seen[channel]; dup {
			continue
		}
		seen[channel] = struct{}{}
		distinct = append(distinct, channel)
	}

	b.mu.Lock()
	if b.userCounts[userID] >= b.maxStreams() {
		b.rejections.WithLabelValues("per_user_cap").Inc()
		b.mu.Unlock()
		return nil, &ErrTooManyStreams{UserID: userID, Max: b.maxStreams()}
	}
	// Mark every channel as having a subscribe in flight, then collect the ones
	// that still need a LISTEN issued. pendingSubs holds a concurrent UNLISTEN off
	// these channels until this subscriber is registered (or the attempt fails),
	// so a channel is never UNLISTENed out from under a subscriber that skipped
	// the (idempotent) LISTEN because b.channels already listed it.
	needListen := make([]string, 0, len(distinct))
	for _, channel := range distinct {
		b.pendingSubs[channel]++
		if _, listening := b.channels[channel]; !listening {
			needListen = append(needListen, channel)
		}
	}
	b.mu.Unlock()

	// Issue LISTEN outside the lock: listen() round-trips through the dispatch
	// goroutine, which needs b.mu to deliver notifications, so holding it here
	// would deadlock.
	//
	// Track what THIS attempt actually LISTENed. b.channels is only written once
	// the subscriber registers below, so an attempt that fails or is rejected
	// after issuing LISTEN would otherwise leave a live, untracked LISTEN pinned
	// on the shared connection that nothing ever UNLISTENs.
	listened := make([]string, 0, len(needListen))
	for _, channel := range needListen {
		if err := b.listen(ctx, channel); err != nil {
			b.releasePending(distinct)
			b.unlistenOrphans(listened)
			return nil, err
		}
		listened = append(listened, channel)
	}

	b.mu.Lock()

	// Release the pending marks now that we commit (or reject) under the lock; the
	// register loop below (still holding b.mu) makes b.subscribers non-empty
	// before any UNLISTEN could observe the zeroed pendingSubs.
	for _, channel := range distinct {
		b.pendingSubs[channel]--
		if b.pendingSubs[channel] <= 0 {
			delete(b.pendingSubs, channel)
		}
	}

	// The cap is re-checked here because the first check raced with concurrent
	// subscribes. Losing that race must not strand the LISTENs issued above.
	if b.userCounts[userID] >= b.maxStreams() {
		b.rejections.WithLabelValues("per_user_cap").Inc()
		max := b.maxStreams()
		b.mu.Unlock()
		b.unlistenOrphans(listened)
		return nil, &ErrTooManyStreams{UserID: userID, Max: max}
	}

	sub := &subscriber{
		ch:       make(chan Event, subscriberBufSize),
		userID:   userID,
		channels: distinct,
	}
	// Register the one subscriber under every distinct channel so a NOTIFY on
	// any of them fans in to its single event chan.
	for _, channel := range distinct {
		b.channels[channel] = struct{}{}
		b.subscribers[channel] = append(b.subscribers[channel], sub)
	}
	b.userCounts[userID]++
	b.subscriptionCount.Add(1)
	b.channelCount.Store(int64(len(b.channels)))
	b.mu.Unlock()

	return &Subscription{broker: b, channels: distinct, sub: sub}, nil
}

// unlistenOrphans drops LISTENs issued by a Subscribe attempt that never
// registered a subscriber (LISTEN error, or the per-user cap re-check rejecting
// it). unlistenIfIdleLocked runs on the dispatch goroutine and re-checks idleness
// under b.mu, so a channel a concurrent subscriber has since adopted is kept.
//
// Must NOT be called while holding b.mu: unlisten round-trips through the
// dispatch goroutine, which needs the lock.
func (b *Broker) unlistenOrphans(listened []string) {
	for _, channel := range listened {
		b.unlisten(channel)
	}
}

// releasePending drops the in-flight subscribe marks for channels when a
// Subscribe attempt fails before registering (e.g. LISTEN error), so a failed
// attempt cannot pin a channel's LISTEN forever.
func (b *Broker) releasePending(channels []string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, channel := range channels {
		b.pendingSubs[channel]--
		if b.pendingSubs[channel] <= 0 {
			delete(b.pendingSubs, channel)
		}
	}
}

// connected reports whether the broker currently holds a shared connection.
// It is false before Start, after Stop, and while the reconnect path is
// re-establishing a lost connection.
func (b *Broker) connected() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.conn != nil
}

func (b *Broker) listen(ctx context.Context, channel string) error {
	if !b.connected() {
		return fmt.Errorf("sse broker: no notification connection")
	}
	resp := make(chan error, 1)
	cmd := brokerControl{channel: channel, resp: resp}
	select {
	case b.control <- cmd:
	case <-b.done:
		return fmt.Errorf("sse broker: stopped")
	case <-b.connLost:
		return fmt.Errorf("sse broker: notification connection lost")
	case <-ctx.Done():
		return ctx.Err()
	}
	select {
	case err := <-resp:
		if err != nil {
			return fmt.Errorf("sse broker: LISTEN %s: %w", channel, err)
		}
		return nil
	case <-b.done:
		return fmt.Errorf("sse broker: stopped")
	case <-b.connLost:
		return fmt.Errorf("sse broker: notification connection lost")
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Unsubscribe removes a subscription from every channel it was registered under,
// decrements the per-user counter once, and closes the subscriber's event channel
// so the HTTP handler's range loop exits. Safe to call multiple times.
//
// When the last subscriber for a channel leaves, Unsubscribe issues an UNLISTEN
// and drops the channel, so the LISTEN set on the shared connection does not grow
// without bound over the server's lifetime (notably high-cardinality per-step
// workflow channels).
func (b *Broker) Unsubscribe(sub *Subscription) {
	if sub == nil {
		return
	}
	b.mu.Lock()
	emptied := b.removeSubscriberLocked(sub.sub, sub.channels)
	b.mu.Unlock()

	// Issue UNLISTEN outside b.mu: unlisten() round-trips through the dispatch
	// goroutine (which needs b.mu to deliver notifications), and the dispatch
	// handler re-checks under b.mu that the channel is still idle, so a racing
	// re-subscribe keeps the channel listening.
	for _, channel := range emptied {
		b.unlisten(channel)
	}
}

// removeSubscriberLocked removes s from each of the given channels, and — only on
// the first call for a given subscriber — decrements the per-user counter and
// closes its event channel. It returns the channels whose last subscriber this
// removed (candidates for UNLISTEN). b.mu must be held.
//
// The channels argument is passed explicitly (rather than read from s.channels)
// so the same helper serves both Unsubscribe (which has the Subscription's
// channel list) and the slow-client disconnect path in dispatchNotification
// (which has only the subscriber and passes s.channels).
func (b *Broker) removeSubscriberLocked(s *subscriber, channels []string) (emptied []string) {
	if s == nil || s.closed {
		return nil
	}

	removed := false
	for _, channel := range channels {
		subs := b.subscribers[channel]
		for i, cand := range subs {
			if cand == s {
				// Remove by swapping with the last element.
				subs[i] = subs[len(subs)-1]
				b.subscribers[channel] = subs[:len(subs)-1]
				removed = true
				break
			}
		}
		if len(b.subscribers[channel]) == 0 {
			// Reclaim the empty slice/map entry immediately; the channel is a
			// candidate for UNLISTEN once no subscribe is in flight for it.
			delete(b.subscribers, channel)
			emptied = append(emptied, channel)
		}
	}

	// Only close/decrement when this call actually removed the subscriber, and
	// only once even for a multi-channel subscription (or a repeated call). A
	// subscriber still present in b.subscribers is guaranteed open: Stop() and
	// this helper both remove and close under b.mu, guarded by s.closed.
	if !removed {
		return nil
	}
	s.closed = true
	b.userCounts[s.userID]--
	b.subscriptionCount.Add(-1)
	if b.userCounts[s.userID] <= 0 {
		delete(b.userCounts, s.userID)
	}
	close(s.ch)
	return emptied
}

// unlisten asks the dispatch goroutine to UNLISTEN channel and drop it from the
// LISTEN set. It is a no-op if the broker was never started (no shared
// connection) or has stopped. Callers must NOT hold b.mu.
func (b *Broker) unlisten(channel string) {
	if !b.connected() {
		return
	}
	resp := make(chan error, 1)
	cmd := brokerControl{channel: channel, unlisten: true, resp: resp}
	// Deliberately not tied to a request context: Unsubscribe usually runs from a
	// deferred cleanup whose request context is already cancelled, and the cleanup
	// must still complete. b.done/b.connLost bound the wait.
	select {
	case b.control <- cmd:
	case <-b.done:
		return
	case <-b.connLost:
		return
	}
	select {
	case err := <-resp:
		if err != nil {
			slog.Warn("sse broker: UNLISTEN failed", "channel", channel, "error", err)
		}
	case <-b.done:
	case <-b.connLost:
	}
}

// unlistenIfIdleLocked issues UNLISTEN and drops channel from the LISTEN set iff
// no subscribers remain AND no Subscribe is in flight for it. b.mu MUST be held
// and it MUST run on the dispatch goroutine, since it touches the shared
// connection. Holding b.mu across the exec keeps a concurrent Subscribe from
// re-registering between the idle check and the UNLISTEN.
func (b *Broker) unlistenIfIdleLocked(channel string) error {
	if len(b.subscribers[channel]) > 0 || b.pendingSubs[channel] > 0 {
		return nil
	}
	delete(b.channels, channel)
	b.channelCount.Store(int64(len(b.channels)))
	if b.conn == nil {
		// Stop released the connection (e.g. after its wait timeout); the LISTEN
		// died with it, so there is nothing to UNLISTEN.
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), brokerUnlistenTimeout)
	defer cancel()
	return b.conn.unlisten(ctx, channel)
}

// listenWithTimeout issues LISTEN under brokerListenTimeout and logs a failure
// with its channel.
func listenWithTimeout(conn brokerNotifier, channel string) error {
	ctx, cancel := context.WithTimeout(context.Background(), brokerListenTimeout)
	defer cancel()
	err := conn.listen(ctx, channel)
	if err != nil {
		slog.Warn("sse broker: LISTEN failed", "channel", channel, "error", err)
	}
	return err
}

// dispatch is the background goroutine that calls WaitForNotification on the
// shared connection and fans out each notification to all matching subscribers.
func (b *Broker) dispatch() {
	// Mark the connection as owned by a live goroutine. Start also sets this
	// before launching us (closing the Start/Stop race); setting it here as well
	// covers callers that launch dispatch directly. Stop consults it to decide
	// whether it must wait for us before releasing the connection.
	b.dispatching.Store(true)

	// Signal any current/future listen() callers the moment this goroutine
	// exits — whether from Stop() or a lost connection — so they fail fast
	// instead of blocking forever on the unbuffered control channel. dispatch
	// runs at most once (Start is called once), so this never double-closes.
	defer close(b.connLost)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go func() {
		<-b.done
		cancel()
	}()

	for {
		// Snapshot the shared connection under b.mu: Stop() nils b.conn (under
		// b.mu) when it releases the connection, and the wait goroutine below
		// must never read the field directly — that read would race the Stop
		// write (and nil-deref when a Stop races a directly-launched dispatch
		// before this loop first runs).
		b.mu.Lock()
		conn := b.conn
		b.mu.Unlock()
		if conn == nil {
			// Stop already released the connection; nothing to wait on.
			return
		}

		waitCtx, waitCancel := context.WithCancel(ctx)
		type notificationResult struct {
			channel string
			payload string
			err     error
		}
		notifications := make(chan notificationResult, 1)
		go func() {
			channel, payload, err := conn.waitForNotificationWithChannel(waitCtx)
			notifications <- notificationResult{channel: channel, payload: payload, err: err}
		}()

		select {
		case cmd := <-b.control:
			waitCancel()
			result := <-notifications
			if result.err == nil {
				// The wait goroutine had already received a real NOTIFY before
				// the control command won the select — deliver it instead of
				// silently dropping it. (A canceled-context error here is the
				// expected waitCancel() result and is ignored; a genuine
				// connection error recurs on the next loop and hits the return
				// below.)
				b.dispatchNotification(result.channel, result.payload)
			}
			if cmd.unlisten {
				b.mu.Lock()
				err := b.unlistenIfIdleLocked(cmd.channel)
				b.mu.Unlock()
				cmd.resp <- err
			} else {
				cmd.resp <- listenWithTimeout(conn, cmd.channel)
			}
			continue
		case result := <-notifications:
			waitCancel()
			if result.err != nil {
				// A clean shutdown (Stop closed b.done) just exits.
				select {
				case <-b.done:
					return
				default:
				}
				// Real connection loss (e.g. a Cloud SQL failover reaping the
				// long-held LISTEN connection). Without a pool to reconnect
				// from, the broker is dead — after this return nobody drains
				// control and Subscribe fails fast via connLost.
				if b.acquireConn == nil {
					slog.Error("sse broker: notification connection lost; broker stopped", "error", result.err)
					b.dropAllSubscribers()
					return
				}
				slog.Error("sse broker: notification connection lost; reconnecting", "error", result.err)
				if !b.recoverConnection(ctx) {
					return
				}
				continue
			}
			b.dispatchNotification(result.channel, result.payload)
		}
	}
}

// recoverConnection handles a lost notification connection. It disconnects
// every subscriber — their handlers' range loops exit, so EventSource clients
// reconnect and replay missed events via Last-Event-ID instead of hanging on
// keep-alives while silently missing NOTIFYs — releases the dead connection,
// then re-acquires a fresh one with capped exponential backoff and re-issues
// LISTEN for any channel an in-flight Subscribe still expects. It returns
// false when the broker is stopping (ctx is the dispatch context, cancelled
// by Stop).
func (b *Broker) recoverConnection(ctx context.Context) bool {
	b.dropAllSubscribers()

	// Clear b.conn while disconnected so Subscribe/Unsubscribe fail fast on the
	// connected() check instead of blocking on the control channel, and release
	// the dead connection back to the pool so it can be destroyed.
	b.mu.Lock()
	dead := b.conn
	b.conn = nil
	b.mu.Unlock()
	if dead != nil {
		dead.release()
	}

	backoff := time.Second
	for {
		if ctx.Err() != nil {
			return false
		}
		conn, err := b.acquireConn(ctx)
		if err == nil {
			if b.relisten(conn) {
				slog.Info("sse broker: notification connection re-established")
				return true
			}
		} else {
			if ctx.Err() != nil {
				return false
			}
			slog.Warn("sse broker: reconnect failed; retrying", "error", err, "backoff", backoff)
		}

		timer := time.NewTimer(backoff)
	drain:
		for {
			select {
			case cmd := <-b.control:
				// Keep draining control during the backoff so a caller that
				// passed the connected() check just before the loss fails fast
				// instead of blocking forever on the unbuffered send.
				cmd.resp <- fmt.Errorf("sse broker: reconnecting to postgres")
			case <-ctx.Done():
				timer.Stop()
				return false
			case <-timer.C:
				break drain
			}
		}
		backoff *= 2
		if backoff > maxReconnectBackoff {
			backoff = maxReconnectBackoff
		}
	}
}

// dropAllSubscribers closes every subscriber channel and resets the
// subscriber/user/channel bookkeeping. Used on connection loss: the LISTEN
// registrations died with the connection, and closing the event channels makes
// clients reconnect (and re-subscribe) rather than hang on keep-alives.
// pendingSubs is deliberately left intact — in-flight Subscribe calls own
// those marks and release them on their own failure or registration.
func (b *Broker) dropAllSubscribers() {
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, subs := range b.subscribers {
		for _, s := range subs {
			if !s.closed {
				s.closed = true
				close(s.ch)
			}
		}
	}
	b.subscribers = make(map[string][]*subscriber)
	b.userCounts = make(map[int64]int)
	b.channels = make(map[string]struct{})
	b.subscriptionCount.Store(0)
	b.channelCount.Store(0)
}

// relisten installs conn as the shared connection and re-issues LISTEN for
// every channel still expected by an in-flight or already-registered
// subscriber (a Subscribe racing the connection loss may have skipped its
// LISTEN because b.channels listed the channel on the dead connection). On
// LISTEN failure it releases conn and returns false so recoverConnection
// backs off and retries.
func (b *Broker) relisten(conn brokerNotifier) bool {
	b.mu.Lock()
	total := len(b.channels) + len(b.pendingSubs) + len(b.subscribers)
	seen := make(map[string]struct{}, total)
	channels := make([]string, 0, total)
	add := func(ch string) {
		if _, dup := seen[ch]; dup {
			return
		}
		seen[ch] = struct{}{}
		channels = append(channels, ch)
	}
	for ch := range b.channels {
		add(ch)
	}
	for ch := range b.pendingSubs {
		add(ch)
	}
	for ch := range b.subscribers {
		add(ch)
	}
	// Publish the connection before issuing the LISTENs: new Subscribe calls
	// pass connected() and queue on control, which the dispatch loop resumes
	// draining as soon as this returns.
	b.conn = conn
	b.mu.Unlock()

	for _, ch := range channels {
		if err := listenWithTimeout(conn, ch); err != nil {
			slog.Warn("sse broker: re-LISTEN after reconnect failed", "channel", ch, "error", err)
			b.mu.Lock()
			b.conn = nil
			b.mu.Unlock()
			conn.release()
			return false
		}
		b.mu.Lock()
		b.channels[ch] = struct{}{}
		b.channelCount.Store(int64(len(b.channels)))
		b.mu.Unlock()
	}
	b.relistens.Inc()
	return true
}

func (b *Broker) dispatchNotification(channel, payload string) {
	b.mu.Lock()
	defer b.mu.Unlock()

	subs := b.subscribers[channel]
	// Fan out with a non-blocking send so one slow client cannot stall delivery
	// to the others sharing this channel.
	var slow []*subscriber
	for _, s := range subs {
		if s.closed {
			continue
		}
		select {
		case s.ch <- Event{Type: channel, Data: payload}:
		default:
			slow = append(slow, s)
		}
	}

	// A client whose buffer stays full is genuinely unable to keep up. Silently
	// dropping the event would be unrecoverable: the HTTP connection stays open
	// (keep-alives keep flowing) so a browser EventSource never reconnects and
	// never replays via Last-Event-ID, permanently losing events with no id-gap
	// detection. Instead, disconnect the slow subscriber — its handler's range
	// loop exits and the browser reconnects. Streams with replay
	// (notifications/workflow-run/agent-session) then resync via Last-Event-ID;
	// live-tail streams without replay (workspace/release) resume the live tail,
	// which is still strictly better than silently wedging.
	for _, s := range slow {
		b.slowDisconnects.Inc()
		emptied := b.removeSubscriberLocked(s, s.channels)
		for _, ch := range emptied {
			// We already hold b.mu and run on the dispatch goroutine that owns the
			// connection, so UNLISTEN inline rather than via the control channel.
			if err := b.unlistenIfIdleLocked(ch); err != nil {
				slog.Warn("sse broker: UNLISTEN after slow-client disconnect failed", "channel", ch, "error", err)
			}
		}
	}
}

// ErrTooManyStreams is returned when a user exceeds the per-user SSE stream cap.
type ErrTooManyStreams struct {
	UserID int64
	Max    int
}

func (e *ErrTooManyStreams) Error() string {
	return fmt.Sprintf("sse: user %d has reached the maximum of %d concurrent SSE streams", e.UserID, e.Max)
}

// MetricsCollectors registers through the API's isolated registry. Gauges read
// atomics at scrape time, never the mutex held during network operations.
// A multi-channel subscription counts only once.
func (b *Broker) MetricsCollectors() []prometheus.Collector {
	return []prometheus.Collector{
		b.slowDisconnects, b.relistens, b.rejections,
		prometheus.NewGaugeFunc(prometheus.GaugeOpts{Name: "smithers_sse_broker_subscriptions", Help: "Live broker subscriptions."}, func() float64 { return float64(b.ActiveConnections()) }),
		prometheus.NewGaugeFunc(prometheus.GaugeOpts{Name: "smithers_sse_broker_channels", Help: "Channels currently tracked by the broker LISTEN set."}, func() float64 { return float64(b.channelCount.Load()) }),
	}
}

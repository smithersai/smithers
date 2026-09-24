package ssh

import (
	"strings"
	"sync"
	"time"
)

const (
	defaultAuthAttemptsPerMinute   = 20
	defaultAuthIPAttemptsPerMinute = 600
	defaultAuthMaxFailures         = 5
	defaultAuthInitialBan          = 15 * time.Minute
	defaultAuthMaxBan              = 24 * time.Hour
	defaultAuthStateTTL            = 24 * time.Hour
	defaultAuthMaxTrackedIPs       = 10000
)

type AuthLimitResult int

const (
	AuthLimitAllowed AuthLimitResult = iota
	AuthLimitThrottled
	AuthLimitBanned
)

// AuthLimiterConfig bounds SSH authentication. Bans and the tight attempt rate
// apply per (IP, credential), so one client behind a shared NAT address (a GKE
// node, an office) never locks out another. IPAttemptsPerMinute is the looser
// per-IP pre-auth throttle; it never bans.
type AuthLimiterConfig struct {
	AttemptsPerMinute   int
	IPAttemptsPerMinute int
	MaxAuthFailures     int
	InitialBan          time.Duration
	MaxBan              time.Duration
	StateTTL            time.Duration
	MaxTrackedIPs       int
	Now                 func() time.Time
}

type AuthLimiter struct {
	mu                  sync.Mutex
	attemptsPerMinute   int
	ipAttemptsPerMinute int
	maxAuthFailures     int
	initialBan          time.Duration
	maxBan              time.Duration
	stateTTL            time.Duration
	maxTrackedIPs       int
	nowFn               func() time.Time
	states              map[string]*authIPState
	ipStates            map[string]*authIPState
}

type authIPState struct {
	windowStart         time.Time
	attemptsInWindow    int
	consecutiveFailures int
	banExponent         int
	bannedUntil         time.Time
	lastSeen            time.Time
}

func NewAuthLimiter(cfg AuthLimiterConfig) *AuthLimiter {
	attemptsPerMinute := cfg.AttemptsPerMinute
	if attemptsPerMinute <= 0 {
		attemptsPerMinute = defaultAuthAttemptsPerMinute
	}

	ipAttemptsPerMinute := cfg.IPAttemptsPerMinute
	if ipAttemptsPerMinute <= 0 {
		ipAttemptsPerMinute = defaultAuthIPAttemptsPerMinute
	}
	if ipAttemptsPerMinute < attemptsPerMinute {
		ipAttemptsPerMinute = attemptsPerMinute
	}

	maxAuthFailures := cfg.MaxAuthFailures
	if maxAuthFailures <= 0 {
		maxAuthFailures = defaultAuthMaxFailures
	}

	initialBan := cfg.InitialBan
	if initialBan <= 0 {
		initialBan = defaultAuthInitialBan
	}

	maxBan := cfg.MaxBan
	if maxBan <= 0 {
		maxBan = defaultAuthMaxBan
	}
	if maxBan < initialBan {
		maxBan = initialBan
	}

	stateTTL := cfg.StateTTL
	if stateTTL <= 0 {
		stateTTL = defaultAuthStateTTL
	}
	if stateTTL < maxBan {
		stateTTL = maxBan
	}

	maxTrackedIPs := cfg.MaxTrackedIPs
	if maxTrackedIPs <= 0 {
		maxTrackedIPs = defaultAuthMaxTrackedIPs
	}

	nowFn := cfg.Now
	if nowFn == nil {
		nowFn = time.Now
	}

	return &AuthLimiter{
		attemptsPerMinute:   attemptsPerMinute,
		ipAttemptsPerMinute: ipAttemptsPerMinute,
		maxAuthFailures:     maxAuthFailures,
		initialBan:          initialBan,
		maxBan:              maxBan,
		stateTTL:            stateTTL,
		maxTrackedIPs:       maxTrackedIPs,
		nowFn:               nowFn,
		states:              make(map[string]*authIPState),
		ipStates:            make(map[string]*authIPState),
	}
}

func NewDefaultAuthLimiter() *AuthLimiter {
	return NewAuthLimiter(AuthLimiterConfig{})
}

// Check admits one authentication attempt for credential (a key fingerprint or
// workspace login) from ip. An empty credential tracks the IP alone.
func (l *AuthLimiter) Check(ip, credential string) AuthLimitResult {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := l.nowFn()
	if !admitAttempt(l.getState(l.ipStates, now, normalizeIPKey(ip)), now, l.ipAttemptsPerMinute) {
		return AuthLimitThrottled
	}
	state := l.getState(l.states, now, authStateKey(ip, credential))
	if now.Before(state.bannedUntil) {
		return AuthLimitBanned
	}
	if !admitAttempt(state, now, l.attemptsPerMinute) {
		return AuthLimitThrottled
	}
	return AuthLimitAllowed
}

func admitAttempt(state *authIPState, now time.Time, limit int) bool {
	if state.windowStart.IsZero() || now.Sub(state.windowStart) >= time.Minute {
		state.windowStart = now
		state.attemptsInWindow = 0
	}
	if state.attemptsInWindow >= limit {
		return false
	}
	state.attemptsInWindow++
	return true
}

// RecordFailure counts a genuine credential failure. Callers must never record
// server or workspace faults here.
func (l *AuthLimiter) RecordFailure(ip, credential string) {
	l.mu.Lock()
	defer l.mu.Unlock()

	state := l.getState(l.states, l.nowFn(), authStateKey(ip, credential))
	state.consecutiveFailures++
	if state.consecutiveFailures < l.maxAuthFailures {
		return
	}

	banDuration := l.banDuration(state.banExponent)
	state.bannedUntil = l.nowFn().Add(banDuration)
	state.consecutiveFailures = 0
	if banDuration < l.maxBan {
		state.banExponent++
	}
}

func (l *AuthLimiter) RecordSuccess(ip, credential string) {
	l.mu.Lock()
	defer l.mu.Unlock()

	state := l.getState(l.states, l.nowFn(), authStateKey(ip, credential))
	state.consecutiveFailures = 0
	state.banExponent = 0
}

func (l *AuthLimiter) getState(states map[string]*authIPState, now time.Time, key string) *authIPState {
	l.evictExpiredStates(states, now)
	state, ok := states[key]
	if !ok {
		l.evictOldestStates(states, 1)
		state = &authIPState{}
		states[key] = state
	}
	state.lastSeen = now
	return state
}

func (l *AuthLimiter) evictExpiredStates(states map[string]*authIPState, now time.Time) {
	for key, state := range states {
		if !state.lastSeen.IsZero() && now.Sub(state.lastSeen) >= l.stateTTL {
			delete(states, key)
		}
	}
}

func (l *AuthLimiter) evictOldestStates(states map[string]*authIPState, incoming int) {
	for len(states)+incoming > l.maxTrackedIPs {
		var oldestKey string
		var oldestTime time.Time
		first := true
		for key, state := range states {
			if first || state.lastSeen.Before(oldestTime) {
				oldestKey = key
				oldestTime = state.lastSeen
				first = false
			}
		}
		if first {
			return
		}
		delete(states, oldestKey)
	}
}

func authStateKey(ip, credential string) string {
	key := normalizeIPKey(ip)
	if credential = strings.TrimSpace(credential); credential != "" {
		key += " " + credential
	}
	return key
}

func normalizeIPKey(ip string) string {
	ip = strings.TrimSpace(ip)
	if ip == "" {
		return "unknown"
	}
	return ip
}

func (l *AuthLimiter) banDuration(exponent int) time.Duration {
	duration := l.initialBan
	for i := 0; i < exponent; i++ {
		if duration >= l.maxBan/2 {
			return l.maxBan
		}
		duration *= 2
	}
	if duration > l.maxBan {
		return l.maxBan
	}
	return duration
}

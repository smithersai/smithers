package ssh

import (
	"strings"
	"sync"
	"time"
)

const (
	defaultAuthAttemptsPerMinute = 20
	defaultAuthMaxFailures       = 5
	defaultAuthInitialBan        = 15 * time.Minute
	defaultAuthMaxBan            = 24 * time.Hour
	defaultAuthStateTTL          = 24 * time.Hour
	defaultAuthMaxTrackedIPs     = 10000
)

type AuthLimitResult int

const (
	AuthLimitAllowed AuthLimitResult = iota
	AuthLimitThrottled
	AuthLimitBanned
)

type AuthLimiterConfig struct {
	AttemptsPerMinute int
	MaxAuthFailures   int
	InitialBan        time.Duration
	MaxBan            time.Duration
	StateTTL          time.Duration
	MaxTrackedIPs     int
	Now               func() time.Time
}

type AuthLimiter struct {
	mu                sync.Mutex
	attemptsPerMinute int
	maxAuthFailures   int
	initialBan        time.Duration
	maxBan            time.Duration
	stateTTL          time.Duration
	maxTrackedIPs     int
	nowFn             func() time.Time
	states            map[string]*authIPState
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
		attemptsPerMinute: attemptsPerMinute,
		maxAuthFailures:   maxAuthFailures,
		initialBan:        initialBan,
		maxBan:            maxBan,
		stateTTL:          stateTTL,
		maxTrackedIPs:     maxTrackedIPs,
		nowFn:             nowFn,
		states:            make(map[string]*authIPState),
	}
}

func NewDefaultAuthLimiter() *AuthLimiter {
	return NewAuthLimiter(AuthLimiterConfig{})
}

func (l *AuthLimiter) Check(ip string) AuthLimitResult {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := l.nowFn()
	state := l.getState(now, ip)
	if now.Before(state.bannedUntil) {
		return AuthLimitBanned
	}

	if state.windowStart.IsZero() || now.Sub(state.windowStart) >= time.Minute {
		state.windowStart = now
		state.attemptsInWindow = 0
	}

	if state.attemptsInWindow >= l.attemptsPerMinute {
		return AuthLimitThrottled
	}

	state.attemptsInWindow++
	return AuthLimitAllowed
}

func (l *AuthLimiter) RecordFailure(ip string) {
	l.mu.Lock()
	defer l.mu.Unlock()

	state := l.getState(l.nowFn(), ip)
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

func (l *AuthLimiter) RecordSuccess(ip string) {
	l.mu.Lock()
	defer l.mu.Unlock()

	state := l.getState(l.nowFn(), ip)
	state.consecutiveFailures = 0
	state.banExponent = 0
}

func (l *AuthLimiter) getState(now time.Time, ip string) *authIPState {
	l.evictExpiredStates(now)
	key := normalizeIPKey(ip)
	state, ok := l.states[key]
	if !ok {
		l.evictOldestStates(1)
		state = &authIPState{}
		l.states[key] = state
	}
	state.lastSeen = now
	return state
}

func (l *AuthLimiter) evictExpiredStates(now time.Time) {
	for key, state := range l.states {
		if !state.lastSeen.IsZero() && now.Sub(state.lastSeen) >= l.stateTTL {
			delete(l.states, key)
		}
	}
}

func (l *AuthLimiter) evictOldestStates(incoming int) {
	for len(l.states)+incoming > l.maxTrackedIPs {
		var oldestKey string
		var oldestTime time.Time
		first := true
		for key, state := range l.states {
			if first || state.lastSeen.Before(oldestTime) {
				oldestKey = key
				oldestTime = state.lastSeen
				first = false
			}
		}
		if first {
			return
		}
		delete(l.states, oldestKey)
	}
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

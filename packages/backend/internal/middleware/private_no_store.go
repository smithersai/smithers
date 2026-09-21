package middleware

import "net/http"

// PrivateNoStore prevents authenticated, user-specific API responses and their
// error bodies from being retained by browsers or intermediary caches.
func PrivateNoStore(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "private, no-store")
		next.ServeHTTP(w, r)
	})
}

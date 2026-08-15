package main

import (
	"fmt"
	"net/http"

	"github.com/example/nethttpfix/internal/users"
)

// Server — HTTP handler with a method-value ServeHTTP (satisfies http.Handler,
// which is std → no IMPLEMENTS edge, but the method node exists).
type Server struct {
	userStore *users.Store
}

// ServeHTTP implements the http.Handler interface.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	http.NotFound(w, r)
}

// NewServer builds the mux and registers all routes.
func NewServer() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("/", homeHandler)
	mux.HandleFunc("/users", users.ListHandler)
	mux.Handle("/users/", users.DetailHandler)
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	srv := &Server{userStore: users.NewStore()}
	mux.Handle("/api", srv)
	return mux
}

// homeHandler — named handler function.
func homeHandler(w http.ResponseWriter, r *http.Request) {
	fmt.Fprintln(w, "home")
}

// main — package-level registration on the default mux.
func main() {
	http.HandleFunc("/hello", helloHandler)
	addr := ":8080"
	http.ListenAndServe(addr, nil)
}

// helloHandler — second named handler.
func helloHandler(w http.ResponseWriter, r *http.Request) {
	fmt.Fprintln(w, "hello")
}

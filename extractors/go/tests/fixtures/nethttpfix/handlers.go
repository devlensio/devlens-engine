package main

import (
	"fmt"
	"net/http"
)

// AppHandler — a struct whose methods are used as method-value handlers.
type AppHandler struct {
	Name string
}

// GetUsers — method-value handler for GET.
func (a *AppHandler) GetUsers(w http.ResponseWriter, r *http.Request) {
	fmt.Fprintf(w, "users of %s", a.Name)
}

// PostUser — method-value handler for POST.
func (a *AppHandler) PostUser(w http.ResponseWriter, r *http.Request) {
	fmt.Fprintln(w, "created")
}

// Status — iota enum pattern (stretch: ENUM node).
type Status int

const (
	Active Status = iota
	Inactive
	Banned
)

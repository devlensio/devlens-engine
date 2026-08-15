package users

import (
	"fmt"
	"net/http"
)

// Store — a data store.
type Store struct {
	items []string
}

// Lister — interface satisfied by *Store (pointer receiver method set).
type Lister interface {
	List() []string
	Add(item string)
}

// NewStore — constructor function.
func NewStore() *Store {
	return &Store{}
}

// List implements Lister.
func (s *Store) List() []string {
	return s.items
}

// Add implements Lister.
func (s *Store) Add(item string) {
	s.items = append(s.items, item)
	fmt.Println("added", item)
}

// Base — embedded struct (EXTENDS target).
type Base struct {
	ID int
}

// User — embeds Base (struct embedding → EXTENDS edge).
type User struct {
	Base
	Name string
}

// ListHandler — net/http handler func for the collection.
func ListHandler(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
}

// DetailHandler — net/http handler func for a single item.
func DetailHandler(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
}

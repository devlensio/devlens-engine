package users

import "testing"

// TestStore_Add — tests the Add method on Store (TESTS edge → Store.Add).
func TestStore_Add(t *testing.T) {
	s := &Store{}
	s.Add("x")
	if len(s.List()) != 1 {
		t.Fatal("expected 1 item")
	}
}

// TestNewStore — tests the constructor func (TESTS edge → NewStore).
func TestNewStore(t *testing.T) {
	s := NewStore()
	if s == nil {
		t.Fatal("expected a store")
	}
}

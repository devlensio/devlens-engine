package shapes

import "testing"

// TestCircle_Area — TESTS edge → Circle.Area.
func TestCircle_Area(t *testing.T) {
	c := Circle{Radius: 2}
	if c.Area() < 12 {
		t.Fatal("area too small")
	}
}

// TestNewSquare — no such func exists → no TESTS edge (leaf test node only).
func TestMissingTarget(t *testing.T) {
	t.Skip("intentionally unresolvable target")
}

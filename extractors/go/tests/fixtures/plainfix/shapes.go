package shapes

import "math"

// Shape — interface satisfied by Circle and Square (IMPLEMENTS via
// go/types.Implements — value + pointer method sets).
type Shape interface {
	Area() float64
	Perimeter() float64
}

// Circle — a shape.
type Circle struct {
	Radius float64
}

// Area implements Shape.
func (c Circle) Area() float64 {
	return math.Pi * c.Radius * c.Radius
}

// Perimeter implements Shape.
func (c Circle) Perimeter() float64 {
	return 2 * math.Pi * c.Radius
}

// Square — a shape.
type Square struct {
	Side float64
}

// Area implements Shape.
func (s Square) Area() float64 {
	return s.Side * s.Side
}

// Perimeter implements Shape.
func (s Square) Perimeter() float64 {
	return 4 * s.Side
}

// NamedCircle — embeds Circle (EXTENDS edge) and adds a name.
type NamedCircle struct {
	Circle
	Name string
}

// Scale — pointer-receiver method (only *Square would satisfy an interface
// requiring it — go/types method-set rules).
func (s *Square) Scale(f float64) {
	s.Side *= f
}

// Color — iota enum.
type Color int

const (
	Red Color = iota
	Green
	Blue
)

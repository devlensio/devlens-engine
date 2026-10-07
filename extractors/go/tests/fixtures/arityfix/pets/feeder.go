package pets

// Feeder.Feed is variadic; Kennel.Feed has a fixed second parameter. Same
// method name, different shapes — extra arguments select the variadic one.
type Feeder struct {
	Brand string
}

func (f Feeder) Feed(name string, treats ...int) string {
	return name
}

type Kennel struct {
	Size int
}

func (k Kennel) Feed(name string, limit int) string {
	return name
}

// Sum is variadic at package level.
func Sum(nums ...int) int {
	total := 0
	for _, n := range nums {
		total += n
	}
	return total
}

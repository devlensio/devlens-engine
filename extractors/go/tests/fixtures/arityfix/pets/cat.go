package pets

// Cat speaks with no parameters. Same method NAME as Dog.Speak but a
// different receiver and arity — the arity-aware CALLS resolver must pick
// this one for zero-argument calls.
type Cat struct {
	Name string
}

func (c Cat) Speak() string {
	return "meow"
}

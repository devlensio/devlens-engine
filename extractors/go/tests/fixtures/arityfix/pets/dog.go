package pets

// Dog speaks with a count parameter.
type Dog struct {
	Name string
}

func (d Dog) Speak(times int) string {
	out := ""
	for i := 0; i < times; i++ {
		out += "woof"
	}
	return out
}

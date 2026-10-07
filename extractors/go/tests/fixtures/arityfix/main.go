package main

import "arityfix/pets"

// Play receives an anonymous interface, so go/types cannot bind Speak to a
// concrete receiver — the bare-method-name candidate tier must resolve it,
// and arity (0 args) picks Cat.Speak over Dog.Speak(times int).
func Play(pet interface{ Speak() string }) string {
	return pet.Speak()
}

// FeedAll passes extra arguments, so only the variadic Feeder.Feed accepts
// the call; Kennel.Feed(name, limit) requires exactly two.
func FeedAll(f interface {
	Feed(string, ...int) string
}, who string) string {
	return f.Feed(who, 1, 2, 3)
}

// Spread exercises f(xs...) — argCount 1 with hasSpread in callSites.
func Spread(vals []int) int {
	return pets.Sum(vals...)
}

// Plain captures ordinary callSites metadata with literal arg types.
func Plain() int {
	return pets.Sum(1, 2)
}

func main() {
	Play(nil)
	FeedAll(nil, "rex")
	Spread(nil)
	Plain()
}

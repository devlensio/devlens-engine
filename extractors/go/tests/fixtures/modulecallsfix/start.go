package main

func startAll() func() {
	println("started")
	return func() {}
}

func innerOnly() {
	println("closure")
}

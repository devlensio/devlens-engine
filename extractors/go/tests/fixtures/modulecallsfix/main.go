package main

import "github.com/gin-gonic/gin"

var globalCleanup = startAll()
var router = gin.New()
var lazy = func() { innerOnly() }

func main() {
	cleanup := startAll()
	_ = cleanup
	_ = globalCleanup
	_ = router
	_ = lazy
}

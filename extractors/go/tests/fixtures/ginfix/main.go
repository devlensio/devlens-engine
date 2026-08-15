package main

import (
	"net/http"

	"github.com/example/ginfix/internal/auth"
	"github.com/gin-gonic/gin"
)

// main — router setup: groups, verbs, closures, method-value + named handlers.
func main() {
	r := gin.Default()

	api := r.Group("/api")
	{
		api.GET("/users", ListUsers)
		api.POST("/users", CreateUser)
		api.GET("/users/:id", GetUser)
		api.PUT("/users/:id", UpdateUser)
		api.DELETE("/users/:id", DeleteUser)
	}

	v1 := api.Group("/v1")
	v1.GET("/ping", pingHandler)

	r.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})

	// var-closure handler: apiInfo := func(...) then registered by name
	apiInfo := func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"app": "ginfix"})
	}
	r.GET("/info", apiInfo)

	app := &AppHandler{name: "ginfix"}
	r.GET("/app", app.HandleApp)

	authGroup := r.Group("/auth", auth.Middleware())
	authGroup.POST("/login", Login)
	authGroup.POST("/logout", Logout)

	_ = r.Run(":8080")
}

// pingHandler — named handler on a nested group.
func pingHandler(c *gin.Context) {
	c.String(http.StatusOK, "pong")
}

// Login — auth handler.
func Login(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{})
}

// Logout — auth handler.
func Logout(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{})
}

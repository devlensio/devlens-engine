package auth

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

// Middleware — gin middleware factory (cross-package call target).
func Middleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.GetHeader("Authorization") == "" {
			c.AbortWithStatus(http.StatusUnauthorized)
			return
		}
		c.Next()
	}
}

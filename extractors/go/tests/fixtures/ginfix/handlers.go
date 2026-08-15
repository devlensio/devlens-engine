package main

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

// AppHandler — method-value handler target.
type AppHandler struct {
	name string
}

// HandleApp — GET /app handler (method value).
func (a *AppHandler) HandleApp(c *gin.Context) {
	c.String(http.StatusOK, a.name)
}

// ListUsers — reads all users.
func ListUsers(c *gin.Context) {
	var users []User
	DB.Find(&users)
	c.JSON(http.StatusOK, users)
}

// CreateUser — writes a user.
func CreateUser(c *gin.Context) {
	var user User
	if err := c.ShouldBindJSON(&user); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	DB.Create(&user)
	c.JSON(http.StatusCreated, user)
}

// GetUser — reads one user.
func GetUser(c *gin.Context) {
	var user User
	DB.First(&user, c.Param("id"))
	c.JSON(http.StatusOK, user)
}

// UpdateUser — reads then writes a user.
func UpdateUser(c *gin.Context) {
	var user User
	DB.First(&user, c.Param("id"))
	DB.Model(&user).Updates(map[string]any{"name": "updated"})
	c.JSON(http.StatusOK, user)
}

// DeleteUser — deletes a user (write).
func DeleteUser(c *gin.Context) {
	var user User
	DB.Delete(&user, c.Param("id"))
	c.Status(http.StatusNoContent)
}

package main

import (
	"time"

	"gorm.io/gorm"
)

// User — GORM model via gorm.Model embedding.
type User struct {
	gorm.Model
	Name  string `gorm:"size:255"`
	Email string `gorm:"uniqueIndex"`
}

// Order — GORM model via gorm tags (no embed).
type Order struct {
	ID        uint `gorm:"primaryKey"`
	Total     float64
	UserID    uint
	CreatedAt time.Time
}

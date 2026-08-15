package com.example.plain;

/** A record — DTO convention. */
public record Shape(double width, double height) {

    public double area() {
        return width * height;
    }
}

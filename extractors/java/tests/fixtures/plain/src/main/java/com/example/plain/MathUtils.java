package com.example.plain;

public final class MathUtils {

    public static final double PI = 3.14159;

    private MathUtils() {
    }

    /** Throws-clause metadata + static method. */
    public static double safeDivide(double a, double b) throws IllegalArgumentException {
        if (b == 0) {
            throw new IllegalArgumentException("division by zero");
        }
        return a / b;
    }
}

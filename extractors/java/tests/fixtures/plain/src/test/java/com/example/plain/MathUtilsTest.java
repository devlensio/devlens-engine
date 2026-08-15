package com.example.plain;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class MathUtilsTest {

    @Test
    void shouldDivide() {
        assertEquals(2.0, MathUtils.safeDivide(4.0, 2.0));
    }

    @Test
    void shouldRejectZero() {
        try {
            MathUtils.safeDivide(1.0, 0.0);
        } catch (IllegalArgumentException expected) {
            // ok
        }
    }
}

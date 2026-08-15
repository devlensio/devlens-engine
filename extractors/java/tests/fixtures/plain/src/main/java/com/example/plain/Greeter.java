package com.example.plain;

public interface Greeter {

    String greet(String name);

    default String greetLoud(String name) {
        return greet(name).toUpperCase();
    }
}

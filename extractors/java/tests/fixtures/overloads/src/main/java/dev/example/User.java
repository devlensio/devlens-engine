package dev.example;

public class User {

    private String name;

    public User() {
        this.name = "anon";
    }

    public User(String name) {
        this.name = name;
    }

    public String getName() {
        return name;
    }
}

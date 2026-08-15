package com.example.plain;

import static com.example.plain.MathUtils.PI;

import java.util.List;

public class FriendlyGreeter implements Greeter {

    private final String prefix;

    public FriendlyGreeter(String prefix) {
        this.prefix = prefix;
    }

    @Override
    public String greet(String name) {
        return prefix + " " + name + " (pi=" + PI + ")";
    }

    public List<String> greetMany(List<String> names) {
        return names.stream().map(this::greet).toList();
    }
}

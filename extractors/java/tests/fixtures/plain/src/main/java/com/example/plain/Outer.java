package com.example.plain;

import java.util.List;
import java.util.Map;

/** Generics + inner classes + methods calling each other. */
public class Outer<T> {

    private final List<T> items = new java.util.ArrayList<>();
    private final Map<String, T> byName = new java.util.HashMap<>();

    public static class Inner {
        public int doubleValue(int x) {
            return x * 2;
        }
    }

    public void add(T item, String name) {
        items.add(item);
        byName.put(name, item);
    }

    public T get(String name) {
        return byName.get(name);
    }

    public T first() {
        return items.isEmpty() ? null : items.get(0);
    }

    public int callInner(int x) {
        return new Inner().doubleValue(x);
    }
}

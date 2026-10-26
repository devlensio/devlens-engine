package com.example.mc;

public class StartAll {
    public static Runnable startAll() {
        System.out.println("started");
        return () -> {};
    }
}

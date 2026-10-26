package com.example.mc;

import org.slf4j.LoggerFactory;

public class Main {
    static final Runnable GLOBAL = StartAll.startAll();
    static final Object LOG = LoggerFactory.getLogger(Main.class);
    static final Runnable LAZY = () -> Deferred.onInit();

    static {
        StartAll.startAll();
    }

    public static void main(String[] args) {
        Runnable cleanup = StartAll.startAll();
        cleanup.run();
    }
}

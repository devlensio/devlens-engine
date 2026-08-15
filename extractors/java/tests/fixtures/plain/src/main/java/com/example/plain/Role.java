package com.example.plain;

public enum Role {
    ADMIN, USER, GUEST;

    public boolean canModerate() {
        return this == ADMIN;
    }
}

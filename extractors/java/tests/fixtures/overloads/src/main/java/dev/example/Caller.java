package dev.example;

public class Caller {

    private Formatter formatter = new Formatter();

    public String byNumber(int n) {
        return formatter.format(n);
    }

    public String byText(String s) {
        return formatter.format(s, 8);
    }

    public String byUser(User u, Config c) {
        return formatter.format(u, c);
    }

    public String byAll(User u, Config c) {
        return formatter.format(u, c, 2);
    }
}

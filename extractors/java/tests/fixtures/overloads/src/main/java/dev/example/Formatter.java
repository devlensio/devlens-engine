package dev.example;

public class Formatter {

    public String format(int value) {
        return "int:" + value;
    }

    public String format(String text, int width) {
        return text + ":" + width;
    }

    public String format(User user, Config config) {
        return user.getName() + "@" + config.key();
    }

    public String format(User user, Config config, int mode) {
        return user.getName() + "@" + config.key() + "#" + mode;
    }

    public String tagged(String text) {
        return format(text, 8);
    }
}

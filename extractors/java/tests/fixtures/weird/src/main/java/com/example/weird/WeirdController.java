package com.example.weird;

import static org.springframework.web.bind.annotation.RequestMethod.POST;

import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Annotation edge cases: bare static-imported verbs, array paths, explicit
 * RequestMethod, empty paths on a class prefix.
 */
@RestController
@RequestMapping("/api")
public class WeirdController {

    @RequestMapping(path = "/login", method = POST)
    public String login() {
        return "ok";
    }

    @GetMapping({"/first", "/second"})
    public String first() {
        return "first";
    }

    @RequestMapping(path = "/items/{id}", method = RequestMethod.DELETE)
    public void deleteItem(@PathVariable String id) {
    }

    @PatchMapping("/items/{id}")
    public void patchItem(@PathVariable String id) {
    }

    @RequestMapping("/legacy")
    public String legacy() {
        return "legacy";
    }
}

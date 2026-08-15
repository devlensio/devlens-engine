package com.example.demo;

import com.example.demo.model.User;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;

import java.util.List;

@SpringBootTest
class UserControllerTest {

    @Autowired
    private UserService userService;

    @Test
    void shouldCreateAndFindUsers() {
        User user = new User();
        user.setName("Ada");
        userService.createUser(user);
        List<User> users = userService.getAllUsers();
        assert !users.isEmpty();
    }

    @Test
    void shouldDeleteUser() {
        userService.deleteUser(1L);
    }
}

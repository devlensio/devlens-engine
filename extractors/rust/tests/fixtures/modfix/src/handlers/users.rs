use crate::models::post::Post;
use crate::models::user::User;
use crate::utils::helper;
use super::super::models::user::Entity;

pub fn get_user(id: u64) -> Option<User> {
    let u = User::new("bob");
    helper();
    u.describe();
    if id > 0 {
        Some(u)
    } else {
        None
    }
}

pub fn create_post(title: &str) -> Post {
    Post::create(title)
}

pub fn table_of() -> String {
    let u = User::new("t");
    Entity::table_name(&u).to_string()
}

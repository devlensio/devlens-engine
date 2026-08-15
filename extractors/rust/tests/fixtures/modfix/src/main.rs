// crate root — module declarations drive the module tree
mod handlers;
mod models;
mod utils;

use crate::models::user::User;

fn main() {
    let u = User::new("alice");
    println!("{}", u.name());
    utils::helper();
}

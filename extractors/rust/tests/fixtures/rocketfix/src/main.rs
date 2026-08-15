use rocket::{get, post, routes, launch};

#[get("/")]
fn index() -> &'static str {
    "hello"
}

#[get("/users/<id>")]
fn get_user(id: u32) -> String {
    format!("user {}", id)
}

#[post("/users")]
fn create_user() -> &'static str {
    "created"
}

#[rocket::route("/health", method = "GET")]
fn health() -> &'static str {
    "ok"
}

#[launch]
fn rocket() -> _ {
    rocket::build().mount("/", routes![index, get_user, create_user, health])
}

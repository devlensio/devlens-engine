use axum::routing::{get, post};
use axum::Router;

pub async fn index() -> &'static str {
    "home"
}

pub async fn get_user() -> &'static str {
    "user"
}

pub async fn create_user() -> &'static str {
    "created"
}

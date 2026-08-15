use axum::routing::get;
use axum::Router;

pub fn api_router() -> Router {
    Router::new()
        .route("/ping", get(|| async { "pong" }))
        .route("/items/:id", get(get_item))
}

async fn get_item() -> &'static str {
    "item"
}

pub fn admin_router() -> Router {
    Router::new().route("/admin", get(|| async { "admin" }))
}

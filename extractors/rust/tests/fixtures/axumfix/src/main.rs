mod handlers;
mod routes;

use axum::routing::{get, post};
use axum::Router;

#[tokio::main]
async fn main() {
    let app = Router::new()
        .route("/", get(handlers::index))
        .route("/users/:id", get(handlers::get_user).post(handlers::create_user))
        .route("/health", get(|| async { "ok" }))
        .nest("/api", routes::api_router())
        .merge(routes::admin_router());

    let listener = tokio::net::TcpListener::bind("127.0.0.1:3000").await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

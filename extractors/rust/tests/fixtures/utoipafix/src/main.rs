use utoipa_axum::routes;

use crate::controllers::*;

pub fn build_router() -> axum::Router {
    // utoipa-axum's documented batch registration: `.routes(routes!(a::b::c,
    // d::e::f))` — the method+path live in each handler's `#[utoipa::path]`
    // attribute. `BaseOpenApi::router()` returns (Router, OpenApi); the FIRST
    // tuple binding is the Router (the let-statement, not a let-chain).
    let (router, _openapi) = BaseOpenApi::router()
        .routes(routes!(krate::search::list_crates))
        .routes(routes!(version::readme::get_version_readme))
        .split_for_parts();

    // a plain `.route()` on the router var after split_for_parts — the
    // reassignment chain (router var bound via the tuple-let above)
    router.route("/api/ping", axum::routing::get(ping))
}

async fn ping() -> &'static str {
    "pong"
}

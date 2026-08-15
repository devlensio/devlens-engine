#[utoipa::path(get, path = "/api/v1/crates", tag = "crates")]
pub async fn list_crates() -> &'static str {
    "list"
}

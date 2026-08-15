#[utoipa::path(get, path = "/api/v1/crates/{crate_id}/readme")]
pub async fn get_version_readme() -> &'static str {
    "readme"
}

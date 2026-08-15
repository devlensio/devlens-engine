use actix_web::{get, post, web, App, HttpResponse, HttpServer, Responder};

#[get("/")]
async fn index() -> impl Responder {
    HttpResponse::Ok()
}

#[post("/users")]
async fn create_user() -> impl Responder {
    HttpResponse::Created()
}

#[actix_web::get("/users/{id}")]
async fn get_user(path: web::Path<i32>) -> impl Responder {
    HttpResponse::Ok()
}

#[actix_web::route("/health", method = "GET")]
async fn health() -> impl Responder {
    HttpResponse::Ok()
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    HttpServer::new(|| {
        App::new()
            .service(index)
            .service(create_user)
            .service(get_user)
            .service(health)
    })
    .bind(("127.0.0.1", 8080))?
    .run()
    .await
}

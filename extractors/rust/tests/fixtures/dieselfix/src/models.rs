use crate::schema::{posts, users};
use diesel::prelude::*;

#[derive(Queryable, Selectable, Identifiable)]
#[diesel(table_name = users)]
pub struct User {
    pub id: i32,
    pub name: String,
    pub email: String,
}

#[derive(Queryable, Insertable)]
#[diesel(table_name = posts)]
pub struct Post {
    pub id: i32,
    pub title: String,
    pub user_id: i32,
}

pub fn find_user(conn: &mut PgConnection, uid: i32) -> Result<User, diesel::result::Error> {
    users::table.filter(users::id.eq(uid)).first(conn)
}

pub fn all_users(conn: &mut PgConnection) -> Result<Vec<User>, diesel::result::Error> {
    users::dsl::users.load(conn)
}

pub fn create_user(conn: &mut PgConnection, name: &str, email: &str) -> Result<User, diesel::result::Error> {
    diesel::insert_into(users::table)
        .values((users::name.eq(name), users::email.eq(email)))
        .get_result(conn)
}

pub fn update_user_email(conn: &mut PgConnection, uid: i32, email: &str) -> Result<usize, diesel::result::Error> {
    diesel::update(users::table.filter(users::id.eq(uid)))
        .set(users::email.eq(email))
        .execute(conn)
}

pub fn delete_post(conn: &mut PgConnection, pid: i32) -> Result<usize, diesel::result::Error> {
    diesel::delete(posts::table.filter(posts::id.eq(pid))).execute(conn)
}

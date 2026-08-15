// diesel schema — table! macro definitions
diesel::table! {
    users (id) {
        id -> Integer,
        name -> Varchar,
        email -> Varchar,
    }
}

diesel::table! {
    posts (id) {
        id -> Integer,
        title -> Varchar,
        user_id -> Integer,
    }
}

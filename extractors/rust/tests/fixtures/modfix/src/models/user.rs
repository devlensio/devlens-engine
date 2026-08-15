// user model with inherent impl + trait impl + supertrait
pub trait Entity: Display {
    fn table_name(&self) -> &str;
}

pub trait Display {
    fn name(&self) -> &str;
}

pub struct User {
    pub id: u64,
    pub name: String,
}

impl User {
    pub fn new(name: &str) -> Self {
        User { id: 0, name: name.to_string() }
    }

    pub fn describe(&self) -> String {
        format!("User {}", self.name())
    }
}

impl Display for User {
    fn name(&self) -> &str {
        &self.name
    }
}

impl Entity for User {
    fn table_name(&self) -> &str {
        "users"
    }
}

pub enum UserRole {
    Admin,
    Member,
}

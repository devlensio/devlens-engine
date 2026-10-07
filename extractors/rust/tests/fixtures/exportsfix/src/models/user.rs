pub struct PublicUser {
    pub name: String,
}

impl PublicUser {
    pub fn new(name: String) -> Self {
        PublicUser { name }
    }
}

pub enum Role {
    Admin,
    Guest,
}

struct PrivateThing;

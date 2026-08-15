pub struct Post {
    pub id: u64,
    pub title: String,
}

impl Post {
    pub fn create(title: &str) -> Self {
        Post { id: 1, title: title.to_string() }
    }

    pub fn publish(&mut self) -> bool {
        !self.title.is_empty()
    }
}

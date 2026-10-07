pub mod models;
pub mod aliasing;

pub use aliasing::{SwappedA as SwappedB, SwappedB as SwappedA};
pub use models::user::{PublicUser as VisibleUser};

pub fn run() -> i32 {
    1
}

fn private_helper() {}

pub struct Engine {
    pub field: i32,
}

impl Engine {
    pub fn start(&self) -> i32 {
        self.field
    }
    fn hidden(&self) -> i32 {
        0
    }
}

pub trait Storage {
    fn save(&self);
}

pub enum Mode {
    Fast,
    Slow,
}

mod secret_mod {
    pub struct Hidden;
}

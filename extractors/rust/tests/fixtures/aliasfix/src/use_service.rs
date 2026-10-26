use crate::services::UserService as US;

pub fn load(id: u32) -> u32 {
    US::get(id)
}

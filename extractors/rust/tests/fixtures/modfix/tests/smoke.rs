// integration-style test file (leaf node)
use modfix_lib_dummy::*;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_helper() {
        helper();
    }
}

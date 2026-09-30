// Mixed file: production items plus both forms of inline test. The contract is
// that this file stays a FILE node with all of its production items, and that
// the top level #[test] fn becomes an addressable FUNCTION flagged
// isTestFunction rather than collapsing the file into a TEST leaf.

#[derive(Debug)]
pub struct Widget {
    pub id: u32,
}

impl Widget {
    pub fn new(id: u32) -> Self {
        Self { id }
    }

    pub fn label(&self) -> String {
        format!("widget-{}", self.id)
    }
}

pub fn helper(x: u32) -> u32 {
    x * 2
}

#[test]
fn top_level_test_fn() {
    assert_eq!(helper(2), 4);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nested_helper_test() {
        assert_eq!(helper(3), 6);
    }
}

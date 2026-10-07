mod valid_a;
mod valid_b;

pub fn check(n: u64) -> bool {
    validate(1)
}

pub fn check2(a: u64, b: u64) -> bool {
    validate(1, 2)
}

pub fn main() {
    let _ = check(1);
    let _ = check2(1, 2);
}

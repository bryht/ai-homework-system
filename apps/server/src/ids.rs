const ALPHABET: &[u8] = b"abcdefghijkmnpqrstuvwxyz23456789";

fn random_bytes<const N: usize>() -> [u8; N] {
    let mut buf = [0u8; N];
    getrandom::fill(&mut buf).expect("OS random number generator unavailable");
    buf
}

/// Prefixed random ID such as `hw_k3m9x2...`; the prefix makes logs easier to read.
pub fn new_id(prefix: &str) -> String {
    let id: String = random_bytes::<16>().iter().map(|b| ALPHABET[*b as usize % ALPHABET.len()] as char).collect();
    format!("{prefix}_{id}")
}

/// Initial student password: 10 characters without look-alike letters.
pub fn new_password() -> String {
    random_bytes::<10>().iter().map(|b| ALPHABET[*b as usize % ALPHABET.len()] as char).collect()
}

/// 32 random bytes as hex, used for session tokens.
pub fn new_token() -> String {
    hex::encode(random_bytes::<32>())
}

pub fn random_digits(n: usize) -> String {
    random_bytes::<8>().iter().take(n).map(|b| char::from(b'0' + b % 10)).collect()
}

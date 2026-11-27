use aes_gcm::{Aes256Gcm, Nonce};
use aes_gcm::aead::{Aead, KeyInit, OsRng, Payload};
use argon2::{Algorithm, Argon2, Params, Version};
use zeroize::Zeroizing;
use sha2::{Sha256, Digest};
use rand::RngCore;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypted_format_is_versioned_salted_authenticated_and_unicode_safe() {
        let first = encrypt("private 中文\n", "fixture-password").unwrap();
        let second = encrypt("private 中文\n", "fixture-password").unwrap();
        assert_eq!(&first[..9], b"MIAOYAN\0\x02");
        assert_ne!(&first[9..25], &second[9..25]);
        assert_eq!(decrypt(&first, "fixture-password").unwrap(), "private 中文\n");
        assert!(decrypt(&first, "wrong-password").is_err());
        for index in [8, 9, 25, 37, first.len() - 1] {
            let mut corrupt = first.clone();
            corrupt[index] ^= 1;
            assert!(decrypt(&corrupt, "fixture-password").is_err());
        }
        for length in [0, 8, 9, 25, 37, 52] {
            assert!(decrypt(&first[..length], "fixture-password").is_err());
        }
        assert_eq!(decrypt(&encrypt("", "fixture-password").unwrap(), "fixture-password").unwrap(), "");
    }

    #[test]
    #[ignore = "Measure optimized KDF latency with --release --ignored"]
    fn encryption_roundtrip_latency() {
        let content = "x".repeat(4096);
        let mut times = Vec::new();
        for _ in 0..5 {
            let started = std::time::Instant::now();
            let bytes = encrypt(&content, "fixture-password").unwrap();
            assert_eq!(decrypt(&bytes, "fixture-password").unwrap(), content);
            times.push(started.elapsed().as_millis());
        }
        times.sort();
        println!("argon2id_roundtrip_4k_median_ms={} kdf_memory_parameter_mib=19", times[2]);
    }

    #[test]
    fn argon2id_matches_an_independent_node_crypto_fixture() {
        let hex = "4d49414f59414e000200112233445566778899aabbccddeeff000102030405060708090a0b3b9fd8cae6007b0cae013b66e30616536e35256154fdcafb388276c5b224179d";
        let bytes: Vec<u8> = (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap()).collect();
        assert_eq!(decrypt(&bytes, "fixture-password").unwrap(), "version2 中文\n");
    }

    #[test]
    fn legacy_fixture_is_readable_and_upgrades_on_next_write() {
        let hex = "000102030405060708090a0bb8837633ffe494de66d75864689cb448b51ec40a6f74fe12e23e9f960f6d";
        let bytes: Vec<u8> = (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap()).collect();
        let text = decrypt(&bytes, "fixture-password").unwrap();
        assert_eq!(text, "legacy 中文\n");
        let upgraded = encrypt(&text, "fixture-password").unwrap();
        assert_eq!(&upgraded[..9], b"MIAOYAN\0\x02");
    }
}

const MAGIC: &[u8; 8] = b"MIAOYAN\0";
const HEADER_LEN: usize = 37;

fn derive_key(password: &str, salt: &[u8]) -> Result<Zeroizing<[u8; 32]>, String> {
    let params = Params::new(19 * 1024, 2, 1, Some(32)).map_err(|error| error.to_string())?;
    let mut key = Zeroizing::new([0u8; 32]);
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(password.as_bytes(), salt, key.as_mut())
        .map_err(|error| format!("Key derivation failed: {error}"))?;
    Ok(key)
}

pub fn encrypt(content: &str, password: &str) -> Result<Vec<u8>, String> {
    let mut header = [0u8; HEADER_LEN];
    header[..8].copy_from_slice(MAGIC);
    header[8] = 2;
    OsRng.try_fill_bytes(&mut header[9..]).map_err(|error| format!("Secure randomness unavailable: {error}"))?;
    let key = derive_key(password, &header[9..25])?;
    let cipher = Aes256Gcm::new_from_slice(key.as_ref()).map_err(|error| error.to_string())?;
    let ciphertext = cipher.encrypt(Nonce::from_slice(&header[25..]), Payload { msg: content.as_bytes(), aad: &header })
        .map_err(|_| "Encryption failed".to_string())?;
    let mut result = header.to_vec();
    result.extend(ciphertext);
    Ok(result)
}

pub fn decrypt(data: &[u8], password: &str) -> Result<String, String> {
    let (key, nonce, payload) = if data.starts_with(MAGIC) {
        if data.get(8) != Some(&2) { return Err("Unsupported encrypted document version".into()); }
        if data.len() < HEADER_LEN + 16 { return Err("Invalid encrypted data".into()); }
        (derive_key(password, &data[9..25])?, &data[25..HEADER_LEN], Payload { msg: &data[HEADER_LEN..], aad: &data[..HEADER_LEN] })
    } else {
        if data.len() < 28 { return Err("Invalid encrypted data".into()); }
        let key: [u8; 32] = Sha256::digest(password.as_bytes()).into();
        (Zeroizing::new(key), &data[..12], Payload { msg: &data[12..], aad: &[] })
    };
    let cipher = Aes256Gcm::new_from_slice(key.as_ref()).map_err(|error| error.to_string())?;
    let plaintext = cipher.decrypt(Nonce::from_slice(nonce), payload)
        .map_err(|_| "Invalid password or corrupted data".to_string())?;
    String::from_utf8(plaintext).map_err(|_| "Invalid decrypted UTF-8 data".to_string())
}

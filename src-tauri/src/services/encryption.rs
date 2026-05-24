use aes_gcm::{Aes256Gcm, Key, Nonce};
use aes_gcm::aead::{Aead, KeyInit, OsRng};
use sha2::{Sha256, Digest};
use rand::RngCore;

/// 从密码派生 256-bit 密钥
fn derive_key(password: &str) -> Key<Aes256Gcm> {
    let mut hasher = Sha256::new();
    hasher.update(password.as_bytes());
    let result = hasher.finalize();
    *Key::<Aes256Gcm>::from_slice(&result)
}

/// 加密内容，返回 [12 bytes nonce][ciphertext]
pub fn encrypt(content: &str, password: &str) -> Result<Vec<u8>, String> {
    let key = derive_key(password);
    let cipher = Aes256Gcm::new(&key);
    let mut nonce_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, content.as_bytes())
        .map_err(|e| format!("Encryption failed: {}", e))?;

    // 格式: [12 bytes nonce][ciphertext]
    let mut result = nonce_bytes.to_vec();
    result.extend(ciphertext);
    Ok(result)
}

/// 解密内容
pub fn decrypt(data: &[u8], password: &str) -> Result<String, String> {
    if data.len() < 12 {
        return Err("Invalid encrypted data".to_string());
    }
    let key = derive_key(password);
    let cipher = Aes256Gcm::new(&key);
    let nonce = Nonce::from_slice(&data[..12]);
    let ciphertext = &data[12..];

    let plaintext = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|_| "Invalid password or corrupted data".to_string())?;

    String::from_utf8(plaintext).map_err(|e| format!("UTF-8 decode failed: {}", e))
}

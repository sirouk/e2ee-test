use base64::{Engine as _, engine::general_purpose::STANDARD as B64};
use chacha20poly1305::{
    ChaCha20Poly1305, Nonce,
    aead::{Aead, KeyInit, Payload},
};
use flate2::{Compression, read::GzDecoder, write::GzEncoder};
use getrandom::fill as random_fill;
use hkdf::Hkdf;
use ml_kem::{
    DecapsulationKey768, EncapsulationKey768, MlKem768, Seed,
    kem::{Decapsulate, Encapsulate, Kem, KeyExport},
};
use serde::Serialize;
use serde_json::Value;
use sha2::Sha256;
use std::io::{Read, Write};
use wasm_bindgen::prelude::*;

type E2Result<T> = Result<T, String>;

const MLKEM_PK_SIZE: usize = 1184;
const MLKEM_SEED_SIZE: usize = 64;
const MLKEM_CT_SIZE: usize = 1088;
const TAG_SIZE: usize = 16;
const INFO_REQ: &[u8] = b"e2e-req-v1";
const INFO_RESP: &[u8] = b"e2e-resp-v1";
const INFO_STREAM: &[u8] = b"e2e-stream-v1";

#[derive(Serialize)]
struct RequestResult {
    blob: Vec<u8>,
    response_sk: Vec<u8>,
}

fn err(msg: impl Into<String>) -> String {
    msg.into()
}

fn js_err(msg: String) -> JsValue {
    JsValue::from_str(&msg)
}

fn gzip_compress(bytes: &[u8]) -> E2Result<Vec<u8>> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(bytes).map_err(|e| err(e.to_string()))?;
    encoder.finish().map_err(|e| err(e.to_string()))
}

fn gzip_decompress(bytes: &[u8]) -> E2Result<Vec<u8>> {
    let mut decoder = GzDecoder::new(bytes);
    let mut out = Vec::new();
    decoder
        .read_to_end(&mut out)
        .map_err(|e| err(e.to_string()))?;
    Ok(out)
}

fn derive_key(shared_secret: &[u8], mlkem_ct: &[u8], info: &[u8]) -> E2Result<[u8; 32]> {
    if mlkem_ct.len() < 16 {
        return Err(err("ML-KEM ciphertext is too short"));
    }
    let hk = Hkdf::<Sha256>::new(Some(&mlkem_ct[..16]), shared_secret);
    let mut key = [0u8; 32];
    hk.expand(info, &mut key).map_err(|_| err("HKDF failed"))?;
    Ok(key)
}

fn seal(key: &[u8; 32], nonce: &[u8; 12], plaintext: &[u8]) -> E2Result<Vec<u8>> {
    let nonce = Nonce::try_from(nonce.as_slice()).map_err(|_| err("invalid nonce length"))?;
    ChaCha20Poly1305::new(key.into())
        .encrypt(
            &nonce,
            Payload {
                msg: plaintext,
                aad: &[],
            },
        )
        .map_err(|_| err("ChaCha20-Poly1305 encryption failed"))
}

fn open(key: &[u8; 32], nonce: &[u8], ciphertext_and_tag: &[u8]) -> E2Result<Vec<u8>> {
    let nonce = Nonce::try_from(nonce).map_err(|_| err("invalid nonce length"))?;
    ChaCha20Poly1305::new(key.into())
        .decrypt(
            &nonce,
            Payload {
                msg: ciphertext_and_tag,
                aad: &[],
            },
        )
        .map_err(|_| err("ChaCha20-Poly1305 authentication failed"))
}

#[wasm_bindgen]
pub fn build_e2ee_request(e2e_pubkey_b64: &str, payload_json: &str) -> Result<JsValue, JsValue> {
    let result = build_request(e2e_pubkey_b64, payload_json).map_err(js_err)?;
    serde_wasm_bindgen::to_value(&result).map_err(|e| js_err(e.to_string()))
}

fn build_request(e2e_pubkey_b64: &str, payload_json: &str) -> E2Result<RequestResult> {
    let (response_sk, response_pk): (DecapsulationKey768, EncapsulationKey768) =
        MlKem768::generate_keypair();
    let response_pk = response_pk.to_bytes().to_vec();
    let response_sk = response_sk
        .to_seed()
        .ok_or_else(|| err("response secret key seed unavailable"))?
        .to_vec();

    let e2e_pubkey = B64.decode(e2e_pubkey_b64).map_err(|e| err(e.to_string()))?;
    if e2e_pubkey.len() != MLKEM_PK_SIZE {
        return Err(err("invalid Chutes E2EE public key length"));
    }
    let e2e_pubkey = e2e_pubkey
        .as_slice()
        .try_into()
        .map_err(|_| err("invalid Chutes E2EE public key"))?;
    let e2e_pubkey =
        EncapsulationKey768::new(&e2e_pubkey).map_err(|_| err("invalid Chutes E2EE public key"))?;
    let (mlkem_ct, shared_secret) = e2e_pubkey.encapsulate();
    let mlkem_ct = mlkem_ct.to_vec();
    let sym_key = derive_key(shared_secret.as_ref(), &mlkem_ct, INFO_REQ)?;

    let Value::Object(mut payload): Value =
        serde_json::from_str(payload_json).map_err(|e| err(e.to_string()))?
    else {
        return Err(err("payload must be a JSON object"));
    };
    payload.insert(
        "e2e_response_pk".to_string(),
        Value::String(B64.encode(response_pk)),
    );
    let compressed = gzip_compress(
        serde_json::to_string(&payload)
            .map_err(|e| err(e.to_string()))?
            .as_bytes(),
    )?;

    let mut nonce = [0u8; 12];
    random_fill(&mut nonce).map_err(|e| err(e.to_string()))?;
    let ciphertext_and_tag = seal(&sym_key, &nonce, &compressed)?;

    let mut blob = Vec::with_capacity(MLKEM_CT_SIZE + 12 + ciphertext_and_tag.len());
    blob.extend_from_slice(&mlkem_ct);
    blob.extend_from_slice(&nonce);
    blob.extend_from_slice(&ciphertext_and_tag);

    Ok(RequestResult { blob, response_sk })
}

#[wasm_bindgen]
pub fn decrypt_response(response_blob: &[u8], response_sk: &[u8]) -> Result<String, JsValue> {
    decrypt_response_core(response_blob, response_sk).map_err(js_err)
}

fn decrypt_response_core(response_blob: &[u8], response_sk: &[u8]) -> E2Result<String> {
    if response_blob.len() < MLKEM_CT_SIZE + 12 + TAG_SIZE {
        return Err(err("encrypted response is too short"));
    }
    if response_sk.len() != MLKEM_SEED_SIZE {
        return Err(err("invalid response secret key length"));
    }

    let mlkem_ct = &response_blob[..MLKEM_CT_SIZE];
    let nonce = &response_blob[MLKEM_CT_SIZE..MLKEM_CT_SIZE + 12];
    let ciphertext_and_tag = &response_blob[MLKEM_CT_SIZE + 12..];

    let seed: Seed = response_sk
        .try_into()
        .map_err(|_| err("invalid response secret key seed"))?;
    let sk = DecapsulationKey768::from_seed(seed);
    let ct = mlkem_ct
        .try_into()
        .map_err(|_| err("invalid response ML-KEM ciphertext"))?;
    let shared_secret = sk.decapsulate(&ct);
    let sym_key = derive_key(shared_secret.as_ref(), mlkem_ct, INFO_RESP)?;
    let plaintext = gzip_decompress(&open(&sym_key, nonce, ciphertext_and_tag)?)?;
    String::from_utf8(plaintext).map_err(|e| err(e.to_string()))
}

#[wasm_bindgen]
pub fn decrypt_stream_init(response_sk: &[u8], mlkem_ct_b64: &str) -> Result<Vec<u8>, JsValue> {
    decrypt_stream_init_core(response_sk, mlkem_ct_b64).map_err(js_err)
}

fn decrypt_stream_init_core(response_sk: &[u8], mlkem_ct_b64: &str) -> E2Result<Vec<u8>> {
    if response_sk.len() != MLKEM_SEED_SIZE {
        return Err(err("invalid response secret key length"));
    }
    let mlkem_ct = B64.decode(mlkem_ct_b64).map_err(|e| err(e.to_string()))?;
    if mlkem_ct.len() != MLKEM_CT_SIZE {
        return Err(err("invalid stream init ciphertext length"));
    }

    let seed: Seed = response_sk
        .try_into()
        .map_err(|_| err("invalid response secret key seed"))?;
    let sk = DecapsulationKey768::from_seed(seed);
    let ct = mlkem_ct
        .as_slice()
        .try_into()
        .map_err(|_| err("invalid stream init ciphertext"))?;
    let shared_secret = sk.decapsulate(&ct);
    Ok(derive_key(shared_secret.as_ref(), &mlkem_ct, INFO_STREAM)?.to_vec())
}

#[wasm_bindgen]
pub fn decrypt_stream_chunk(enc_chunk_b64: &str, stream_key: &[u8]) -> Result<String, JsValue> {
    decrypt_stream_chunk_core(enc_chunk_b64, stream_key).map_err(js_err)
}

fn decrypt_stream_chunk_core(enc_chunk_b64: &str, stream_key: &[u8]) -> E2Result<String> {
    if stream_key.len() != 32 {
        return Err(err("invalid stream key length"));
    }
    let raw = B64.decode(enc_chunk_b64).map_err(|e| err(e.to_string()))?;
    if raw.len() < 12 + TAG_SIZE {
        return Err(err("encrypted stream chunk is too short"));
    }
    let mut key = [0u8; 32];
    key.copy_from_slice(stream_key);
    let plaintext = open(&key, &raw[..12], &raw[12..])?;
    String::from_utf8(plaintext).map_err(|e| err(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn request_blob_matches_chutes_shape() {
        let (server_sk, server_pk): (DecapsulationKey768, EncapsulationKey768) =
            MlKem768::generate_keypair();
        let request = build_request(
            &B64.encode(server_pk.to_bytes()),
            r#"{"model":"tee-model","messages":[],"stream":false}"#,
        )
        .unwrap();

        assert_eq!(request.response_sk.len(), MLKEM_SEED_SIZE);
        assert!(request.blob.len() > MLKEM_CT_SIZE + 12 + TAG_SIZE);

        let payload = decrypt_request_for_test(&server_sk, &request.blob);
        assert_eq!(payload["model"], "tee-model");
        assert_eq!(payload["stream"], false);
        assert_eq!(
            B64.decode(payload["e2e_response_pk"].as_str().unwrap())
                .unwrap()
                .len(),
            MLKEM_PK_SIZE
        );
    }

    #[test]
    fn response_round_trips_through_response_key() {
        let (server_sk, server_pk): (DecapsulationKey768, EncapsulationKey768) =
            MlKem768::generate_keypair();
        let request = build_request(&B64.encode(server_pk.to_bytes()), r#"{"model":"m"}"#).unwrap();
        let response_pk = response_pk_from_request(&server_sk, &request);
        let expected = json!({"choices":[{"message":{"content":"hello from e2ee"}}]}).to_string();
        let encrypted = encrypt_response_for_test(&response_pk, expected.as_bytes());

        assert_eq!(
            decrypt_response_core(&encrypted, &request.response_sk).unwrap(),
            expected
        );
    }

    #[test]
    fn stream_key_and_chunk_round_trip() {
        let (server_sk, server_pk): (DecapsulationKey768, EncapsulationKey768) =
            MlKem768::generate_keypair();
        let request = build_request(&B64.encode(server_pk.to_bytes()), r#"{"model":"m"}"#).unwrap();
        let response_pk = response_pk_from_request(&server_sk, &request);
        let (init, chunk) = encrypt_stream_for_test(
            &response_pk,
            br#"data: {"choices":[{"delta":{"content":"hi"}}]}"#,
        );

        let stream_key = decrypt_stream_init_core(&request.response_sk, &init).unwrap();
        assert_eq!(
            decrypt_stream_chunk_core(&chunk, &stream_key).unwrap(),
            r#"data: {"choices":[{"delta":{"content":"hi"}}]}"#
        );
    }

    #[test]
    fn rejects_non_object_payloads() {
        let (_server_sk, server_pk): (DecapsulationKey768, EncapsulationKey768) =
            MlKem768::generate_keypair();
        assert!(build_request(&B64.encode(server_pk.to_bytes()), "[]").is_err());
    }

    fn decrypt_request_for_test(server_sk: &DecapsulationKey768, blob: &[u8]) -> Value {
        let mlkem_ct = &blob[..MLKEM_CT_SIZE];
        let nonce = &blob[MLKEM_CT_SIZE..MLKEM_CT_SIZE + 12];
        let ciphertext_and_tag = &blob[MLKEM_CT_SIZE + 12..];
        let ct = mlkem_ct.try_into().unwrap();
        let shared_secret = server_sk.decapsulate(&ct);
        let key = derive_key(shared_secret.as_ref(), mlkem_ct, INFO_REQ).unwrap();
        let plaintext = gzip_decompress(&open(&key, nonce, ciphertext_and_tag).unwrap()).unwrap();
        serde_json::from_slice(&plaintext).unwrap()
    }

    fn response_pk_from_request(
        server_sk: &DecapsulationKey768,
        request: &RequestResult,
    ) -> String {
        decrypt_request_for_test(server_sk, &request.blob)["e2e_response_pk"]
            .as_str()
            .unwrap()
            .to_string()
    }

    fn encrypt_response_for_test(response_pk_b64: &str, plaintext: &[u8]) -> Vec<u8> {
        let (mlkem_ct, key) = encapsulate_for_response(response_pk_b64, INFO_RESP);
        let nonce = [42u8; 12];
        let ciphertext_and_tag = seal(&key, &nonce, &gzip_compress(plaintext).unwrap()).unwrap();
        [mlkem_ct, nonce.to_vec(), ciphertext_and_tag].concat()
    }

    fn encrypt_stream_for_test(response_pk_b64: &str, plaintext: &[u8]) -> (String, String) {
        let (mlkem_ct, key) = encapsulate_for_response(response_pk_b64, INFO_STREAM);
        let nonce = [7u8; 12];
        let ciphertext_and_tag = seal(&key, &nonce, plaintext).unwrap();
        (
            B64.encode(mlkem_ct),
            B64.encode([nonce.to_vec(), ciphertext_and_tag].concat()),
        )
    }

    fn encapsulate_for_response(response_pk_b64: &str, info: &[u8]) -> (Vec<u8>, [u8; 32]) {
        let pk_bytes = B64.decode(response_pk_b64).unwrap();
        let pk = pk_bytes.as_slice().try_into().unwrap();
        let pk = EncapsulationKey768::new(&pk).unwrap();
        let (mlkem_ct, shared_secret) = pk.encapsulate();
        let mlkem_ct = mlkem_ct.to_vec();
        let key = derive_key(shared_secret.as_ref(), &mlkem_ct, info).unwrap();
        (mlkem_ct, key)
    }
}

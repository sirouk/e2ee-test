use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    ChaCha20Poly1305, Nonce,
};
use flate2::{read::GzDecoder, write::GzEncoder, Compression};
use getrandom::fill as random_fill;
use hkdf::Hkdf;
use ml_kem::{
    kem::{Decapsulate, Encapsulate, KeyExport, Kem},
    DecapsulationKey768, EncapsulationKey768, MlKem768, Seed,
};
use serde::Serialize;
use serde_json::{Map, Value};
use sha2::Sha256;
use std::io::{Read, Write};
use wasm_bindgen::prelude::*;

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

fn err(msg: impl Into<String>) -> JsValue {
    JsValue::from_str(&msg.into())
}

fn gzip_compress(bytes: &[u8]) -> Result<Vec<u8>, JsValue> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(bytes).map_err(|e| err(e.to_string()))?;
    encoder.finish().map_err(|e| err(e.to_string()))
}

fn gzip_decompress(bytes: &[u8]) -> Result<Vec<u8>, JsValue> {
    let mut decoder = GzDecoder::new(bytes);
    let mut out = Vec::new();
    decoder.read_to_end(&mut out).map_err(|e| err(e.to_string()))?;
    Ok(out)
}

fn derive_key(shared_secret: &[u8], mlkem_ct: &[u8], info: &[u8]) -> Result<[u8; 32], JsValue> {
    let hk = Hkdf::<Sha256>::new(Some(&mlkem_ct[..16]), shared_secret);
    let mut key = [0u8; 32];
    hk.expand(info, &mut key).map_err(|_| err("HKDF failed"))?;
    Ok(key)
}

fn seal(key: &[u8; 32], nonce: &[u8; 12], plaintext: &[u8]) -> Result<Vec<u8>, JsValue> {
    let nonce = Nonce::try_from(nonce.as_slice()).map_err(|_| err("invalid nonce length"))?;
    ChaCha20Poly1305::new(key.into())
        .encrypt(&nonce, Payload { msg: plaintext, aad: &[] })
        .map_err(|_| err("ChaCha20-Poly1305 encryption failed"))
}

fn open(key: &[u8; 32], nonce: &[u8], ciphertext_and_tag: &[u8]) -> Result<Vec<u8>, JsValue> {
    let nonce = Nonce::try_from(nonce).map_err(|_| err("invalid nonce length"))?;
    ChaCha20Poly1305::new(key.into())
        .decrypt(&nonce, Payload { msg: ciphertext_and_tag, aad: &[] })
        .map_err(|_| err("ChaCha20-Poly1305 authentication failed"))
}

#[wasm_bindgen]
pub fn build_e2ee_request(e2e_pubkey_b64: &str, payload_json: &str) -> Result<JsValue, JsValue> {
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
    let e2e_pubkey = EncapsulationKey768::new(&e2e_pubkey)
        .map_err(|_| err("invalid Chutes E2EE public key"))?;
    let (mlkem_ct, shared_secret) = e2e_pubkey.encapsulate();
    let mlkem_ct = mlkem_ct.to_vec();
    let sym_key = derive_key(shared_secret.as_ref(), &mlkem_ct, INFO_REQ)?;

    let mut payload: Map<String, Value> =
        serde_json::from_str(payload_json).map_err(|e| err(e.to_string()))?;
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

    serde_wasm_bindgen::to_value(&RequestResult { blob, response_sk })
        .map_err(|e| err(e.to_string()))
}

#[wasm_bindgen]
pub fn decrypt_response(response_blob: &[u8], response_sk: &[u8]) -> Result<String, JsValue> {
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

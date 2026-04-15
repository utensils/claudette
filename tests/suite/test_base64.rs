use claudette::{base64_decode, base64_encode};

/// Encoding empty bytes should return empty string.
#[test]
fn test_base64_encode_empty() {
    assert_eq!(base64_encode(&[]), "");
}

/// Decoding empty string should return empty bytes.
#[test]
fn test_base64_decode_empty() {
    assert_eq!(base64_decode("").unwrap(), Vec::<u8>::new());
}

/// Round-trip: encode then decode should return original.
#[test]
fn test_base64_roundtrip() {
    let data = b"hello world";
    let encoded = base64_encode(data);
    let decoded = base64_decode(&encoded).unwrap();
    assert_eq!(decoded, data);
}

/// Round-trip with binary data.
#[test]
fn test_base64_roundtrip_binary() {
    let data: Vec<u8> = (0..=255).collect();
    let encoded = base64_encode(&data);
    let decoded = base64_decode(&encoded).unwrap();
    assert_eq!(decoded, data);
}

/// Decoding invalid base64 should return an error.
#[test]
fn test_base64_decode_invalid() {
    let result = base64_decode("this is not valid base64!!!");
    assert!(result.is_err());
}

/// Decoding base64 with padding variations.
#[test]
fn test_base64_decode_padding() {
    // "a" encodes to "YQ==" with standard padding
    let decoded = base64_decode("YQ==").unwrap();
    assert_eq!(decoded, b"a");

    // "ab" encodes to "YWI="
    let decoded = base64_decode("YWI=").unwrap();
    assert_eq!(decoded, b"ab");
}

/// Large data round-trip.
#[test]
fn test_base64_roundtrip_large() {
    let data = vec![42u8; 1_000_000];
    let encoded = base64_encode(&data);
    let decoded = base64_decode(&encoded).unwrap();
    assert_eq!(decoded, data);
}

/// Known encoding: "Hello" -> "SGVsbG8="
#[test]
fn test_base64_known_encoding() {
    assert_eq!(base64_encode(b"Hello"), "SGVsbG8=");
}

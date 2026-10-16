//! `spec` module: machine-readable specification data embedded for tests.
//! `test-vectors.json` holds official JA4 vectors and RFC/IANA constants (author-curated, each block names
//! its source); `hpack-huffman.json` is RFC 7541 Appendix B parsed by script.
pub const test_vectors_json = @embedFile("test-vectors.json");
pub const hpack_huffman_json = @embedFile("hpack-huffman.json");

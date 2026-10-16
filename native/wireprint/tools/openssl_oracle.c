/*
 * openssl_oracle.c -- dump what OpenSSL parsed out of a raw TLS ClientHello record, as JSON.
 *
 * Purpose: produce fixtures/clienthello/<name>.expected.json from fixtures/clienthello/<name>.bin
 * WITHOUT using wireprint's own parser. The expected values in the Zig tests come from here.
 *
 * How it works:
 *   1. A server-side SSL object is attached to two memory BIOs (rbio = what the "client" sent,
 *      wbio = whatever the server would answer; discarded).
 *   2. The whole .bin (5-byte record header + ClientHello handshake message, possibly several
 *      records) is BIO_write()n into rbio, then SSL_accept() runs.
 *   3. OpenSSL's record layer and handshake state machine parse the bytes. Two callbacks observe:
 *        - SSL_set_msg_callback: SSL3_RT_HEADER (the 5-byte record header as received) and
 *          SSL3_RT_HANDSHAKE (the reassembled handshake message incl. its 4-byte header);
 *        - SSL_CTX_set_client_hello_cb: the parsed ClientHello fields via SSL_client_hello_get0_*.
 *   4. The ClientHello callback prints the JSON and returns SSL_CLIENT_HELLO_ERROR, which aborts the
 *      handshake (no certificate/key is needed; nothing is sent anywhere).
 *
 * Scope and caveats (see `man SSL_CTX_set_client_hello_cb`, OpenSSL 3.6):
 *   - get0_ciphers / get0_compression_methods / get0_session_id / get0_random return raw field bytes
 *     (cipher suites include GREASE values, wire order).
 *   - SSL_client_hello_get_extension_order lists only extensions OpenSSL recognises: "unrecognised
 *     (including GREASE) extensions will not appear". GREASE, ALPS (17613), ECH (65037), trust_anchors
 *     (51764) and padding (21) are therefore absent from `recognized_extension_order`.
 *   - SSL_client_hello_get0_ext(type) returns the extension_data of an extension (without the 2-byte
 *     type and 2-byte length). The tool probes all 65536 types and records which ones it answers
 *     (`get0_ext_present_types`), which documents whether get0_ext can see unrecognised extensions.
 *
 * Output: JSON on stdout. Hex is lowercase without prefix; u16 values are 4 hex digits.
 * Exit status: 0 if the ClientHello callback ran, 1 otherwise (OpenSSL error queue on stderr).
 *
 * Build and run: see tools/README-oracle.md.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

#include <openssl/ssl.h>
#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/crypto.h>

struct oracle_state {
    const char *name;
    const unsigned char *input;
    size_t input_len;

    /* First record header seen by the record layer (msg_callback, SSL3_RT_HEADER). */
    int have_record_header;
    unsigned char record_header[5];

    /* First handshake message seen by the state machine (msg_callback, SSL3_RT_HANDSHAKE). */
    int have_handshake;
    int handshake_type;
    size_t handshake_total_len; /* includes the 4-byte handshake header */
    unsigned char handshake_sha256[32];

    int callback_ran;
};

static void print_hex(FILE *out, const unsigned char *p, size_t n)
{
    size_t i;
    for (i = 0; i < n; i++)
        fprintf(out, "%02x", p[i]);
}

static int sha256(const unsigned char *p, size_t n, unsigned char out[32])
{
    unsigned int out_len = 0;
    if (!EVP_Digest(p, n, out, &out_len, EVP_sha256(), NULL) || out_len != 32)
        return 0;
    return 1;
}

static void msg_cb(int write_p, int version, int content_type, const void *buf, size_t len,
                   SSL *ssl, void *arg)
{
    struct oracle_state *st = arg;
    const unsigned char *b = buf;
    (void)version;
    (void)ssl;

    if (write_p)
        return; /* only what the client sent */
    if (content_type == SSL3_RT_HEADER && len == 5 && !st->have_record_header) {
        memcpy(st->record_header, b, 5);
        st->have_record_header = 1;
    } else if (content_type == SSL3_RT_HANDSHAKE && len >= 4 && !st->have_handshake) {
        st->handshake_type = b[0];
        st->handshake_total_len = len;
        if (sha256(b, len, st->handshake_sha256))
            st->have_handshake = 1;
    }
}

static int client_hello_cb(SSL *s, int *al, void *arg)
{
    struct oracle_state *st = arg;
    FILE *out = stdout;
    const unsigned char *p = NULL;
    size_t n, i;
    unsigned char in_sha[32];
    uint16_t order[1024];
    size_t order_len = sizeof(order) / sizeof(order[0]);
    unsigned int t;
    int first;

    st->callback_ran = 1;
    *al = SSL_AD_INTERNAL_ERROR;

    if (!sha256(st->input, st->input_len, in_sha))
        return SSL_CLIENT_HELLO_ERROR;

    fprintf(out, "{\n");
    fprintf(out, "  \"fixture\": \"%s\",\n", st->name);
    fprintf(out, "  \"input_length\": %zu,\n", st->input_len);
    fprintf(out, "  \"input_sha256\": \"");
    print_hex(out, in_sha, 32);
    fprintf(out, "\",\n");
    fprintf(out, "  \"oracle\": \"tools/openssl_oracle.c\",\n");
    fprintf(out, "  \"oracle_version\": \"%s\",\n", OpenSSL_version(OPENSSL_VERSION));

    if (st->have_record_header) {
        fprintf(out, "  \"record_header\": { \"content_type\": %u, \"legacy_version\": \"%02x%02x\", \"length\": %u },\n",
                st->record_header[0], st->record_header[1], st->record_header[2],
                ((unsigned)st->record_header[3] << 8) | st->record_header[4]);
    } else {
        fprintf(out, "  \"record_header\": null,\n");
    }
    if (st->have_handshake) {
        fprintf(out, "  \"handshake\": { \"msg_type\": %d, \"length\": %zu, \"sha256\": \"",
                st->handshake_type, st->handshake_total_len - 4);
        print_hex(out, st->handshake_sha256, 32);
        fprintf(out, "\" },\n");
    } else {
        fprintf(out, "  \"handshake\": null,\n");
    }

    fprintf(out, "  \"isv2\": %s,\n", SSL_client_hello_isv2(s) ? "true" : "false");
    fprintf(out, "  \"legacy_version\": \"%04x\",\n", SSL_client_hello_get0_legacy_version(s));

    n = SSL_client_hello_get0_random(s, &p);
    fprintf(out, "  \"random\": \"");
    if (n > 0)
        print_hex(out, p, n);
    fprintf(out, "\",\n");

    n = SSL_client_hello_get0_session_id(s, &p);
    fprintf(out, "  \"session_id\": \"");
    if (n > 0)
        print_hex(out, p, n);
    fprintf(out, "\",\n");

    /* Raw cipher_suites bytes: 2 bytes per suite, GREASE included. */
    n = SSL_client_hello_get0_ciphers(s, &p);
    fprintf(out, "  \"cipher_suites\": [");
    for (i = 0; n > 0 && i + 1 < n; i += 2)
        fprintf(out, "%s\"%02x%02x\"", i == 0 ? "" : ", ", p[i], p[i + 1]);
    fprintf(out, "],\n");

    n = SSL_client_hello_get0_compression_methods(s, &p);
    fprintf(out, "  \"compression_methods\": \"");
    if (n > 0)
        print_hex(out, p, n);
    fprintf(out, "\",\n");

    if (!SSL_client_hello_get_extension_order(s, order, &order_len)) {
        fprintf(stderr, "%s: SSL_client_hello_get_extension_order failed\n", st->name);
        return SSL_CLIENT_HELLO_ERROR;
    }
    fprintf(out, "  \"recognized_extension_order\": [");
    for (i = 0; i < order_len; i++)
        fprintf(out, "%s\"%04x\"", i == 0 ? "" : ", ", order[i]);
    fprintf(out, "],\n");

    /* extension_data of each recognised extension, in wire order. */
    fprintf(out, "  \"recognized_extensions\": {");
    for (i = 0; i < order_len; i++) {
        const unsigned char *d = NULL;
        size_t dlen = 0;
        fprintf(out, "%s\n    \"%04x\": \"", i == 0 ? "" : ",", order[i]);
        if (SSL_client_hello_get0_ext(s, order[i], &d, &dlen) && dlen > 0)
            print_hex(out, d, dlen);
        fprintf(out, "\"");
    }
    fprintf(out, "%s},\n", order_len > 0 ? "\n  " : "");

    /* Which types does get0_ext answer for? Probe the whole u16 space. */
    fprintf(out, "  \"get0_ext_present_types\": [");
    first = 1;
    for (t = 0; t <= 0xffff; t++) {
        const unsigned char *d = NULL;
        size_t dlen = 0;
        if (SSL_client_hello_get0_ext(s, t, &d, &dlen)) {
            fprintf(out, "%s\"%04x\"", first ? "" : ", ", t);
            first = 0;
        }
    }
    fprintf(out, "]\n");
    fprintf(out, "}\n");

    /* Stop the handshake here: we only wanted the parse. */
    return SSL_CLIENT_HELLO_ERROR;
}

static unsigned char *read_file(const char *path, size_t *len)
{
    FILE *f = fopen(path, "rb");
    unsigned char *buf = NULL;
    long sz;

    if (f == NULL)
        return NULL;
    if (fseek(f, 0, SEEK_END) != 0 || (sz = ftell(f)) < 0 || fseek(f, 0, SEEK_SET) != 0) {
        fclose(f);
        return NULL;
    }
    buf = malloc(sz > 0 ? (size_t)sz : 1);
    if (buf == NULL || fread(buf, 1, (size_t)sz, f) != (size_t)sz) {
        free(buf);
        fclose(f);
        return NULL;
    }
    fclose(f);
    *len = (size_t)sz;
    return buf;
}

/* "dir/chrome-153-macos-1.bin" -> "chrome-153-macos-1" (written into buf). */
static const char *fixture_name(const char *path, char *buf, size_t cap)
{
    const char *base = strrchr(path, '/');
    size_t n;

    base = base ? base + 1 : path;
    n = strlen(base);
    if (n >= 4 && strcmp(base + n - 4, ".bin") == 0)
        n -= 4;
    if (n >= cap)
        n = cap - 1;
    memcpy(buf, base, n);
    buf[n] = '\0';
    return buf;
}

int main(int argc, char **argv)
{
    struct oracle_state st;
    char name[256];
    SSL_CTX *ctx = NULL;
    SSL *ssl = NULL;
    BIO *rbio = NULL, *wbio = NULL;
    int ret = 1;

    if (argc != 2) {
        fprintf(stderr, "usage: %s <clienthello.bin>  (JSON on stdout)\n", argv[0]);
        return 2;
    }

    memset(&st, 0, sizeof(st));
    st.name = fixture_name(argv[1], name, sizeof(name));
    st.input = read_file(argv[1], &st.input_len);
    if (st.input == NULL) {
        perror(argv[1]);
        return 1;
    }

    ctx = SSL_CTX_new(TLS_server_method());
    if (ctx == NULL)
        goto done;
    SSL_CTX_set_client_hello_cb(ctx, client_hello_cb, &st);

    ssl = SSL_new(ctx);
    rbio = BIO_new(BIO_s_mem());
    wbio = BIO_new(BIO_s_mem());
    if (ssl == NULL || rbio == NULL || wbio == NULL)
        goto done;
    SSL_set_msg_callback(ssl, msg_cb);
    SSL_set_msg_callback_arg(ssl, &st);
    SSL_set_bio(ssl, rbio, wbio); /* ssl now owns both BIOs */
    rbio = wbio = NULL;

    if (BIO_write(SSL_get_rbio(ssl), st.input, (int)st.input_len) != (int)st.input_len)
        goto done;

    SSL_set_accept_state(ssl);
    (void)SSL_accept(ssl); /* expected to fail: the callback aborts the handshake */

    if (st.callback_ran) {
        ret = 0;
    } else {
        fprintf(stderr, "%s: ClientHello callback did not run; OpenSSL errors follow\n", st.name);
        ERR_print_errors_fp(stderr);
    }

done:
    SSL_free(ssl);
    BIO_free(rbio);
    BIO_free(wbio);
    SSL_CTX_free(ctx);
    free((void *)st.input);
    return ret;
}

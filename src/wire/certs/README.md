# src/wire/certs

`tabcap wire serve` / `wire profile` / `wire probe` 的本地 echo 用的证书。**私钥是公开的（故意提交进仓库），只给 127.0.0.1 上的 echo 用**：任何人都能用它冒充 `localhost` / `probe.test`，所以不要在 echo 以外的地方信任这个 CA。

| 文件 | 内容 |
|---|---|
| `ca.pem` | 测试 CA（EC P-256，`CA:TRUE, pathlen:0`，`keyCertSign`，有 SKI），有效期到 2046。CA 私钥没有保存：不能再签别的证书 |
| `leaf.pem` | leaf（EC P-256，`CN=localhost`），SAN：`DNS:localhost`、`IP:127.0.0.1`、`DNS:probe.test`；`CA:FALSE`、`serverAuth`，带 Authority Key Identifier（Python 3.13 的严格校验和 rustls 都要求，见 0.4-W2 调研报告） |
| `leaf-key.pem` | leaf 私钥（PKCS#8，不加密）——公开 |

客户端用 `tabcap wire ca-path` 拿到 CA 文件路径（写在 tabcap 缓存目录下）。浏览器基准采集不装 CA，只对采集用的那个标签页发 `Security.setIgnoreCertificateErrors`。

生成命令（2026-10-16，OpenSSL 3.6.4；`openssl verify -x509_strict -CAfile ca.pem leaf.pem` 通过）：

```sh
openssl ecparam -name prime256v1 -genkey -noout -out ca-key.pem
openssl req -x509 -new -key ca-key.pem -sha256 -days 7300 -config ca.cnf -out ca.pem          # ca.cnf: CA:TRUE pathlen:0, keyCertSign+cRLSign, SKI
openssl ecparam -name prime256v1 -genkey -noout | openssl pkcs8 -topk8 -nocrypt -out leaf-key.pem
openssl req -new -key leaf-key.pem -subj /CN=localhost -out leaf.csr
openssl x509 -req -in leaf.csr -CA ca.pem -CAkey ca-key.pem -days 7300 -sha256 -extfile leaf.cnf -out leaf.pem
# leaf.cnf: CA:FALSE; keyUsage digitalSignature; extendedKeyUsage serverAuth;
#           subjectAltName DNS:localhost, IP:127.0.0.1, DNS:probe.test; SKI; authorityKeyIdentifier keyid:always
```

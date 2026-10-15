# {{name}}：由 tabcap 生成的回放客户端

由 `tabcap replay export-python` 从证据包 `{{bundleId}}`（会话 `{{session}}`）生成。重新生成会覆盖本目录，不要手改 `client.py`。

## 内容

- `client.py`：每个请求组一个函数（{{functionCount}} 个）。录到的常量直接写进代码；会话值从 `Session`（storageState 文件）取；时间戳在调用时生成；每次都变的参数是函数参数。响应 JSON 的字段写成 `TypedDict`，类型由录到的正文推断，**只是示意，以实际响应为准**。
- `fixtures/`：每组第一个样本的响应正文，`index.json` 是测试用的期望值（状态码、JSON 键、各样本相同的字段）。
- `conftest.py`、`test_replay.py`：对着 `tabcap replay serve` 跑的测试，自己不起服务。

## 在回放服务器上跑

```sh
uv venv && uv pip install httpx pytest      # 或 python -m venv .venv && .venv/bin/pip install httpx pytest
tabcap replay serve <证据包> --port 4500 &   # 只监听本机回环
TABCAP_REPLAY=http://127.0.0.1:4500 .venv/bin/python -m pytest -q
```

需要会话 cookie 时，先 `tabcap replay session <证据包> -o storage-state.json`（文件 0600，含真实会话，不要提交），再加 `TABCAP_STORAGE_STATE=storage-state.json`。

## 没有生成的部分

{{todo}}

这些函数调用时抛 `NotImplementedError`。签名类参数、加密请求体由页面里的脚本计算，tabcap 不还原（docs/03 §6）；这类接口留在真实浏览器会话里取，或由你自己的研究项目处理。{{chain}}

## 注意

- 默认 `base_url` 是录制时的源；对真实站点调用前先想清楚账号风险（docs/03 §4 「离线回放优先」「会话会过期」）。
- 会话值（`session.value(...)`）默认用录到的值，可以在 `Session(values={...})` 里覆盖。

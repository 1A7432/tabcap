"""Example decode(flow): the range's XOR encoding (docs/05 s42).

A body sent with `x-enc: xor` is base64 of the plaintext XORed with a key.
The key lives in config.json next to this file (copy config.example.json);
tabcap never reads that file. Replace decode() with your own: the body of a
mitmproxy addon's response(flow) can usually move here unchanged.
"""

import base64
import json
import pathlib

KEY = json.loads(pathlib.Path(__file__).with_name("config.json").read_text("utf-8"))["key"].encode("utf-8")

# Optional: the media type of what decode() returns (the runner guesses JSON / text otherwise).
MIME = "application/json"


def xor(data):
    return bytes(b ^ KEY[i % len(KEY)] for i, b in enumerate(data))


def decode(flow):
    msg = flow.response if flow.response is not None else flow.request
    if msg.headers.get("x-enc") != "xor":
        return None
    return xor(base64.b64decode(msg.content.strip()))

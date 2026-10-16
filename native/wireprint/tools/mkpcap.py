#!/usr/bin/env python3
"""Synthesize legacy pcap fixtures around the real ClientHello bytes in fixtures/clienthello/*.bin.

Usage (from the repo root):  python3 tools/mkpcap.py

Writes fixtures/pcap/<name>.pcap and fixtures/pcap/<name>.expected.json. The JSON holds the values this
script put on the wire (header fields, 4-tuple, seq/ack, flags, window, option bytes, payload length, the
sha256 of the reassembled client payload), so Zig tests compare against the generator, never against the
Zig parser itself. Idempotent: timestamps, addresses, ports, ISNs and IP IDs are fixed constants, and the
output bytes are identical on every run (the script prints each file's sha256).

Formats (specs cited in fixtures/pcap/README.md):
  pcap      https://www.tcpdump.org/manpages/pcap-savefile.5.txt, draft-ietf-opsawg-pcap
  DLT_NULL  https://www.tcpdump.org/linktypes/LINKTYPE_NULL.html (4-byte AF in the capturing host's order)
  IPv4      RFC 791 (+ header checksum), IPv6 RFC 8200 (extension headers, Section 4)
  TCP       RFC 9293 (checksum with pseudo-header), options RFC 9293 3.1 / RFC 7323 / RFC 2018

Independent cross-check: after writing, every pcap is re-read by a separate minimal reader in this script
(`_self_check`) and its record count/lengths are compared with the JSON. For a third opinion run
`tcpdump -r fixtures/pcap/<name>.pcap -nn -vv` (checksums should print as "correct").
"""
import hashlib
import json
import pathlib
import struct

ROOT = pathlib.Path(__file__).resolve().parents[1]
CH_DIR = ROOT / "fixtures" / "clienthello"
OUT_DIR = ROOT / "fixtures" / "pcap"

# Fixed constants -> byte-identical output on every run.
TS_BASE = 1790164800  # 2026-09-23T12:00:00Z, the day the ClientHello bins were captured
SNAPLEN = 262144
LINKTYPE_NULL = 0
LINKTYPE_ETHERNET = 1
AF_INET = 2
AF_INET6_DARWIN = 30  # macOS/iOS value; FreeBSD uses 28, NetBSD/OpenBSD 24

FIN, SYN, RST, PSH, ACK = 0x01, 0x02, 0x04, 0x08, 0x10
FLAG_NAMES = ["fin", "syn", "rst", "psh", "ack", "urg", "ece", "cwr"]

# Addresses: loopback for lo0, documentation prefixes (RFC 5737 / RFC 3849) for "en0" captures.
LO_CLIENT = bytes([127, 0, 0, 1])
LO_SERVER = bytes([127, 0, 0, 1])
EN_CLIENT = bytes([192, 0, 2, 23])
EN_SERVER = bytes([192, 0, 2, 10])
EN_DNS = bytes([192, 0, 2, 53])
V6_CLIENT = bytes.fromhex("20010db8000000000000000000000017")
V6_SERVER = bytes.fromhex("20010db800000000000000000000000a")
MAC_CLIENT = bytes.fromhex("020000000017")  # locally administered
MAC_SERVER = bytes.fromhex("02000000000a")
MAC_BROADCAST = b"\xff" * 6
SERVER_PORT = 8443


# ---------------------------------------------------------------------------------------------- helpers


def inet_csum(data: bytes) -> int:
    if len(data) % 2:
        data += b"\0"
    s = sum(struct.unpack("!%dH" % (len(data) // 2), data))
    while s >> 16:
        s = (s & 0xFFFF) + (s >> 16)
    return (~s) & 0xFFFF


def ip_text(addr: bytes) -> str:
    if len(addr) == 4:
        return ".".join(str(b) for b in addr)
    return ":".join(addr[i : i + 2].hex() for i in range(0, 16, 2))


def flag_names(flags: int):
    return [n for i, n in enumerate(FLAG_NAMES) if flags & (1 << i)]


# TCP options are described as tuples so the expected kind list comes from the description, not from
# re-parsing the serialized bytes.
def encode_options(opts):
    """opts: list of ("mss", v) | ("nop",) | ("ws", shift) | ("ts", val, ecr) | ("sackok",) | ("eol",).
    Returns (bytes padded with zeros to a multiple of 4, kinds as a TCP option iterator must yield them,
    mss, wscale). The iterator stops after the first EOL, so padding after an explicit EOL is not listed;
    if padding is needed without an explicit EOL, its first zero byte IS an EOL and is listed."""
    out = b""
    kinds = []
    mss = None
    wscale = None
    ended = False
    for o in opts:
        name = o[0]
        if name == "mss":
            out += struct.pack("!BBH", 2, 4, o[1])
            kinds.append(2)
            mss = o[1]
        elif name == "nop":
            out += b"\x01"
            kinds.append(1)
        elif name == "ws":
            out += struct.pack("!BBB", 3, 3, o[1])
            kinds.append(3)
            wscale = o[1]
        elif name == "ts":
            out += struct.pack("!BBII", 8, 10, o[1], o[2])
            kinds.append(8)
        elif name == "sackok":
            out += b"\x04\x02"
            kinds.append(4)
        elif name == "eol":
            out += b"\x00"
            kinds.append(0)
            ended = True
            break
        else:
            raise ValueError(name)
    pad = (-len(out)) % 4
    if pad and not ended:
        kinds.append(0)
    out += b"\0" * pad
    assert len(out) <= 40
    return out, kinds, mss, wscale


def ipv6_ext_header(kind: int, next_header: int, total_len: int) -> bytes:
    """Hop-by-Hop (0) or Destination Options (60) header of `total_len` bytes filled with one PadN option."""
    assert kind in (0, 60) and total_len % 8 == 0 and total_len >= 8
    padn_len = total_len - 2 - 2
    return bytes([next_header, total_len // 8 - 1, 1, padn_len]) + b"\0" * padn_len


class Frame:
    """One link-layer frame plus the facts the tests expect a parser to recover from it."""

    def __init__(self, data: bytes, packet=None, parse_error=None, note=""):
        self.data = data
        self.packet = packet  # dict or None
        self.parse_error = parse_error  # "Unsupported" for non-TCP frames
        self.note = note


def link_wrap(link, ip_version, ip_packet, null_endian="<"):
    """Returns (frame bytes, link header length)."""
    if link == "null":
        af = AF_INET if ip_version == 4 else AF_INET6_DARWIN
        return struct.pack(null_endian + "I", af) + ip_packet, 4
    ethertype = 0x0800 if ip_version == 4 else 0x86DD
    frame = MAC_SERVER + MAC_CLIENT + struct.pack("!H", ethertype) + ip_packet
    return frame, 14


def eth_pad(frame: bytes) -> bytes:
    # Ethernet minimum frame is 60 bytes without FCS; capture shows the padding after the IP packet.
    return frame + b"\0" * max(0, 60 - len(frame))


def tcp_frame(link, src, dst, sport, dport, seq, ack, flags, window, opts, payload, ttl, ip_id,
              ext_headers=(), null_endian="<", swap_macs=False, note=""):
    ip_version = 4 if len(src) == 4 else 6
    options, kinds, mss, wscale = encode_options(opts)
    data_offset = (20 + len(options)) // 4
    tcp = struct.pack("!HHIIBBHHH", sport, dport, seq, ack, data_offset << 4, flags, window, 0, 0)
    tcp += options
    seg_len = len(tcp) + len(payload)
    if ip_version == 4:
        pseudo = src + dst + struct.pack("!BBH", 0, 6, seg_len)
    else:
        pseudo = src + dst + struct.pack("!I3xB", seg_len, 6)
    csum = inet_csum(pseudo + tcp + payload)
    tcp = tcp[:16] + struct.pack("!H", csum) + tcp[18:]
    segment = tcp + payload

    ext_chain = []
    if ip_version == 4:
        total = 20 + len(segment)
        hdr = struct.pack("!BBHHHBBH4s4s", 0x45, 0, total, ip_id, 0x4000, ttl, 6, 0, src, dst)
        hdr = hdr[:10] + struct.pack("!H", inet_csum(hdr)) + hdr[12:]
        ip_packet = hdr + segment
    else:
        # ext_headers: list of (kind, total_len); chain them, last one points at TCP (6).
        ext_bytes = b""
        kinds_chain = [k for k, _ in ext_headers]
        for i, (k, ln) in enumerate(ext_headers):
            nxt = kinds_chain[i + 1] if i + 1 < len(kinds_chain) else 6
            ext_bytes += ipv6_ext_header(k, nxt, ln)
        ext_chain = kinds_chain
        first_next = kinds_chain[0] if kinds_chain else 6
        body = ext_bytes + segment
        vtcfl = (6 << 28) | 0x0A1B2  # fixed flow label
        hdr = struct.pack("!IHBB16s16s", vtcfl, len(body), first_next, ttl, src, dst)
        ip_packet = hdr + body

    frame, link_len = link_wrap(link, ip_version, ip_packet, null_endian)
    if link == "ethernet":
        if swap_macs:
            frame = MAC_CLIENT + MAC_SERVER + frame[12:]
        frame = eth_pad(frame)
    packet = {
        "ip_version": ip_version,
        "ip_ext_headers": ext_chain,
        "link_header_len": link_len,
        "ip_len": len(ip_packet),
        "src": ip_text(src),
        "dst": ip_text(dst),
        "src_hex": src.hex(),
        "dst_hex": dst.hex(),
        "ttl": ttl,
        "src_port": sport,
        "dst_port": dport,
        "seq": seq,
        "ack": ack,
        "data_offset": data_offset,
        "flags": flags,
        "flag_names": flag_names(flags),
        "window": window,
        "options_hex": options.hex(),
        "option_kinds": kinds,
        "mss": mss,
        "wscale": wscale,
        "payload_len": len(payload),
    }
    return Frame(frame, packet=packet, note=note)


def arp_request_frame():
    arp = struct.pack("!HHBBH6s4s6s4s", 1, 0x0800, 6, 4, 1, MAC_CLIENT, EN_CLIENT, b"\0" * 6, EN_SERVER)
    return Frame(eth_pad(MAC_BROADCAST + MAC_CLIENT + b"\x08\x06" + arp), parse_error="Unsupported",
                 note="ARP request (ethertype 0806): not IP")


def udp_dns_frame():
    # A DNS query for "wireprint.invalid" A (RFC 1035 wire format), UDP checksum computed.
    qname = b"\x09wireprint\x07invalid\x00"
    dns = struct.pack("!HHHHHH", 0x1234, 0x0100, 1, 0, 0, 0) + qname + struct.pack("!HH", 1, 1)
    sport, dport = 53000, 53
    udp_len = 8 + len(dns)
    udp = struct.pack("!HHHH", sport, dport, udp_len, 0) + dns
    pseudo = EN_CLIENT + EN_DNS + struct.pack("!BBH", 0, 17, udp_len)
    udp = udp[:6] + struct.pack("!H", inet_csum(pseudo + udp) or 0xFFFF) + udp[8:]
    total = 20 + len(udp)
    hdr = struct.pack("!BBHHHBBH4s4s", 0x45, 0, total, 0x2001, 0, 64, 17, 0, EN_CLIENT, EN_DNS)
    hdr = hdr[:10] + struct.pack("!H", inet_csum(hdr)) + hdr[12:]
    frame = MAC_SERVER + MAC_CLIENT + b"\x08\x00" + hdr + udp
    return Frame(eth_pad(frame), parse_error="Unsupported", note="IPv4 UDP (protocol 17): not TCP")


# macOS-style SYN option layout: MSS, NOP, WS, NOP, NOP, TS, SACK_PERM, EOL (+1 zero pad) = 24 bytes.
def client_syn_opts(mss, ts_val):
    return [("mss", mss), ("nop",), ("ws", 6), ("nop",), ("nop",), ("ts", ts_val, 0), ("sackok",), ("eol",)]


# Server SYN-ACK: MSS, NOP, WS, SACK_PERM, TS = 20 bytes, no padding (a different shape on purpose).
def server_synack_opts(mss, ts_val, ts_ecr):
    return [("mss", mss), ("nop",), ("ws", 7), ("sackok",), ("ts", ts_val, ts_ecr)]


def ts_opts(val, ecr):
    return [("nop",), ("nop",), ("ts", val, ecr)]


def u32(v):
    return v & 0xFFFFFFFF


# ---------------------------------------------------------------------------------------------- scenarios


def handshake_1seg(link, csrc, cdst, cport, client_isn, server_isn, hello, mss, ttl, null_endian="<",
                   ext_on_data=()):
    """SYN, SYN-ACK, then one PSH|ACK segment carrying the whole ClientHello record."""
    c_ts, s_ts = 0x1A2B3C4D, 0x5E6F7081
    frames = [
        tcp_frame(link, csrc, cdst, cport, SERVER_PORT, client_isn, 0, SYN, 65535,
                  client_syn_opts(mss, c_ts), b"", ttl, 0x1001, null_endian=null_endian,
                  note="client SYN"),
        tcp_frame(link, cdst, csrc, SERVER_PORT, cport, server_isn, u32(client_isn + 1), SYN | ACK, 65535,
                  server_synack_opts(mss, s_ts, c_ts), b"", ttl, 0x0000, null_endian=null_endian,
                  swap_macs=True, note="server SYN-ACK"),
        tcp_frame(link, csrc, cdst, cport, SERVER_PORT, u32(client_isn + 1), u32(server_isn + 1), PSH | ACK,
                  6379, ts_opts(c_ts + 1, s_ts), hello, ttl, 0x1002, ext_headers=ext_on_data,
                  null_endian=null_endian, note="client ClientHello (whole TLS record)"),
    ]
    return frames


def handshake_2seg_en0(hello):
    """ARP + UDP noise, 3-way handshake, ClientHello split 1400 + rest, server ACK in between.
    The client ISN is chosen so the second segment's sequence number wraps past 2^32."""
    csrc, cdst, cport = EN_CLIENT, EN_SERVER, 54322
    client_isn, server_isn = 0xFFFFFD00, 0x7B1C2D3E
    c_ts, s_ts = 0x0BADCAFE, 0x00C0FFEE
    mss, ttl = 1460, 64
    first, second = hello[:1400], hello[1400:]
    seq1 = u32(client_isn + 1)
    seq2 = u32(seq1 + len(first))
    assert seq2 < seq1, "fixture must exercise sequence-number wraparound"
    frames = [
        arp_request_frame(),
        udp_dns_frame(),
        tcp_frame("ethernet", csrc, cdst, cport, SERVER_PORT, client_isn, 0, SYN, 65535,
                  client_syn_opts(mss, c_ts), b"", ttl, 0x3001, note="client SYN"),
        tcp_frame("ethernet", cdst, csrc, SERVER_PORT, cport, server_isn, seq1, SYN | ACK, 65160,
                  server_synack_opts(mss, s_ts, c_ts), b"", 57, 0x0000, swap_macs=True,
                  note="server SYN-ACK"),
        tcp_frame("ethernet", csrc, cdst, cport, SERVER_PORT, seq1, u32(server_isn + 1), ACK, 2058,
                  ts_opts(c_ts + 1, s_ts), b"", ttl, 0x3002, note="client ACK (pure, no payload)"),
        tcp_frame("ethernet", csrc, cdst, cport, SERVER_PORT, seq1, u32(server_isn + 1), ACK, 2058,
                  ts_opts(c_ts + 2, s_ts), first, ttl, 0x3003, note="client ClientHello part 1 (1400 bytes)"),
        tcp_frame("ethernet", cdst, csrc, SERVER_PORT, cport, u32(server_isn + 1), seq2, ACK, 502,
                  [], b"", 57, 0x0001, swap_macs=True,
                  note="server ACK without options: 54-byte frame padded to 60 (IP total length must trim it)"),
        tcp_frame("ethernet", csrc, cdst, cport, SERVER_PORT, seq2, u32(server_isn + 1), PSH | ACK, 2058,
                  ts_opts(c_ts + 3, s_ts), second, ttl, 0x3004, note="client ClientHello part 2 (rest)"),
    ]
    return frames


# ---------------------------------------------------------------------------------------------- writer


def pcap_file(endian, nanosecond, linktype, frames, ts_frac_fn):
    e = "<" if endian == "little" else ">"
    magic = 0xA1B23C4D if nanosecond else 0xA1B2C3D4
    out = bytearray(struct.pack(e + "IHHiIII", magic, 2, 4, 0, 0, SNAPLEN, linktype))
    records = []
    for i, fr in enumerate(frames):
        ts_sec, ts_frac = TS_BASE + i // 4, ts_frac_fn(i)
        rec = {
            "index": i,
            "offset": len(out),
            "ts_sec": ts_sec,
            "ts_frac": ts_frac,
            "incl_len": len(fr.data),
            "orig_len": len(fr.data),
            "note": fr.note,
            "parse_error": fr.parse_error,
            "packet": fr.packet,
        }
        out += struct.pack(e + "IIII", ts_sec, ts_frac, len(fr.data), len(fr.data)) + fr.data
        records.append(rec)
    return bytes(out), records


def usec(i):
    return 100000 + i * 12345


def nsec(i):
    return 100000000 + i * 12345678 + 9  # sub-microsecond digits prove nanosecond precision


def client_info(frames, hello, source_bin):
    syn = next(f.packet for f in frames if f.packet and f.packet["flags"] == SYN)
    data = [f.packet for f in frames
            if f.packet and f.packet["src_hex"] == syn["src_hex"] and f.packet["src_port"] == syn["src_port"]
            and f.packet["payload_len"] > 0]
    total = sum(p["payload_len"] for p in data)
    info = {
        "ip_version": syn["ip_version"],
        "src_hex": syn["src_hex"],
        "dst_hex": syn["dst_hex"],
        "src_port": syn["src_port"],
        "dst_port": syn["dst_port"],
        "isn": syn["seq"],
        "syn": {
            "window": syn["window"],
            "ttl": syn["ttl"],
            "options_hex": syn["options_hex"],
            "option_kinds": syn["option_kinds"],
            "mss": syn["mss"],
            "wscale": syn["wscale"],
        },
        "payload_len": total,
        "payload_sha256": None,
        "source_bin": source_bin,
        "source_sha256": None,
    }
    if hello is not None:
        assert total == len(hello)
        digest = hashlib.sha256(hello).hexdigest()
        info["payload_sha256"] = digest
        info["source_sha256"] = digest
    return info


def expected_doc(name, purpose, blob, endian, nanosecond, linktype, records, client, trailing_error=None,
                 complete_records=None):
    recs = records if complete_records is None else records[:complete_records]
    return {
        "name": name,
        "purpose": purpose,
        "generator": "tools/mkpcap.py",
        "file_len": len(blob),
        "file_sha256": hashlib.sha256(blob).hexdigest(),
        "magic_bytes": blob[:4].hex(),
        "endian": endian,
        "nanosecond": nanosecond,
        "version_major": 2,
        "version_minor": 4,
        "snaplen": SNAPLEN,
        "linktype": linktype,
        "record_count": len(recs),
        "trailing_error": trailing_error,
        "records": recs,
        "client": client,
    }


def _self_check(blob, doc):
    """Minimal independent reader: walks the records with struct and compares with the JSON."""
    magic_le = struct.unpack("<I", blob[:4])[0]
    e = {0xA1B2C3D4: "<", 0xA1B23C4D: "<", 0xD4C3B2A1: ">", 0x4D3CB2A1: ">"}[magic_le]
    assert ("little" if e == "<" else "big") == doc["endian"]
    assert struct.unpack(e + "I", blob[20:24])[0] == doc["linktype"]
    pos, n = 24, 0
    while pos + 16 <= len(blob):
        _, _, incl, orig = struct.unpack(e + "IIII", blob[pos : pos + 16])
        if pos + 16 + incl > len(blob):
            break
        r = doc["records"][n]
        assert (r["offset"], r["incl_len"], r["orig_len"]) == (pos, incl, orig), (doc["name"], n)
        pos += 16 + incl
        n += 1
    assert n == doc["record_count"], (doc["name"], n)
    assert (pos == len(blob)) == (doc["trailing_error"] is None), doc["name"]


def write(name, blob, doc):
    _self_check(blob, doc)
    (OUT_DIR / (name + ".pcap")).write_bytes(blob)
    text = json.dumps(doc, indent=2, ensure_ascii=False) + "\n"
    (OUT_DIR / (name + ".expected.json")).write_text(text, encoding="utf-8")
    print("%-40s %6d bytes  %2d records  sha256 %s" % (name + ".pcap", len(blob), doc["record_count"],
                                                       hashlib.sha256(blob).hexdigest()))


def read_bin(stem):
    path = CH_DIR / (stem + ".bin")
    data = path.read_bytes()
    assert data[0] == 0x16 and data[1] == 0x03, path
    assert int.from_bytes(data[3:5], "big") + 5 == len(data), "expected exactly one TLS record: %s" % path
    return data, "fixtures/clienthello/%s.bin" % stem


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    # 1. macOS lo0: DLT_NULL, little-endian microsecond pcap, IPv4, ClientHello in one segment.
    hello, src = read_bin("chrome-153-macos-1")
    frames = handshake_1seg("null", LO_CLIENT, LO_SERVER, 54321, 0x2A3B4C5D, 0x6E7F8091, hello, 16344, 64)
    blob, recs = pcap_file("little", False, LINKTYPE_NULL, frames, usec)
    name = "chrome-153-macos-lo0-1seg"
    write(name, blob, expected_doc(
        name, "DLT_NULL (AF_INET=2, little-endian) + IPv4 + TCP; ClientHello record in a single segment",
        blob, "little", False, LINKTYPE_NULL, recs, client_info(frames, hello, src)))
    lo0_blob, lo0_recs = blob, recs

    # 2. en0: Ethernet, little-endian microsecond pcap, IPv4, ClientHello split across two segments.
    hello, src = read_bin("chrome-153-macos-2")
    frames = handshake_2seg_en0(hello)
    blob, recs = pcap_file("little", False, LINKTYPE_ETHERNET, frames, usec)
    name = "chrome-153-macos-en0-2seg"
    write(name, blob, expected_doc(
        name, "Ethernet + IPv4 + TCP; ARP and UDP noise; ClientHello split 1400 + rest with seq wraparound; "
        "padded 60-byte server ACK", blob, "little", False, LINKTYPE_ETHERNET, recs,
        client_info(frames, hello, src)))

    # 3. Ethernet + IPv6 with Hop-by-Hop (8 bytes) -> Destination Options (16 bytes) -> TCP on the data packet.
    hello, src = read_bin("firefox-157b4-macos-1")
    frames = handshake_1seg("ethernet", V6_CLIENT, V6_SERVER, 54323, 0x11223344, 0x55667788, hello, 1440, 64,
                            ext_on_data=[(0, 8), (60, 16)])
    blob, recs = pcap_file("little", False, LINKTYPE_ETHERNET, frames, usec)
    name = "firefox-157b4-macos-v6-1seg"
    write(name, blob, expected_doc(
        name, "Ethernet + IPv6 + TCP; data packet carries Hop-by-Hop -> Destination Options -> TCP",
        blob, "little", False, LINKTYPE_ETHERNET, recs, client_info(frames, hello, src)))

    # 4. Nanosecond magic, written big-endian (on-disk a1b23c4d) so the DLT_NULL AF is big-endian too.
    hello, src = read_bin("safari-26.6.2-macos-1")
    frames = handshake_1seg("null", LO_CLIENT, LO_SERVER, 54324, 0x0F1E2D3C, 0x4B5A6978, hello, 16344, 64,
                            null_endian=">")
    blob, recs = pcap_file("big", True, LINKTYPE_NULL, frames, nsec)
    name = "safari-26.6.2-macos-nano"
    write(name, blob, expected_doc(
        name, "big-endian nanosecond pcap (on-disk magic a1b23c4d); DLT_NULL AF_INET in big-endian; "
        "ClientHello in one segment", blob, "big", True, LINKTYPE_NULL, recs, client_info(frames, hello, src)))

    # 5a. A lone SYN: no payload anywhere.
    frames = [tcp_frame("null", LO_CLIENT, LO_SERVER, 54325, SERVER_PORT, 0x01020304, 0, SYN, 65535,
                        client_syn_opts(16344, 0x0A0B0C0D), b"", 64, 0x4001, note="client SYN")]
    blob, recs = pcap_file("little", False, LINKTYPE_NULL, frames, usec)
    name = "syn-only"
    write(name, blob, expected_doc(
        name, "one SYN, no payload: reassembly records SynInfo but finds no client payload",
        blob, "little", False, LINKTYPE_NULL, recs, client_info(frames, None, None)))

    # 5b. The lo0 file with its last record cut in half: 2 complete records, then a partial one.
    last = lo0_recs[-1]
    cut = last["offset"] + 16 + last["incl_len"] // 2
    blob = lo0_blob[:cut]
    name = "truncated"
    write(name, blob, expected_doc(
        name, "chrome-153-macos-lo0-1seg cut inside the last record's data: reader must report Truncated",
        blob, "little", False, LINKTYPE_NULL, lo0_recs, None, trailing_error="Truncated",
        complete_records=len(lo0_recs) - 1))


if __name__ == "__main__":
    main()

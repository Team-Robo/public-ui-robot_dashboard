import random
import struct
import xml.etree.ElementTree as ET

import zmq

from .static_tree import _parse_node

# Reverse-engineered against a real bt_main process (no public BT.CPP doc
# for this, no existing Python client anywhere) - see groot2_protocol.h for
# the parts that ARE documented (request/reply header shape). Two things
# that header comment doesn't spell out, found empirically:
#   1. Replies are ZMQ MULTIPART messages - the 22-byte header is only the
#      first frame; the actual payload (tree XML / status array) is a
#      second frame. A plain recv() silently returns just the header with
#      an empty-looking body, and reusing one REQ socket across requests
#      then breaks with a ZMQError - use recv_multipart() and a fresh
#      socket per request.
#   2. STATUS body is `(uid: uint16, status_byte: uint8)` triples. The
#      status byte is NOT the raw BT::NodeStatus enum - it's
#      `prev_status*5 + current_status` (both being the raw 0-4 enum).
#      Verified against two real transitions: steady-state SUCCESS->SUCCESS
#      = 2*5+2 = 12, and a forced SUCCESS->FAILURE (killed the fake pose
#      publisher's person count to fail PersonDetected) = 2*5+3 = 13.
#      A node never re-ticked in a given round (e.g. skipped by a failed
#      Sequence) keeps showing its last real status, not a fresh "skipped"
#      marker.
#
# THE STALE-STATUS TRAP - read this before building anything on top of
# fetch_status(): a node's (prev, current) byte is IDENTICAL whether it was
# actually re-ticked with the same result, or wasn't ticked at all this
# round and is just showing its frozen last-known status. Confirmed by
# direct example: in main_tree.xml, when PersonDetected fails,
# LogPeopleCount (its Sequence sibling) is never ticked - yet its status
# stays exactly "SUCCESS->SUCCESS" from whenever it last actually ran,
# indistinguishable from a node that is genuinely still succeeding every
# tick. There is no per-node timestamp or "ticked this round" flag in the
# STATUS payload to disambiguate this.
#
# Investigated fixing this at the protocol level: BT.CPP's Groot2 protocol
# has TOGGLE_RECORDING / GET_TRANSITIONS request types that sound like they
# would give a true tick-by-tick change log instead of point-in-time
# snapshots (a transition only gets logged when it actually happens, which
# would solve this cleanly). Spiked it directly against a live bt_main:
# GET_TRANSITIONS came back empty even with a CONFIRMED real transition
# happening during the recording window (the same PersonDetected
# fail/recover scenario used to verify the STATUS encoding above), across
# two different guessed payload encodings for TOGGLE_RECORDING (a raw
# 1-byte flag, and a JSON `{"enabled": true}` matching this same protocol's
# own serialization style for the Hook struct). Neither worked. The actual
# body format for these two request types only exists in BT.CPP's compiled
# .cpp (serverLoop()/updateStatusBuffer() are private, not in any header
# available in this workspace) - abandoned rather than keep guessing
# blindly against undocumented internals with no way to verify progress.
#
# Chosen fix instead, at the APPLICATION level, not the protocol level:
# track consecutive-poll staleness client-side. A node whose status byte
# just changed gets treated as "fresh"; one that's been unchanged for many
# polls gets visually dimmed/faded in the live view rather than shown at
# full color as if it just happened. This only needs the STATUS endpoint,
# which is fully verified - not the unverified transition log. See the
# frontend BT live-status rendering (once built) for the actual staleness
# counter; this file only decodes what fetch_status() can honestly know.

PROTOCOL_ID = 2
REQ_FULLTREE = ord("T")
REQ_STATUS = ord("S")
RECV_TIMEOUT_MS = 1500

_STATUS_NAMES = ["IDLE", "RUNNING", "SUCCESS", "FAILURE", "SKIPPED"]


class Groot2ClientError(Exception):
    pass


def _request(port: int, req_type: int) -> bytes:
    ctx = zmq.Context.instance()
    sock = ctx.socket(zmq.REQ)
    sock.setsockopt(zmq.RCVTIMEO, RECV_TIMEOUT_MS)
    sock.setsockopt(zmq.SNDTIMEO, RECV_TIMEOUT_MS)
    sock.setsockopt(zmq.LINGER, 0)
    try:
        sock.connect(f"tcp://localhost:{port}")
        unique_id = random.getrandbits(32)
        sock.send(struct.pack("<BBI", PROTOCOL_ID, req_type, unique_id))
        parts = sock.recv_multipart()
    except zmq.error.Again as exc:
        raise Groot2ClientError(f"no reply from Groot2Publisher on port {port} - is the tree actually running?") from exc
    except zmq.error.ZMQError as exc:
        raise Groot2ClientError(f"ZMQ error talking to port {port}: {exc}") from exc
    finally:
        sock.close()

    if not parts:
        raise Groot2ClientError("empty reply from Groot2Publisher")
    r_protocol, _r_type, _r_unique_id, _tree_id = struct.unpack_from("<BBI16s", parts[0], 0)
    if r_protocol != PROTOCOL_ID:
        raise Groot2ClientError(f"unexpected protocol id {r_protocol} (expected {PROTOCOL_ID})")
    return parts[1] if len(parts) > 1 else b""


def fetch_live_tree(port: int) -> dict:
    """FULLTREE request - the running tree's own XML, with every node
    carrying BT.CPP's own `_uid`. Reuses static_tree.py's node parser as-is
    (it already handles arbitrary attributes, SubTree resolution, and now
    `_uid` extraction) rather than a separate live-only parser."""
    body = _request(port, REQ_FULLTREE)
    try:
        root_elem = ET.fromstring(body)
    except ET.ParseError as exc:
        raise Groot2ClientError(f"malformed FULLTREE XML: {exc}") from exc

    behavior_trees = {bt.get("ID"): bt for bt in root_elem.findall("BehaviorTree") if bt.get("ID")}
    if not behavior_trees:
        raise Groot2ClientError("no <BehaviorTree> in live FULLTREE reply")
    main_id = root_elem.get("main_tree_to_execute") or next(iter(behavior_trees))
    main_elem = behavior_trees.get(main_id)
    if main_elem is None:
        raise Groot2ClientError(f"main_tree_to_execute='{main_id}' not in live FULLTREE reply")

    root_children = list(main_elem)
    if not root_children:
        raise Groot2ClientError(f"<BehaviorTree ID='{main_id}'> has no root node in live reply")

    node = _parse_node(root_children[0], behavior_trees, visited=frozenset({main_id}), path="")
    return {"tree_id": main_id, "root": node}


def fetch_status(port: int) -> dict[int, dict]:
    """STATUS request -> {uid: {"prev": "SUCCESS", "current": "FAILURE"}}."""
    body = _request(port, REQ_STATUS)
    if len(body) % 3 != 0:
        raise Groot2ClientError(f"STATUS body length {len(body)} is not a multiple of 3 - unexpected format")

    result: dict[int, dict] = {}
    for i in range(len(body) // 3):
        uid, status_byte = struct.unpack_from("<HB", body, i * 3)
        prev, current = divmod(status_byte, 5)
        result[uid] = {
            "prev": _STATUS_NAMES[prev] if 0 <= prev < 5 else f"UNKNOWN({prev})",
            "current": _STATUS_NAMES[current] if 0 <= current < 5 else f"UNKNOWN({current})",
        }
    return result

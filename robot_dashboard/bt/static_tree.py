import xml.etree.ElementTree as ET
from typing import Optional


class TreeParseError(Exception):
    pass


def parse_tree_file(xml_path: str) -> dict:
    """Parses a BT.CPP XML file (BTCPP_format 4) into a JSON-able tree:
    {tree_id, root: {type, instance_name, ports, children: [...]}}.

    SubTree references are inlined recursively (looked up by ID against the
    other <BehaviorTree> blocks in the same file) rather than left as bare
    leaf nodes - hri_challenge.xml in particular is built almost entirely
    out of SubTree calls (GreetAndSeatGuest, HandleBagHandover), so without
    this the rendered tree would mostly just be empty boxes. Each
    instantiation is expanded independently (GreetAndSeatGuest is called
    twice, once per guest, with different port remaps) - this reflects two
    separate, isolated instances, not a shared/duplicated structure.
    """
    try:
        tree = ET.parse(xml_path)
    except ET.ParseError as exc:
        raise TreeParseError(f"malformed XML in {xml_path}: {exc}") from exc
    except FileNotFoundError as exc:
        raise TreeParseError(f"tree file not found: {xml_path}") from exc

    root_elem = tree.getroot()
    if root_elem.tag != "root":
        raise TreeParseError(f"expected <root> at the top level of {xml_path}, got <{root_elem.tag}>")

    behavior_trees: dict[str, ET.Element] = {}
    for bt_elem in root_elem.findall("BehaviorTree"):
        bt_id = bt_elem.get("ID")
        if bt_id:
            behavior_trees[bt_id] = bt_elem

    if not behavior_trees:
        raise TreeParseError(f"no <BehaviorTree> elements found in {xml_path}")

    main_id = root_elem.get("main_tree_to_execute")
    if main_id is None:
        # BT.CPP treats a single defined tree as the implicit entry point;
        # with more than one and no explicit main_tree_to_execute, which one
        # is "the" tree is genuinely ambiguous - fall back to the first
        # rather than guessing further.
        main_id = next(iter(behavior_trees))

    main_elem = behavior_trees.get(main_id)
    if main_elem is None:
        raise TreeParseError(f"main_tree_to_execute='{main_id}' not defined in {xml_path}")

    root_children = list(main_elem)
    if not root_children:
        raise TreeParseError(f"<BehaviorTree ID='{main_id}'> has no root node")

    node = _parse_node(root_children[0], behavior_trees, visited=frozenset({main_id}), path="")
    return {"tree_id": main_id, "root": node}


def _parse_node(
    elem: ET.Element, behavior_trees: dict[str, ET.Element], visited: frozenset, path: str
) -> dict:
    """`path` is the accumulated full_path PREFIX inherited from the nearest
    enclosing SubTree crossing (or "" at the root) - matches BT.CPP's own
    fullPath() exactly: a path segment is only ever added when RECURSING
    INTO a SubTree's body (using that SubTree call's own instance name),
    never for a plain control/decorator node - confirmed live (see
    hri_nodes.hpp/hri_challenge.xml's own comments on this) that BT.CPP's
    fullPath() for a leaf skips every intermediate Sequence/Fallback/
    WithGaze/etc. in between, so this parser has to skip them too or the
    computed full_path wouldn't match what a real substitution rule (or a
    stub_leaves key applied at runtime) actually needs to filter against.
    """
    tag = elem.tag
    attrib = dict(elem.attrib)
    instance_name = attrib.pop("name", None)
    # `_uid` only appears when parsing a live Groot2Publisher FULLTREE reply
    # (BT.CPP injects it at runtime) - never present in the static XML
    # files on disk, so this stays None for the plain B1 file-parse case
    # and is only populated for the live/B2+ path. Same parser serves both.
    uid_attr = attrib.pop("_uid", None)
    uid = int(uid_attr) if uid_attr is not None else None
    own_name = instance_name or (attrib.get("ID") if tag == "SubTree" else tag)
    full_path = f"{path}/{own_name}" if path else own_name

    if tag == "SubTree":
        subtree_id: Optional[str] = attrib.pop("ID", None)
        node = {
            "type": "SubTree",
            "instance_name": instance_name or subtree_id or "SubTree",
            "subtree_id": subtree_id,
            "uid": uid,
            "full_path": full_path,
            "ports": attrib,
            "children": [],
        }
        if subtree_id in visited:
            node["note"] = "cyclic SubTree reference, not expanded"
        elif subtree_id and subtree_id in behavior_trees:
            subtree_children = list(behavior_trees[subtree_id])
            if subtree_children:
                node["children"] = [
                    _parse_node(subtree_children[0], behavior_trees, visited | {subtree_id}, full_path)
                ]
        elif subtree_id:
            node["note"] = f"SubTree '{subtree_id}' not defined in this file"
        return node

    return {
        "type": tag,
        "instance_name": instance_name or tag,
        "uid": uid,
        # Not a SubTree crossing - children inherit the SAME path prefix
        # this node itself received, not full_path (which is only this
        # node's own address, never propagated further down).
        "full_path": full_path,
        "ports": attrib,
        "children": [_parse_node(child, behavior_trees, visited, path) for child in elem],
    }

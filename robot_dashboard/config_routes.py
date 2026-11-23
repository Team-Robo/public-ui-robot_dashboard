"""GET/PUT endpoints for editing targets.yaml/behavior_trees.yaml through
the dashboard's own config-GUI instead of SSHing into the robot to hand-edit
YAML. Reads/writes config_store's live copy (~/.dashboard_*.yaml, seeded
from the package template, never touched by colcon afterward) and applies
changes immediately - ProcessManager.reload_targets() / TreeRegistry.reload()
- no server restart needed.

Two devices can have this open at once, both editing from the same
snapshot - see _compute_version()/put_targets()/put_trees() for how a
second, now-stale save is handled without silently deleting whatever the
first save added.
"""

import asyncio
import hashlib
import json
from typing import Callable

import yaml
from fastapi import APIRouter, Header, HTTPException, Response
from pydantic import BaseModel, ValidationError

from .bt.config import load_trees
from .bt.models import TreeConfig
from .bt.registry import TreeRegistry
from .config_store import live_config_path, load_live_yaml, save_live_yaml
from .supervisor.conditions import ConditionError, validate
from .supervisor.config import load_targets
from .supervisor.models import TargetConfig
from .supervisor.process_manager import ProcessManager


def _compute_version(items: list[BaseModel]) -> str:
    """A short hash of the current list's actual content (not a counter) -
    two devices that happen to fetch at the same version always agree on
    what it is, with nothing to keep in sync server-side beyond the config
    file itself."""
    canonical = json.dumps([i.model_dump(exclude_none=True) for i in items], sort_keys=True)
    return hashlib.sha256(canonical.encode()).hexdigest()[:16]


def _merge_commented_list(seq, new_dicts: list[dict], *, allow_deletions: bool) -> None:
    """Mutates a ruamel CommentedSeq of {id: ...}-keyed entries to match
    new_dicts (matched by id), in place - existing entries keep their own
    CommentedMap object (and whatever comments are attached to their still-
    present keys) instead of being replaced wholesale, which is what would
    silently drop those comments. An id not seen before is appended as a
    plain dict (nothing to preserve there - it's new).

    allow_deletions=False is the conflict path: an id present in `seq` but
    missing from new_dicts is left alone instead of removed. A save built
    from a stale snapshot doesn't actually know the current full set of
    ids - "missing from what I'm submitting" might just mean "someone
    else added this after I loaded my copy", not "please delete this". So
    a stale save only ever adds/updates, never deletes - if the caller
    genuinely wants to delete something, that only takes effect once
    they're saving from the current version, not a stale one."""
    new_ids = {d["id"] for d in new_dicts}
    if allow_deletions:
        for i in reversed(range(len(seq))):
            if seq[i].get("id") not in new_ids:
                del seq[i]

    existing_by_id = {entry.get("id"): i for i, entry in enumerate(seq)}
    for d in new_dicts:
        if d["id"] in existing_by_id:
            entry = seq[existing_by_id[d["id"]]]
            for k in list(entry.keys()):
                if k not in d:
                    del entry[k]
            for k, v in d.items():
                entry[k] = v
        else:
            seq.append(d)


def _check_duplicate_ids(items: list, kind: str) -> None:
    seen: set[str] = set()
    for item in items:
        if item.id in seen:
            raise HTTPException(status_code=400, detail=f"duplicate {kind} id: {item.id}")
        seen.add(item.id)


def _diff_by_id(old_by_id: dict, new_items: list) -> dict:
    """added/removed/changed target or tree ids between an old {id: model}
    snapshot and a freshly-loaded list - "changed" compares full serialized
    content, not just presence, so relabeling a target or editing one field
    shows up too, not just additions/deletions."""
    new_by_id = {i.id: i for i in new_items}
    old_ids, new_ids = set(old_by_id), set(new_by_id)
    changed = sorted(
        tid for tid in (old_ids & new_ids)
        if old_by_id[tid].model_dump(exclude_none=True) != new_by_id[tid].model_dump(exclude_none=True)
    )
    return {"added": sorted(new_ids - old_ids), "removed": sorted(old_ids - new_ids), "changed": changed}


def reload_live_config(pm: ProcessManager, tree_registry: TreeRegistry) -> dict:
    """Re-read BOTH live config files (~/.dashboard_targets.yaml and
    ~/.dashboard_behavior_trees.yaml) from disk and apply them to the running
    server. This is the counterpart to the Settings-save PUT (which also
    writes the file): use it after hand-editing either file outside the
    Settings GUI, where the config-GUI's merge-by-id save could otherwise
    clobber your manual edit against its own stale snapshot.

    Reloading never disturbs a running process - reload_targets() swaps a
    still-present id's config in place and refuses to drop anything RUNNING
    (those come back in skipped_removals), and TreeRegistry.reload() keeps any
    live BT state. Shared by POST /api/config/reload, the page-load reload
    (App.tsx, on every F5), and the periodic reload loop (see
    env_reload.start_periodic_reload's extra_refresh) so all three do
    exactly the same from-disk reload.

    Snapshots the PREVIOUS state (pm.current_target_configs() /
    tree_registry.by_id - the only place it lives, since load_targets()/
    load_trees() always read fresh from disk with no memory of last time)
    before reloading, so the response can say WHAT changed, not just how
    many targets/trees exist now - the frontend surfaces this as a toast
    (see App.tsx's own page-load effect) so a hand-edited config file (or
    someone else's save) doesn't go unnoticed just because nothing LOOKS
    different until you go looking.

    Also reports code_changed (pm.check_package_changes()) - a colcon
    rebuild of a target's package edits neither targets.yaml nor any
    AMENT_PREFIX_PATH-style env var (the install path itself doesn't move),
    so targets_diff and the environment-reload's own changed_keys would
    both stay silent about it. This is a genuinely separate signal, not
    folded into targets_diff's shape."""
    old_targets_by_id = pm.current_target_configs()
    old_trees_by_id = dict(tree_registry.by_id)
    targets = load_targets()
    skipped = pm.reload_targets(targets)
    code_changed = pm.check_package_changes(targets)
    trees = load_trees()
    tree_registry.reload(trees)
    return {
        "applied": True,
        "targets": len(targets),
        "skipped_removals": skipped,
        "trees": len(trees),
        "targets_diff": _diff_by_id(old_targets_by_id, targets),
        "trees_diff": _diff_by_id(old_trees_by_id, trees),
        "code_changed": code_changed,
    }


def _validate_requires(items: list[TargetConfig], known_target_ids: set[str] | None) -> None:
    """Validate every target's `requires` expression (shape + any referenced
    `target:` id). Broken expressions here are a typing/config mistake, not a
    runtime concern - rejected up front as a clean 400 instead of surfacing
    later as a 500 from load_targets(). Cyclic *references* are deliberately
    NOT rejected (see conditions.py) - only bad shape/kinds/bad ids are."""
    for item in items:
        if not item.requires:
            continue
        try:
            validate(
                item.requires,
                known_target_ids=known_target_ids,
                known_flag_names={f.name for f in item.flags},
            )
        except ConditionError as exc:
            raise HTTPException(status_code=400, detail=f"target '{item.id}': invalid requires: {exc}") from exc


def _validate_kind_requirements(items: list[TargetConfig]) -> None:
    """Same reasoning as _validate_requires: a target missing the fields its
    own `kind` needs (package/executable for run, package/launch_file for
    launch, cmd for windows) used to be caught at pydantic-parse time when
    `package` was a required field - it's Optional[str] now (kind=windows
    doesn't use it), so nothing else was enforcing this at save time.
    Without this, a broken target saved cleanly and only failed later, at
    Start, with a generic ValueError->400 - rejected up front here instead,
    matching build_command()'s own checks in process_manager.py."""
    for item in items:
        if item.kind == "run" and not (item.package and item.executable):
            raise HTTPException(
                status_code=400, detail=f"target '{item.id}': kind=run requires 'package' and 'executable'"
            )
        if item.kind == "launch" and not (item.package and item.launch_file):
            raise HTTPException(
                status_code=400, detail=f"target '{item.id}': kind=launch requires 'package' and 'launch_file'"
            )
        if item.kind == "windows" and not item.cmd:
            raise HTTPException(status_code=400, detail=f"target '{item.id}': kind=windows requires 'cmd'")


def _targets_need_env_reload(old_targets: list[TargetConfig], new_targets: list[TargetConfig]) -> bool:
    """A colcon-built package only affects PATH/PYTHONPATH/AMENT_PREFIX_PATH
    resolution for a target's package/executable/launch_file/cmd - re-
    labeling it, reordering its flags, editing env/args/requires, etc.
    don't need dashboard_server's own environment refreshed (which costs
    several seconds - see env_reload.py). Only reload when one of those
    fields actually changed, or a target was added (deletions never need
    it - nothing new to discover)."""
    def relevant(t: TargetConfig) -> tuple:
        return (t.kind, t.package, t.executable, t.launch_file, tuple(t.cmd) if t.cmd else None)

    old_by_id = {t.id: relevant(t) for t in old_targets}
    return any(old_by_id.get(t.id) != relevant(t) for t in new_targets)


def _trees_need_env_reload(old_trees: list[TreeConfig], new_trees: list[TreeConfig]) -> bool:
    """Same reasoning as _targets_need_env_reload - a tree's package/
    tree_file resolve via get_package_share_directory(), which reads
    AMENT_PREFIX_PATH."""
    def relevant(t: TreeConfig) -> tuple:
        return (t.package, t.tree_file)

    old_by_id = {t.id: relevant(t) for t in old_trees}
    return any(old_by_id.get(t.id) != relevant(t) for t in new_trees)


def _coerce_pasted_list(data, wrapper_key: str) -> list:
    """Accepts whatever shape someone would plausibly paste: the whole
    file (`{wrapper_key: [...]}`), a bare list, or a single entry pasted
    alone (a bare dict, for "just paste the one target/tree I want to
    add") - normalizes all three into a plain list to validate."""
    if isinstance(data, dict) and wrapper_key in data:
        data = data[wrapper_key]
    if isinstance(data, dict):
        data = [data]
    if not isinstance(data, list):
        raise HTTPException(
            status_code=400,
            detail=f"expected a list of entries (optionally under a top-level '{wrapper_key}:' key) or a single entry",
        )
    return data


def create_config_router(
    pm: ProcessManager, tree_registry: TreeRegistry, reload_env: Callable[[], tuple[bool, list[str]]]
) -> APIRouter:
    router = APIRouter(prefix="/api/config", tags=["config"])

    @router.get("/targets")
    async def get_targets(response: Response):
        items = load_targets()
        response.headers["X-Config-Version"] = _compute_version(items)
        return [t.model_dump(exclude_none=True) for t in items]

    @router.put("/targets")
    async def put_targets(
        new_targets: list[TargetConfig], response: Response, x_config_version: str | None = Header(default=None)
    ):
        _check_duplicate_ids(new_targets, "target")
        _validate_requires(new_targets, {t.id for t in new_targets})
        _validate_kind_requirements(new_targets)
        old_targets = load_targets()
        current_version = _compute_version(old_targets)
        # No header at all (an older client, or nothing fetched yet this
        # session) trusts the submission fully, same as before this check
        # existed - the conflict path only applies once a client actually
        # had a version to compare against.
        conflict = x_config_version is not None and x_config_version != current_version
        doc = load_live_yaml("targets.yaml")
        new_dicts = [t.model_dump(exclude_none=True) for t in new_targets]
        _merge_commented_list(doc["targets"], new_dicts, allow_deletions=not conflict)
        save_live_yaml("targets.yaml", doc)
        # Reload from what's actually now on disk, not from new_targets -
        # on the conflict path the saved result can differ from what the
        # client submitted (a deletion it intended didn't happen).
        saved_targets = load_targets()
        skipped = pm.reload_targets(saved_targets)
        # A saved target is often "I just colcon-built a new package and
        # want to launch it" - refresh dashboard_server's own env now
        # rather than making that wait for the next periodic reload (see
        # env_reload.py), but only when package/executable/launch_file/cmd
        # actually changed - relabeling a target, editing its env/args/
        # requires, etc. can't need a new package discovered, and this
        # costs several real seconds every time it runs. Blocking the
        # response on it (when it does run) is still deliberate: simpler
        # and more predictable than a fire-and-forget task here.
        if _targets_need_env_reload(old_targets, saved_targets):
            await asyncio.to_thread(reload_env)
        response.headers["X-Config-Version"] = _compute_version(saved_targets)
        return {
            "applied": True,
            "path": live_config_path("targets.yaml"),
            "skipped_removals": skipped,
            "conflict": conflict,
        }

    @router.post("/reload")
    async def reload_config(response: Response):
        """Re-read both live config files from disk and apply - see
        reload_live_config(). The /api/config/reload + the periodic reload
        loop share that one function, so a hand-edit is picked up the same
        way either way (manual button, or the 5-min timer)."""
        result = reload_live_config(pm, tree_registry)
        response.headers["X-Config-Version"] = _compute_version(load_targets())
        return result

    @router.post("/targets/reorder")
    async def reorder_targets(body: dict):
        """Persists Control-tab drag-to-reorder as a separate
        target_order: [id, ...] list, never by physically reordering the
        targets: block itself - see supervisor/config.py's load_targets()
        for why (ruamel tracks a block sequence's comments by position,
        not identity, so reordering that block would scramble hand-
        written comments). Applies live via reload_targets(), same as any
        other change here, though order itself doesn't affect anything
        ProcessManager tracks - purely a display-order concern."""
        order = body.get("order")
        current_ids = {t.id for t in load_targets()}
        if not isinstance(order, list) or not all(isinstance(x, str) for x in order) or set(order) != current_ids:
            raise HTTPException(status_code=400, detail="order must contain exactly the current target ids")
        doc = load_live_yaml("targets.yaml")
        doc["target_order"] = order
        save_live_yaml("targets.yaml", doc)
        pm.reload_targets(load_targets())
        return {"applied": True}

    @router.post("/targets/parse")
    async def parse_targets(body: dict):
        """Turns pasted/imported YAML text into validated FullTargetConfig
        entries - the same shape GET/PUT already use, so the frontend can
        just fold the result into its current editor state. Doesn't touch
        disk at all - this is purely "help me fill in the editor", saving
        is still the existing PUT flow once the user reviews what came in."""
        try:
            data = yaml.safe_load(body.get("yaml_text", ""))
        except yaml.YAMLError as e:
            raise HTTPException(status_code=400, detail=f"invalid YAML: {e}")
        items = _coerce_pasted_list(data, "targets")
        try:
            targets = [TargetConfig(**t) for t in items]
        except (ValidationError, TypeError) as e:
            raise HTTPException(status_code=400, detail=str(e))
        _check_duplicate_ids(targets, "target")
        # Import/paste path: validate `requires` shape (no known-target set -
        # a pasted entry may be a standalone fragment; target-id existence is
        # still enforced on save, when the whole set is known).
        _validate_requires(targets, None)
        _validate_kind_requirements(targets)
        return [t.model_dump(exclude_none=True) for t in targets]

    @router.get("/behavior_trees")
    async def get_trees(response: Response):
        items = load_trees()
        response.headers["X-Config-Version"] = _compute_version(items)
        return [t.model_dump(exclude_none=True) for t in items]

    @router.put("/behavior_trees")
    async def put_trees(
        new_trees: list[TreeConfig], response: Response, x_config_version: str | None = Header(default=None)
    ):
        _check_duplicate_ids(new_trees, "tree")
        old_trees = load_trees()
        current_version = _compute_version(old_trees)
        conflict = x_config_version is not None and x_config_version != current_version
        doc = load_live_yaml("behavior_trees.yaml")
        new_dicts = [t.model_dump(exclude_none=True) for t in new_trees]
        _merge_commented_list(doc["trees"], new_dicts, allow_deletions=not conflict)
        save_live_yaml("behavior_trees.yaml", doc)
        saved_trees = load_trees()
        tree_registry.reload(saved_trees)
        # Same reasoning as put_targets - only pay for a reload when a
        # tree's package/tree_file actually changed.
        if _trees_need_env_reload(old_trees, saved_trees):
            await asyncio.to_thread(reload_env)
        response.headers["X-Config-Version"] = _compute_version(saved_trees)
        return {"applied": True, "path": live_config_path("behavior_trees.yaml"), "conflict": conflict}

    @router.post("/behavior_trees/parse")
    async def parse_trees(body: dict):
        try:
            data = yaml.safe_load(body.get("yaml_text", ""))
        except yaml.YAMLError as e:
            raise HTTPException(status_code=400, detail=f"invalid YAML: {e}")
        items = _coerce_pasted_list(data, "trees")
        try:
            trees = [TreeConfig(**t) for t in items]
        except (ValidationError, TypeError) as e:
            raise HTTPException(status_code=400, detail=str(e))
        _check_duplicate_ids(trees, "tree")
        return [t.model_dump(exclude_none=True) for t in trees]

    return router

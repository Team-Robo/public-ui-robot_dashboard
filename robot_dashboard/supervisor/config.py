import os

import yaml

from ..config_store import live_config_path
from .conditions import ConditionError, validate
from .models import TargetConfig


def load_targets() -> list[TargetConfig]:
    """Reads from ~/.dashboard_targets.yaml (config_store's live copy,
    seeded from share/dashboard/config/targets.yaml on first run) - not a
    caller-supplied path, so this and the config-GUI's write path can
    never point at two different files."""
    with open(live_config_path("targets.yaml"), "r") as f:
        raw = yaml.safe_load(f) or {}

    targets = [TargetConfig(**t) for t in raw.get("targets", [])]

    seen: set[str] = set()
    for t in targets:
        if t.id in seen:
            raise ValueError(f"Duplicate target id in targets.yaml: {t.id}")
        seen.add(t.id)
        t.env = {k: os.path.expanduser(v) for k, v in t.env.items()}
        if t.cwd:
            t.cwd = os.path.expanduser(t.cwd)

    # Dependency conditions: every target's `requires` expression is validated
    # for shape + that any referenced `target:` id actually exists (a typo).
    # Cyclic *references* (A needs B, B needs A) are allowed and normal - a
    # cycle is only a problem for cyclic *opening*, which the supervisor's
    # dependency closure resolves with a visited-set instead of looping. So it
    # is deliberately NOT rejected here. Raised as ValueError (not
    # ConditionError) so the caller's existing error handling covers it.
    requires_by_id = {t.id: t.requires for t in targets if t.requires}
    flags_by_id = {t.id: {f.name for f in t.flags} for t in targets}
    for tid, expr in requires_by_id.items():
        try:
            validate(expr, known_target_ids=seen, known_flag_names=flags_by_id.get(tid, set()))
        except ConditionError as exc:
            raise ValueError(f"target '{tid}': invalid requires: {exc}") from exc

    # target_order (optional) - a separate flat list of ids, not the
    # targets: block's own physical order. Kept deliberately separate so
    # a Control-tab drag-to-reorder never has to touch (and risk
    # scrambling) the comment-carrying targets: entries themselves -
    # ruamel.yaml tracks a block sequence's inter-item comments by
    # position, not by the item's identity, so physically reordering
    # that block would silently detach hand-written comments from the
    # target they were written above. A target not mentioned in
    # target_order (new since it was last saved) keeps its natural
    # targets: position, sorted in after everything that IS ordered -
    # Python's sort is stable, so ties (everything unmentioned shares
    # the same fallback rank) preserve their original relative order.
    order = raw.get("target_order")
    if order:
        rank = {tid: i for i, tid in enumerate(order)}
        targets.sort(key=lambda t: rank.get(t.id, len(order)))

    return targets

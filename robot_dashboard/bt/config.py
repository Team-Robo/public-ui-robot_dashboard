import yaml

from ..config_store import live_config_path
from .models import TreeConfig


def load_trees() -> list[TreeConfig]:
    """Reads from ~/.dashboard_behavior_trees.yaml (config_store's live
    copy, seeded from share/dashboard/config/behavior_trees.yaml on first
    run) - not a caller-supplied path, so this and the config-GUI's write
    path can never point at two different files."""
    with open(live_config_path("behavior_trees.yaml"), "r") as f:
        raw = yaml.safe_load(f) or {}

    trees = [TreeConfig(**t) for t in raw.get("trees", [])]

    seen: set[str] = set()
    for t in trees:
        if t.id in seen:
            raise ValueError(f"Duplicate tree id in behavior_trees.yaml: {t.id}")
        seen.add(t.id)

    return trees

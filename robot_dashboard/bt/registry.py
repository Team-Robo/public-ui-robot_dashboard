from .models import TreeConfig


class TreeRegistry:
    """Mutable holder for the live tree list - create_bt_router() reads
    through this instead of closing over a plain list, so the config-GUI's
    save path can call reload() and have every route see the new list
    immediately, no restart needed."""

    def __init__(self, trees: list[TreeConfig]):
        self.trees: list[TreeConfig] = []
        self.by_id: dict[str, TreeConfig] = {}
        self.reload(trees)

    def reload(self, trees: list[TreeConfig]) -> None:
        self.trees = trees
        self.by_id = {t.id: t for t in trees}

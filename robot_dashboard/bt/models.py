from typing import Literal, Optional

from pydantic import BaseModel, Field


class TreeConfig(BaseModel):
    id: str
    label: str
    package: str
    tree_file: str
    target_id: Optional[str] = None
    groot2_port: Optional[int] = None
    # full_path (see static_tree.py's own computation - segments only at
    # SubTree crossings, matching BT.CPP's own fullPath()) -> desired stub
    # outcome. Only leaf nodes are ever valid keys (control/decorator nodes
    # can't be substituted) - the dashboard's stub-edit UI enforces this by
    # only making leaves clickable; not re-validated against tree structure
    # here since a stale key (from an edited tree) should just be silently
    # unmatched at runtime, not block a config save.
    stub_leaves: dict[str, Literal["success", "failure"]] = Field(default_factory=dict)
    # Shows the BT tab's Run / Next step / Cancel bar (MissionControls.tsx),
    # which calls hri_bt_main's /behaviour_tree/run_mission, cancel_mission,
    # get_mission_status and /behaviour_tree/demo/* services.
    mission_control: bool = False

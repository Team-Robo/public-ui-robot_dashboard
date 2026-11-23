"""Where the dashboard's *live*, GUI-editable config actually lives -
deliberately NOT the package's own installed share/dashboard/config/ copy,
which colcon happily overwrites on every rebuild (that copy is the shipped
template/default, not something a config-GUI edit should have to survive
against). Matches ~/.dashboard_passcode's own convention: real, mutable
settings live in the user's home directory, outside anything colcon
manages, so a GUI-driven edit is never at risk from an unrelated
`colcon build` later.

On first run (no live copy yet), the file is seeded from the package's
own template and never touched by colcon again after that.
"""

import os
import shutil

from ament_index_python.packages import get_package_share_directory
from ruamel.yaml import YAML

# round_trip (the default) preserves comments/formatting/key order -
# required for the config-GUI's write path to not silently delete the
# hand-written documentation these files ship with.
_yaml = YAML()
_yaml.preserve_quotes = True
_yaml.indent(mapping=2, sequence=4, offset=2)


def live_config_path(filename: str) -> str:
    """~/.dashboard_<filename> - seeded once from share/dashboard/config/
    <filename> if it doesn't exist yet."""
    path = os.path.expanduser(f"~/.dashboard_{filename}")
    if not os.path.exists(path):
        template = os.path.join(get_package_share_directory("robot_dashboard"), "config", filename)
        shutil.copy(template, path)
    return path


def load_live_yaml(filename: str):
    """The full ruamel-parsed document (a CommentedMap) - mutate it in
    place and pass it to save_live_yaml() to keep existing comments and
    formatting intact for anything not explicitly changed."""
    with open(live_config_path(filename), "r") as f:
        return _yaml.load(f)


def save_live_yaml(filename: str, doc) -> None:
    with open(live_config_path(filename), "w") as f:
        _yaml.dump(doc, f)

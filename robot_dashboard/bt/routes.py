import asyncio
import os

from ament_index_python.packages import PackageNotFoundError, get_package_share_directory
from fastapi import APIRouter, HTTPException

from .groot2_client import Groot2ClientError, fetch_live_tree, fetch_status
from .models import TreeConfig
from .registry import TreeRegistry
from .static_tree import TreeParseError, parse_tree_file


def create_bt_router(registry: TreeRegistry) -> APIRouter:
    router = APIRouter(prefix="/api/bt", tags=["bt"])

    def _require_tree(tree_id: str) -> TreeConfig:
        cfg = registry.by_id.get(tree_id)
        if cfg is None:
            raise HTTPException(status_code=404, detail=f"unknown tree '{tree_id}'")
        return cfg

    @router.get("/trees")
    async def list_trees():
        return [t.model_dump() for t in registry.trees]

    @router.get("/trees/{tree_id}/structure")
    async def get_tree_structure(tree_id: str):
        cfg = _require_tree(tree_id)
        try:
            pkg_share = get_package_share_directory(cfg.package)
        except PackageNotFoundError:
            raise HTTPException(status_code=404, detail=f"ROS 2 package '{cfg.package}' not found")
        xml_path = os.path.join(pkg_share, cfg.tree_file)
        try:
            return await asyncio.to_thread(parse_tree_file, xml_path)
        except TreeParseError as exc:
            raise HTTPException(status_code=409, detail=str(exc))

    @router.get("/trees/{tree_id}/live-structure")
    async def get_live_structure(tree_id: str):
        cfg = _require_tree(tree_id)
        if cfg.groot2_port is None:
            raise HTTPException(status_code=409, detail="no groot2_port configured for this tree")
        try:
            return await asyncio.to_thread(fetch_live_tree, cfg.groot2_port)
        except Groot2ClientError as exc:
            raise HTTPException(status_code=409, detail=str(exc))

    @router.get("/trees/{tree_id}/live-status")
    async def get_live_status(tree_id: str):
        cfg = _require_tree(tree_id)
        if cfg.groot2_port is None:
            raise HTTPException(status_code=409, detail="no groot2_port configured for this tree")
        try:
            return await asyncio.to_thread(fetch_status, cfg.groot2_port)
        except Groot2ClientError as exc:
            raise HTTPException(status_code=409, detail=str(exc))

    return router

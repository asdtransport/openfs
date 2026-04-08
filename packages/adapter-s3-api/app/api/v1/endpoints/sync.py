"""API endpoints for sync operations."""

import os
import shutil
import tempfile
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, BackgroundTasks, HTTPException, status
from pydantic import BaseModel

from app.services.minio_client import minio_client
from app.core.logging import logger

router = APIRouter(prefix="/sync", tags=["sync"])


class SyncRequest(BaseModel):
    """Synchronization request model."""
    source_path: str
    target_bucket: str
    target_prefix: str = ""
    exclude: Optional[List[str]] = None
    delete: bool = False
    dry_run: bool = False


class SyncResponse(BaseModel):
    """Synchronization response model."""
    success: bool
    message: str
    stats: Optional[dict] = None


def sync_directory_to_minio(
    source_path: str,
    target_bucket: str,
    target_prefix: str = "",
    exclude: Optional[List[str]] = None,
    delete: bool = False,
    dry_run: bool = False,
) -> dict:
    """Synchronize a local directory to MinIO.
    
    Args:
        source_path: Local directory path to sync
        target_bucket: Target MinIO bucket
        target_prefix: Prefix for objects in the bucket
        exclude: List of patterns to exclude
        delete: If True, delete files in target that don't exist in source
        dry_run: If True, only show what would be done without making changes
        
    Returns:
        dict: Synchronization statistics
    """
    source = Path(source_path)
    if not source.exists() or not source.is_dir():
        raise ValueError(f"Source path '{source_path}' is not a valid directory")
    
    if exclude is None:
        exclude = []
    
    stats = {
        "total_files": 0,
        "uploaded": 0,
        "downloaded": 0,
        "deleted": 0,
        "skipped": 0,
        "errors": 0,
    }
    
    # Ensure the bucket exists
    if not dry_run:
        if not minio_client.client.bucket_exists(target_bucket):
            minio_client.client.make_bucket(target_bucket)
    
    # First, handle uploads and updates
    for root, _, files in os.walk(source):
        rel_path = os.path.relpath(root, source)
        if rel_path == '.':
            rel_path = ''
            
        for file in files:
            # Skip excluded files
            if any(file.endswith(ext) for ext in exclude):
                stats["skipped"] += 1
                continue
                
            local_file = Path(root) / file
            object_name = str(Path(target_prefix) / rel_path / file) if target_prefix or rel_path else file
            
            stats["total_files"] += 1
            
            try:
                # Check if the file exists in MinIO and if it's different
                try:
                    obj = minio_client.client.stat_object(target_bucket, object_name)
                    local_mtime = local_file.stat().st_mtime
                    remote_mtime = obj.last_modified.timestamp()
                    
                    # Skip if files are the same
                    if local_mtime <= remote_mtime and obj.size == local_file.stat().st_size:
                        stats["skipped"] += 1
                        continue
                        
                except Exception:
                    pass  # Object doesn't exist, upload it
                
                # Upload the file
                if not dry_run:
                    minio_client.client.fput_object(
                        bucket_name=target_bucket,
                        object_name=object_name,
                        file_path=str(local_file),
                    )
                stats["uploaded"] += 1
                    
            except Exception as e:
                logger.error(f"Error syncing {local_file}: {e}")
                stats["errors"] += 1
    
    # Handle deletes if requested
    if delete and not dry_run:
        try:
            # Get all objects in the target prefix
            objects = minio_client.client.list_objects(
                target_bucket,
                prefix=target_prefix,
                recursive=True,
            )
            
            # Convert local files to a set of relative paths
            local_files = set()
            for root, _, files in os.walk(source):
                rel_root = os.path.relpath(root, source)
                if rel_root == '.':
                    rel_root = ''
                for file in files:
                    if not any(file.endswith(ext) for ext in exclude):
                        local_files.add(str(Path(rel_root) / file) if rel_root else file)
            
            # Check for files in MinIO that don't exist locally
            for obj in objects:
                rel_path = obj.object_name[len(target_prefix):].lstrip('/') if target_prefix else obj.object_name
                if rel_path not in local_files:
                    minio_client.client.remove_object(target_bucket, obj.object_name)
                    stats["deleted"] += 1
                    
        except Exception as e:
            logger.error(f"Error during cleanup: {e}")
            stats["errors"] += 1
    
    return stats


@router.post("/to-minio", response_model=SyncResponse)
async def sync_to_minio(
    request: SyncRequest,
    background_tasks: BackgroundTasks,
):
    """Synchronize a local directory to MinIO."""
    try:
        stats = sync_directory_to_minio(
            source_path=request.source_path,
            target_bucket=request.target_bucket,
            target_prefix=request.target_prefix,
            exclude=request.exclude or [],
            delete=request.delete,
            dry_run=request.dry_run,
        )
        
        return {
            "success": True,
            "message": "Synchronization completed successfully",
            "stats": stats,
        }
        
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error during synchronization: {str(e)}",
        )


@router.post("/from-minio", response_model=SyncResponse)
async def sync_from_minio(
    bucket: str,
    prefix: str = "",
    target_dir: str = ".",
    exclude: List[str] = None,
    delete: bool = False,
    dry_run: bool = False,
):
    """Synchronize from MinIO to a local directory."""
    if exclude is None:
        exclude = []
        
    stats = {
        "total_files": 0,
        "uploaded": 0,
        "downloaded": 0,
        "deleted": 0,
        "skipped": 0,
        "errors": 0,
    }
    
    try:
        # Ensure target directory exists
        target = Path(target_dir)
        target.mkdir(parents=True, exist_ok=True)
        
        # First, handle downloads and updates
        objects = minio_client.client.list_objects(
            bucket_name=bucket,
            prefix=prefix,
            recursive=True,
        )
        
        for obj in objects:
            # Skip excluded files
            if any(obj.object_name.endswith(ext) for ext in exclude):
                stats["skipped"] += 1
                continue
                
            stats["total_files"] += 1
            
            try:
                local_path = target / obj.object_name[len(prefix):].lstrip('/')
                local_path.parent.mkdir(parents=True, exist_ok=True)
                
                # Check if we need to download the file
                download_needed = True
                if local_path.exists():
                    local_mtime = local_path.stat().st_mtime
                    remote_mtime = obj.last_modified.timestamp()
                    
                    if local_mtime >= remote_mtime and local_path.stat().st_size == obj.size:
                        stats["skipped"] += 1
                        download_needed = False
                
                if download_needed and not dry_run:
                    minio_client.client.fget_object(
                        bucket_name=bucket,
                        object_name=obj.object_name,
                        file_path=str(local_path),
                    )
                    # Update the local file's mtime to match the remote
                    os.utime(local_path, (remote_mtime, remote_mtime))
                    stats["downloaded"] += 1
                
            except Exception as e:
                logger.error(f"Error syncing {obj.object_name}: {e}")
                stats["errors"] += 1
        
        # Handle deletes if requested
        if delete and not dry_run:
            # Get all local files
            local_files = set()
            for root, _, files in os.walk(target):
                for file in files:
                    rel_path = str((Path(root) / file).relative_to(target))
                    if not any(rel_path.endswith(ext) for ext in exclude):
                        local_files.add(rel_path)
            
            # Get all remote files
            remote_files = set()
            objects = minio_client.client.list_objects(
                bucket_name=bucket,
                prefix=prefix,
                recursive=True,
            )
            for obj in objects:
                if not any(obj.object_name.endswith(ext) for ext in exclude):
                    remote_path = obj.object_name[len(prefix):].lstrip('/')
                    remote_files.add(remote_path)
            
            # Delete local files that don't exist remotely
            for local_file in local_files - remote_files:
                try:
                    (target / local_file).unlink()
                    stats["deleted"] += 1
                except Exception as e:
                    logger.error(f"Error deleting {local_file}: {e}")
                    stats["errors"] += 1
        
        return {
            "success": True,
            "message": "Synchronization completed successfully",
            "stats": stats,
        }
        
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error during synchronization: {str(e)}",
        )

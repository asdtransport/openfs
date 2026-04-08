"""API endpoints for bucket operations."""

from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, status, Request
from pydantic import BaseModel

from app.services.minio_client import minio_client

router = APIRouter(prefix="/buckets", tags=["buckets"])


class BucketCreate(BaseModel):
    """Bucket creation model."""
    name: str


@router.post("/", status_code=status.HTTP_201_CREATED)
async def create_bucket(bucket: BucketCreate):
    """Create a new bucket."""
    try:
        if minio_client.client.bucket_exists(bucket.name):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Bucket '{bucket.name}' already exists",
            )
        minio_client.client.make_bucket(bucket.name)
        return {"message": f"Bucket '{bucket.name}' created successfully"}
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error creating bucket: {str(e)}",
        )


@router.get("/")
async def list_buckets(request: Request):
    """List buckets accessible to current user."""
    try:
        # Get current user from security middleware
        current_user = getattr(request.state, 'current_user', None)
        if not current_user:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Authentication required"
            )
        
        # Get all buckets from MinIO
        all_buckets = minio_client.client.list_buckets()
        
        # Filter buckets based on user permissions
        accessible_buckets = []
        for bucket in all_buckets:
            bucket_name = bucket.name
            
            # Check if user can access this bucket
            if await _can_user_access_bucket(current_user, bucket_name):
                accessible_buckets.append({
                    "name": bucket_name, 
                    "created": bucket.creation_date,
                    "owner": _get_bucket_owner(bucket_name),
                    "access_level": await _get_user_bucket_access_level(current_user, bucket_name)
                })
        
        return accessible_buckets
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error listing buckets: {str(e)}",
        )

async def _can_user_access_bucket(username: str, bucket_name: str) -> bool:
    """Check if user can access the specified bucket."""
    # User owns bucket (user-{username}-*)
    if bucket_name.startswith(f"user-{username}-"):
        return True
    
    # Shared/public buckets (no user prefix)
    if not bucket_name.startswith("user-"):
        return True
    
    # Admin can access all buckets
    from app.services.iam_service import iam_service
    user = await iam_service.get_user(username)
    if user and "AdminPolicy" in user.policies:
        return True
    
    # Check explicit bucket permissions via IAM
    has_permission = await iam_service.evaluate_permissions(
        username, "s3:ListBucket", f"arn:aws:s3:::{bucket_name}"
    )
    return has_permission

def _get_bucket_owner(bucket_name: str) -> str:
    """Extract bucket owner from bucket name."""
    if bucket_name.startswith("user-"):
        parts = bucket_name.split("-")
        if len(parts) >= 2:
            return parts[1]
    return "system"

async def _get_user_bucket_access_level(username: str, bucket_name: str) -> str:
    """Get user's access level for the bucket."""
    # Owner has full access
    if bucket_name.startswith(f"user-{username}-"):
        return "owner"
    
    # Admin has full access
    from app.services.iam_service import iam_service
    user = await iam_service.get_user(username)
    if user and "AdminPolicy" in user.policies:
        return "admin"
    
    # Check specific permissions
    can_write = await iam_service.evaluate_permissions(
        username, "s3:PutObject", f"arn:aws:s3:::{bucket_name}/*"
    )
    
    if can_write:
        return "read-write"
    else:
        return "read-only"


@router.delete("/{bucket_name}")
async def delete_bucket(bucket_name: str, force: bool = False):
    """Delete a bucket.
    
    Args:
        bucket_name: Name of the bucket to delete
        force: If True, delete the bucket even if it's not empty
    """
    try:
        if not minio_client.client.bucket_exists(bucket_name):
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Bucket '{bucket_name}' not found",
            )
            
        if force:
            # Remove all objects in the bucket first
            objects = minio_client.client.list_objects(bucket_name, recursive=True)
            for obj in objects:
                minio_client.client.remove_object(bucket_name, obj.object_name)
        
        minio_client.client.remove_bucket(bucket_name)
        return {"message": f"Bucket '{bucket_name}' deleted successfully"}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error deleting bucket: {str(e)}",
        )

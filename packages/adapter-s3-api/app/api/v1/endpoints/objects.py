"""API endpoints for object operations."""

import os
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

from app.services.minio_client import minio_client

router = APIRouter(prefix="/objects", tags=["objects"])


class ObjectInfo(BaseModel):
    """Object information model."""
    name: str
    size: int
    last_modified: str
    content_type: Optional[str] = None


class PutTextRequest(BaseModel):
    """Request body for putting a text object."""
    key: str
    content: str
    content_type: str = "text/plain; charset=utf-8"


@router.post("/put/{bucket_name}")
async def put_text_object(bucket_name: str, body: PutTextRequest):
    """Put a text object directly into a bucket (no file upload needed).

    Args:
        bucket_name: Name of the bucket
        body: key, content, and optional content_type
    """
    try:
        if not minio_client.client.bucket_exists(bucket_name):
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Bucket '{bucket_name}' not found",
            )
        from io import BytesIO
        data = body.content.encode("utf-8")
        minio_client.client.put_object(
            bucket_name=bucket_name,
            object_name=body.key,
            data=BytesIO(data),
            length=len(data),
            content_type=body.content_type,
        )
        return {"message": f"Object '{body.key}' written to '{bucket_name}'", "size": len(data)}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error putting object: {str(e)}",
        )


@router.post("/upload/{bucket_name}")
async def upload_file(
    bucket_name: str,
    file: UploadFile = File(...),
    object_name: Optional[str] = None,
):
    """Upload a file to a bucket.
    
    Args:
        bucket_name: Name of the bucket to upload to
        file: The file to upload
        object_name: Optional custom object name (defaults to the original filename)
    """
    try:
        if not minio_client.client.bucket_exists(bucket_name):
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Bucket '{bucket_name}' not found",
            )
            
        # Use the original filename if no custom name is provided
        obj_name = object_name or file.filename
        
        # Save the uploaded file temporarily
        temp_path = f"/tmp/{file.filename}"
        with open(temp_path, "wb") as f:
            f.write(await file.read())
        
        # Upload to MinIO
        minio_client.client.fput_object(
            bucket_name=bucket_name,
            object_name=obj_name,
            file_path=temp_path,
            content_type=file.content_type,
        )
        
        # Clean up the temporary file
        os.remove(temp_path)
        
        return {"message": f"File '{obj_name}' uploaded successfully to bucket '{bucket_name}'"}
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error uploading file: {str(e)}",
        )


@router.get("/list/{bucket_name}")
async def list_objects(
    bucket_name: str,
    prefix: str = "",
    recursive: bool = False,
):
    """List objects in a bucket.
    
    Args:
        bucket_name: Name of the bucket
        prefix: Filter objects with this prefix
        recursive: If True, list objects recursively
    """
    try:
        if not minio_client.client.bucket_exists(bucket_name):
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Bucket '{bucket_name}' not found",
            )
            
        objects = minio_client.client.list_objects(
            bucket_name,
            prefix=prefix,
            recursive=recursive,
        )
        
        return [
            {
                "name": obj.object_name,
                "size": obj.size or 0,
                "last_modified": obj.last_modified.isoformat() if obj.last_modified else None,
                "content_type": getattr(obj, "content_type", None),
            }
            for obj in objects
        ]
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error listing objects: {str(e)}",
        )


@router.get("/download/{bucket_name}")
async def download_file(
    bucket_name: str,
    object_name: str,
):
    """Download a file from a bucket.
    
    Args:
        bucket_name: Name of the bucket
        object_name: Name of the object to download
    """
    try:
        if not minio_client.client.bucket_exists(bucket_name):
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Bucket '{bucket_name}' not found",
            )
            
        # Get object info
        try:
            obj = minio_client.client.stat_object(bucket_name, object_name)
        except Exception as e:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Object '{object_name}' not found in bucket '{bucket_name}'",
            )
        
        response = minio_client.client.get_object(bucket_name, object_name)
        try:
            data = response.read()
        finally:
            response.close()
            response.release_conn()

        from fastapi.responses import Response as FastAPIResponse
        return FastAPIResponse(
            content=data,
            media_type=obj.content_type or "application/octet-stream",
            headers={"Content-Disposition": f"attachment; filename={Path(object_name).name}"},
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error downloading file: {str(e)}",
        )


@router.delete("/{bucket_name}")
async def delete_object(
    bucket_name: str,
    object_name: str,
):
    """Delete an object from a bucket.
    
    Args:
        bucket_name: Name of the bucket
        object_name: Name of the object to delete
    """
    try:
        if not minio_client.client.bucket_exists(bucket_name):
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Bucket '{bucket_name}' not found",
            )
            
        minio_client.client.remove_object(bucket_name, object_name)
        
        return {"message": f"Object '{object_name}' deleted successfully from bucket '{bucket_name}'"}
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error deleting object: {str(e)}",
        )


@router.get("/presigned-url/{bucket_name}")
async def get_presigned_url(
    bucket_name: str,
    object_name: str,
    expires_in: int = 3600,
):
    """Generate a presigned URL for an object.
    
    Args:
        bucket_name: Name of the bucket
        object_name: Name of the object
        expires_in: Expiration time in seconds (default: 1 hour)
    """
    try:
        if not minio_client.client.bucket_exists(bucket_name):
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Bucket '{bucket_name}' not found",
            )
            
        url = minio_client.client.presigned_get_object(
            bucket_name=bucket_name,
            object_name=object_name,
            expires_in=expires_in,
        )
        
        return {"url": url}
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error generating presigned URL: {str(e)}",
        )

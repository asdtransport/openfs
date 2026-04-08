"""API endpoints for file operations with MinIO."""

import os
from typing import List, Optional
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from fastapi.responses import JSONResponse, StreamingResponse

from app.services.minio_client import minio_client
from app.schemas.file import FileInfo, FileUploadResponse

router = APIRouter()

@router.get("/buckets/{bucket_name}/files", response_model=List[FileInfo])
async def list_files(
    bucket_name: str,
    prefix: str = ""
) -> List[dict]:
    """List all files in a bucket with optional prefix filtering.
    
    Args:
        bucket_name: Name of the bucket
        prefix: Filter objects with this prefix
        
    Returns:
        List of file information
    """
    try:
        files = await minio_client.list_objects(bucket_name, prefix)
        return files
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error listing files: {str(e)}"
        )

@router.post("/buckets/{bucket_name}/upload", response_model=FileUploadResponse)
async def upload_file(
    bucket_name: str,
    file: UploadFile = File(...),
    path: str = ""
) -> dict:
    """Upload a file to MinIO.
    
    Args:
        bucket_name: Name of the bucket
        file: File to upload
        path: Optional path within the bucket
        
    Returns:
        Upload result with file information
    """
    try:
        # Save the uploaded file temporarily
        temp_file = f"/tmp/{file.filename}"
        file_content = await file.read()
        file_size = len(file_content)
        
        with open(temp_file, "wb") as buffer:
            buffer.write(file_content)
        
        # Determine the object name
        object_name = f"{path}/{file.filename}" if path else file.filename
        
        # Upload to MinIO
        success = await minio_client.upload_file(
            bucket_name=bucket_name,
            object_name=object_name,
            file_path=temp_file,
            content_type=file.content_type or "application/octet-stream"
        )
        
        # Clean up temp file
        os.remove(temp_file)
        
        if not success:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to upload file to MinIO"
            )
            
        return {
            "status": "success",
            "bucket": bucket_name,
            "object_name": object_name,
            "file_name": file.filename,
            "size": file_size
        }
        
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error uploading file: {str(e)}"
        )

@router.get("/buckets/{bucket_name}/download/{object_name}")
async def download_file(
    bucket_name: str,
    object_name: str
):
    """Download a file from MinIO.
    
    Args:
        bucket_name: Name of the bucket
        object_name: Name of the object to download
        
    Returns:
        File download response
    """
    try:
        # Create a temporary file path
        temp_file = f"/tmp/{os.path.basename(object_name)}"
        
        # Download the file
        success = await minio_client.download_file(
            bucket_name=bucket_name,
            object_name=object_name,
            file_path=temp_file
        )
        
        if not success:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"File {object_name} not found in bucket {bucket_name}"
            )
        
        # Stream the file back to the client
        def iterfile():
            with open(temp_file, mode="rb") as file_like:
                yield from file_like
            
            # Clean up the temp file after streaming
            os.remove(temp_file)
        
        return StreamingResponse(
            iterfile(),
            media_type="application/octet-stream",
            headers={
                "Content-Disposition": f"attachment; filename={os.path.basename(object_name)}"
            }
        )
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error downloading file: {str(e)}"
        )

@router.delete("/buckets/{bucket_name}/files/{object_name}")
async def delete_file(
    bucket_name: str,
    object_name: str
) -> dict:
    """Delete a file from MinIO.
    
    Args:
        bucket_name: Name of the bucket
        object_name: Name of the object to delete
        
    Returns:
        Deletion result
    """
    try:
        success = await minio_client.delete_object(bucket_name, object_name)
        
        if not success:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"File {object_name} not found in bucket {bucket_name}"
            )
            
        return {
            "status": "success",
            "message": f"Successfully deleted {object_name} from {bucket_name}"
        }
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error deleting file: {str(e)}"
        )

@router.get("/buckets/{bucket_name}/presigned-url/{object_name}")
async def get_presigned_url(
    bucket_name: str,
    object_name: str,
    expires_seconds: int = 3600
) -> dict:
    """Generate a presigned URL for a file.
    
    Args:
        bucket_name: Name of the bucket
        object_name: Name of the object
        expires_seconds: Expiration time in seconds (default: 1 hour)
        
    Returns:
        Presigned URL information
    """
    try:
        url = await minio_client.get_presigned_url(
            bucket_name=bucket_name,
            object_name=object_name,
            expires_seconds=expires_seconds
        )
        
        if not url:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"File {object_name} not found in bucket {bucket_name}"
            )
            
        return {
            "status": "success",
            "url": url,
            "expires_in_seconds": expires_seconds
        }
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error generating presigned URL: {str(e)}"
        )

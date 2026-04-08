"""Pydantic models for file operations."""

from datetime import datetime
from typing import List, Optional
from pydantic import BaseModel, Field

class FileInfo(BaseModel):
    """File information model."""
    name: str = Field(..., description="Name of the file/object")
    size: int = Field(..., description="Size of the file in bytes")
    last_modified: str = Field(..., description="Last modified timestamp")
    etag: str = Field(..., description="ETag of the object")

class FileUploadResponse(BaseModel):
    """Response model for file uploads."""
    status: str = Field(..., description="Upload status")
    bucket: str = Field(..., description="Target bucket name")
    object_name: str = Field(..., description="Full object path in the bucket")
    file_name: str = Field(..., description="Original file name")
    size: int = Field(..., description="File size in bytes")

class FileDownloadResponse(BaseModel):
    """Response model for file downloads."""
    status: str = Field(..., description="Download status")
    url: Optional[str] = Field(None, description="Download URL if available")
    expires_in_seconds: Optional[int] = Field(None, description="URL expiration time in seconds")

class FileDeleteResponse(BaseModel):
    """Response model for file deletions."""
    status: str = Field(..., description="Deletion status")
    message: str = Field(..., description="Status message")

class PresignedUrlResponse(BaseModel):
    """Response model for presigned URLs."""
    status: str = Field(..., description="Status of the operation")
    url: str = Field(..., description="Presigned URL for the object")
    expires_in_seconds: int = Field(..., description="URL expiration time in seconds")

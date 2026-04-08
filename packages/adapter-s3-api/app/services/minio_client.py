"""MinIO client service for S3 operations."""

import os
from typing import BinaryIO, List, Optional
from urllib.parse import urlparse

from minio import Minio
from minio.error import S3Error
from loguru import logger

from app.core.config import settings

class MinioClient:
    """MinIO client wrapper for S3 operations."""
    
    def __init__(self):
        """Initialize MinIO client with configuration."""
        self.client = Minio(
            endpoint=settings.MINIO_ENDPOINT,
            access_key=settings.MINIO_ACCESS_KEY,
            secret_key=settings.MINIO_SECRET_KEY,
            secure=settings.MINIO_SECURE,
            region=settings.MINIO_REGION
        )
    
    async def bucket_exists(self, bucket_name: str) -> bool:
        """Check if a bucket exists.
        
        Args:
            bucket_name: Name of the bucket to check
            
        Returns:
            bool: True if bucket exists, False otherwise
        """
        try:
            return self.client.bucket_exists(bucket_name)
        except S3Error as e:
            logger.error(f"Error checking if bucket {bucket_name} exists: {e}")
            return False
    
    async def create_bucket(self, bucket_name: str) -> bool:
        """Create a new bucket.
        
        Args:
            bucket_name: Name of the bucket to create
            
        Returns:
            bool: True if bucket was created, False otherwise
        """
        try:
            if not await self.bucket_exists(bucket_name):
                self.client.make_bucket(bucket_name)
                logger.info(f"Created bucket: {bucket_name}")
            return True
        except S3Error as e:
            logger.error(f"Error creating bucket {bucket_name}: {e}")
            return False
    
    async def list_buckets(self) -> List[dict]:
        """List all buckets.
        
        Returns:
            List[dict]: List of bucket information
        """
        try:
            buckets = self.client.list_buckets()
            return [
                {
                    "name": bucket.name,
                    "creation_date": bucket.creation_date.isoformat() if bucket.creation_date else None
                }
                for bucket in buckets
            ]
        except S3Error as e:
            logger.error(f"Error listing buckets: {e}")
            return []
    
    async def upload_file(
        self,
        bucket_name: str,
        object_name: str,
        file_path: str,
        content_type: str = "application/octet-stream"
    ) -> bool:
        """Upload a file to MinIO.
        
        Args:
            bucket_name: Name of the bucket
            object_name: Name of the object in the bucket
            file_path: Path to the local file to upload
            content_type: MIME type of the file
            
        Returns:
            bool: True if upload was successful, False otherwise
        """
        try:
            await self.create_bucket(bucket_name)
            self.client.fput_object(
                bucket_name=bucket_name,
                object_name=object_name,
                file_path=file_path,
                content_type=content_type
            )
            logger.info(f"Uploaded {file_path} to {bucket_name}/{object_name}")
            return True
        except Exception as e:
            logger.error(f"Error uploading file {file_path}: {e}")
            return False
    
    async def download_file(
        self,
        bucket_name: str,
        object_name: str,
        file_path: str
    ) -> bool:
        """Download a file from MinIO.
        
        Args:
            bucket_name: Name of the bucket
            object_name: Name of the object to download
            file_path: Local path to save the downloaded file
            
        Returns:
            bool: True if download was successful, False otherwise
        """
        try:
            os.makedirs(os.path.dirname(file_path), exist_ok=True)
            self.client.fget_object(
                bucket_name=bucket_name,
                object_name=object_name,
                file_path=file_path
            )
            logger.info(f"Downloaded {bucket_name}/{object_name} to {file_path}")
            return True
        except Exception as e:
            logger.error(f"Error downloading {bucket_name}/{object_name}: {e}")
            return False
    
    async def list_objects(
        self,
        bucket_name: str,
        prefix: str = ""
    ) -> List[dict]:
        """List objects in a bucket.
        
        Args:
            bucket_name: Name of the bucket
            prefix: Filter objects with this prefix
            
        Returns:
            List[dict]: List of objects with metadata
        """
        try:
            objects = self.client.list_objects(
                bucket_name=bucket_name,
                prefix=prefix,
                recursive=True
            )
            return [
                {
                    "name": obj.object_name,
                    "size": obj.size,
                    "last_modified": obj.last_modified.isoformat(),
                    "etag": obj.etag
                }
                for obj in objects
            ]
        except Exception as e:
            logger.error(f"Error listing objects in {bucket_name}: {e}")
            return []
    
    async def delete_object(
        self,
        bucket_name: str,
        object_name: str
    ) -> bool:
        """Delete an object from a bucket.
        
        Args:
            bucket_name: Name of the bucket
            object_name: Name of the object to delete
            
        Returns:
            bool: True if deletion was successful, False otherwise
        """
        try:
            self.client.remove_object(bucket_name, object_name)
            logger.info(f"Deleted {bucket_name}/{object_name}")
            return True
        except Exception as e:
            logger.error(f"Error deleting {bucket_name}/{object_name}: {e}")
            return False
    
    async def get_presigned_url(
        self,
        bucket_name: str,
        object_name: str,
        expires_seconds: int = 3600
    ) -> Optional[str]:
        """Generate a presigned URL for an object.
        
        Args:
            bucket_name: Name of the bucket
            object_name: Name of the object
            expires_seconds: Expiration time in seconds
            
        Returns:
            Optional[str]: Presigned URL or None if error
        """
        try:
            return self.client.presigned_get_object(
                bucket_name=bucket_name,
                object_name=object_name,
                expires=expires_seconds
            )
        except Exception as e:
            logger.error(f"Error generating presigned URL for {bucket_name}/{object_name}: {e}")
            return None
    
    async def stream_upload(
        self,
        bucket_name: str,
        object_name: str,
        data_stream,
        content_length: int = -1,
        content_type: str = "application/octet-stream"
    ) -> bool:
        """Stream data directly to MinIO without saving to disk.
        
        Args:
            bucket_name: Name of the bucket
            object_name: Name of the object
            data_stream: Stream of data (file-like object)
            content_length: Length of data (-1 for unknown)
            content_type: MIME type of the data
            
        Returns:
            bool: True if upload was successful, False otherwise
        """
        try:
            await self.create_bucket(bucket_name)
            self.client.put_object(
                bucket_name=bucket_name,
                object_name=object_name,
                data=data_stream,
                length=content_length,
                content_type=content_type
            )
            logger.info(f"Streamed data to {bucket_name}/{object_name}")
            return True
        except Exception as e:
            logger.error(f"Error streaming to {bucket_name}/{object_name}: {e}")
            return False
    
    async def stream_upload_chunked(
        self,
        bucket_name: str,
        object_name: str,
        data_generator,
        content_type: str = "application/octet-stream"
    ) -> bool:
        """Stream data in chunks using put_object with a generator.
        
        Args:
            bucket_name: Name of the bucket
            object_name: Name of the object
            data_generator: Generator yielding data chunks
            content_type: MIME type of the data
            
        Returns:
            bool: True if upload was successful, False otherwise
        """
        try:
            await self.create_bucket(bucket_name)
            
            # Create a file-like object from the generator
            class GeneratorStream:
                def __init__(self, generator):
                    self.generator = generator
                    self._buffer = b''
                    self._finished = False
                
                def read(self, size=-1):
                    if self._finished:
                        return b''
                    
                    try:
                        if size == -1:
                            # Read all remaining data
                            result = self._buffer
                            for chunk in self.generator:
                                result += chunk
                            self._finished = True
                            self._buffer = b''
                            return result
                        else:
                            # Read specific amount
                            while len(self._buffer) < size and not self._finished:
                                try:
                                    chunk = next(self.generator)
                                    self._buffer += chunk
                                except StopIteration:
                                    self._finished = True
                                    break
                            
                            result = self._buffer[:size]
                            self._buffer = self._buffer[size:]
                            return result
                    except Exception:
                        self._finished = True
                        return b''
            
            stream = GeneratorStream(data_generator)
            
            # Collect all data first to get the total length
            all_data = b''
            for chunk in data_generator:
                all_data += chunk
            
            from io import BytesIO
            data_stream = BytesIO(all_data)
            
            self.client.put_object(
                bucket_name=bucket_name,
                object_name=object_name,
                data=data_stream,
                length=len(all_data),  # Provide exact length
                content_type=content_type
            )
            
            logger.info(f"Streamed chunked data to {bucket_name}/{object_name}")
            return True
        except Exception as e:
            logger.error(f"Error streaming chunked data to {bucket_name}/{object_name}: {e}")
            return False

# Create a singleton instance
minio_client = MinioClient()

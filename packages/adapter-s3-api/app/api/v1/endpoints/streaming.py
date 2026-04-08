"""API endpoints for streaming operations."""

import asyncio
from io import BytesIO
from typing import Dict, Optional

from fastapi import APIRouter, HTTPException, Request, status, BackgroundTasks
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.services.minio_client import minio_client
from loguru import logger

router = APIRouter(prefix="/stream", tags=["streaming"])

# Store active streaming sessions
active_streams: Dict[str, dict] = {}

class StreamSession(BaseModel):
    """Streaming session model."""
    bucket_name: str
    object_name: str
    content_type: str = "application/octet-stream"
    chunk_size: int = 5 * 1024 * 1024  # 5MB chunks

class StreamResponse(BaseModel):
    """Streaming response model."""
    session_id: str
    status: str
    message: str
    upload_id: Optional[str] = None

@router.post("/start", response_model=StreamResponse)
async def start_streaming_upload(session: StreamSession):
    """Start a continuous streaming upload session.
    
    Args:
        session: Streaming session configuration
        
    Returns:
        StreamResponse: Session details with session ID
    """
    try:
        # Generate unique session ID
        import uuid
        session_id = str(uuid.uuid4())
        
        # Store session info (no need for upload_id with direct streaming)
        active_streams[session_id] = {
            "bucket_name": session.bucket_name,
            "object_name": session.object_name,
            "content_type": session.content_type,
            "chunk_size": session.chunk_size,
            "chunks": [],  # Store chunks temporarily
            "active": True
        }
        
        logger.info(f"Started streaming session {session_id} for {session.bucket_name}/{session.object_name}")
        
        return StreamResponse(
            session_id=session_id,
            status="started",
            message="Streaming session started successfully",
            upload_id=session_id  # Use session_id as identifier
        )
        
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error starting streaming session: {str(e)}"
        )

@router.post("/chunk/{session_id}")
async def upload_stream_chunk(session_id: str, request: Request):
    """Upload a chunk of data to an active streaming session.
    
    Args:
        session_id: Active streaming session ID
        request: Request containing chunk data
        
    Returns:
        dict: Upload result
    """
    if session_id not in active_streams:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Streaming session {session_id} not found"
        )
    
    session_info = active_streams[session_id]
    
    if not session_info["active"]:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Streaming session {session_id} is not active"
        )
    
    try:
        # Read chunk data from request body
        chunk_data = await request.body()
        
        if not chunk_data:
            return {"status": "skipped", "message": "Empty chunk received"}
        
        # Store chunk data temporarily
        session_info["chunks"].append(chunk_data)
        chunk_number = len(session_info["chunks"])
        
        logger.info(f"Received chunk {chunk_number} for session {session_id} ({len(chunk_data)} bytes)")
        
        return {
            "status": "success",
            "chunk_number": chunk_number,
            "chunk_size": len(chunk_data),
            "total_chunks": len(session_info["chunks"])
        }
        
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error uploading chunk: {str(e)}"
        )

@router.post("/complete/{session_id}")
async def complete_streaming_upload(session_id: str):
    """Complete a streaming upload session.
    
    Args:
        session_id: Active streaming session ID
        
    Returns:
        dict: Completion result
    """
    if session_id not in active_streams:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Streaming session {session_id} not found"
        )
    
    session_info = active_streams[session_id]
    
    try:
        # Create a generator from stored chunks
        def chunk_generator():
            for chunk in session_info["chunks"]:
                yield chunk
        
        # Upload all chunks as a stream
        success = await minio_client.stream_upload_chunked(
            bucket_name=session_info["bucket_name"],
            object_name=session_info["object_name"],
            data_generator=chunk_generator(),
            content_type=session_info["content_type"]
        )
        
        if not success:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to complete streaming upload"
            )
        
        # Calculate total size
        total_size = sum(len(chunk) for chunk in session_info["chunks"])
        
        # Mark session as completed and clean up
        session_info["active"] = False
        session_info["chunks"].clear()  # Free memory
        
        logger.info(f"Completed streaming session {session_id}")
        
        return {
            "status": "completed",
            "message": f"Successfully uploaded {session_info['object_name']}",
            "total_chunks": len(session_info["chunks"]) if "chunks" in session_info else 0,
            "total_size": total_size,
            "bucket_name": session_info["bucket_name"],
            "object_name": session_info["object_name"]
        }
        
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error completing streaming upload: {str(e)}"
        )

@router.post("/direct/{bucket_name}/{object_name}")
async def direct_stream_upload(
    bucket_name: str,
    object_name: str,
    request: Request,
    content_type: str = "application/octet-stream"
):
    """Direct streaming upload without multipart (for smaller streams).
    
    Args:
        bucket_name: Target bucket name
        object_name: Target object name
        request: Request containing stream data
        content_type: MIME type of the content
        
    Returns:
        dict: Upload result
    """
    try:
        # Get content length if available
        content_length = int(request.headers.get("content-length", -1))
        
        # Create a stream from request body
        async def stream_generator():
            async for chunk in request.stream():
                yield chunk
        
        # Convert async generator to file-like object
        stream_data = BytesIO()
        async for chunk in stream_generator():
            stream_data.write(chunk)
        stream_data.seek(0)
        
        # Upload stream
        success = await minio_client.stream_upload(
            bucket_name=bucket_name,
            object_name=object_name,
            data_stream=stream_data,
            content_length=content_length,
            content_type=content_type
        )
        
        if not success:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to upload stream"
            )
        
        return {
            "status": "success",
            "message": f"Successfully streamed to {bucket_name}/{object_name}",
            "bucket_name": bucket_name,
            "object_name": object_name,
            "content_length": content_length
        }
        
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error during direct stream upload: {str(e)}"
        )

@router.get("/sessions")
async def list_active_sessions():
    """List all active streaming sessions.
    
    Returns:
        dict: Active sessions information
    """
    active_sessions = {
        session_id: {
            "bucket_name": info["bucket_name"],
            "object_name": info["object_name"],
            "active": info["active"],
            "parts_uploaded": len(info["parts"]),
            "next_part": info["part_number"]
        }
        for session_id, info in active_streams.items()
        if info["active"]
    }
    
    return {
        "active_sessions": len(active_sessions),
        "sessions": active_sessions
    }

@router.delete("/session/{session_id}")
async def cancel_streaming_session(session_id: str):
    """Cancel an active streaming session.
    
    Args:
        session_id: Session ID to cancel
        
    Returns:
        dict: Cancellation result
    """
    if session_id not in active_streams:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Streaming session {session_id} not found"
        )
    
    session_info = active_streams[session_id]
    session_info["active"] = False
    
    # Note: In production, you might want to abort the multipart upload
    # to clean up any uploaded parts
    
    logger.info(f"Cancelled streaming session {session_id}")
    
    return {
        "status": "cancelled",
        "message": f"Streaming session {session_id} cancelled",
        "session_id": session_id
    }

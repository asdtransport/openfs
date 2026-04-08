"""Bucket replication API endpoints."""

from typing import List, Optional
from fastapi import APIRouter, HTTPException, Query, status

from app.schemas.replication import (
    CreateReplicationConfigRequest, ReplicationConfigResponse, ReplicationStatus,
    ReplicationJob, ReplicationReport, ReplicationHealthCheck, StartReplicationJobRequest
)
from app.services.replication_service import replication_service
from loguru import logger

router = APIRouter(prefix="/replication", tags=["replication"])

@router.post("/configurations", response_model=ReplicationConfigResponse)
async def create_replication_configuration(request: CreateReplicationConfigRequest):
    """Create replication configuration for a bucket.
    
    Args:
        request: Replication configuration request
        
    Returns:
        ReplicationConfigResponse: Created replication configuration
    """
    try:
        response = await replication_service.create_replication_configuration(request)
        return response
        
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    except Exception as e:
        logger.error(f"Error creating replication configuration: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error creating replication configuration"
        )

@router.get("/configurations/{bucket_name}", response_model=ReplicationConfigResponse)
async def get_replication_configuration(bucket_name: str):
    """Get replication configuration for a bucket.
    
    Args:
        bucket_name: Bucket name
        
    Returns:
        ReplicationConfigResponse: Replication configuration
    """
    try:
        config = await replication_service.get_replication_configuration(bucket_name)
        if not config:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"No replication configuration found for bucket {bucket_name}"
            )
        
        return config
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting replication configuration: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error retrieving replication configuration"
        )

@router.get("/configurations")
async def list_replication_configurations():
    """List all replication configurations.
    
    Returns:
        dict: All replication configurations
    """
    try:
        configurations = {}
        for bucket_name in replication_service.configurations.keys():
            config = await replication_service.get_replication_configuration(bucket_name)
            if config:
                configurations[bucket_name] = config
        
        return {
            "configurations": configurations,
            "total_count": len(configurations)
        }
        
    except Exception as e:
        logger.error(f"Error listing replication configurations: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error listing replication configurations"
        )

@router.delete("/configurations/{bucket_name}")
async def delete_replication_configuration(bucket_name: str):
    """Delete replication configuration for a bucket.
    
    Args:
        bucket_name: Bucket name
        
    Returns:
        dict: Deletion confirmation
    """
    try:
        success = await replication_service.delete_replication_configuration(bucket_name)
        if not success:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"No replication configuration found for bucket {bucket_name}"
            )
        
        return {
            "message": f"Replication configuration deleted for bucket {bucket_name}",
            "bucket_name": bucket_name
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting replication configuration: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error deleting replication configuration"
        )

@router.post("/jobs/trigger")
async def trigger_replication_job(request: StartReplicationJobRequest):
    """Trigger replication for a specific object.
    
    Args:
        request: Replication job request
        
    Returns:
        dict: Triggered replication jobs
    """
    try:
        job_ids = await replication_service.trigger_object_replication(
            request.source_bucket,
            request.object_key,
            request.rule_id
        )
        
        return {
            "message": f"Replication triggered for {request.source_bucket}/{request.object_key}",
            "job_ids": job_ids,
            "jobs_created": len(job_ids)
        }
        
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    except Exception as e:
        logger.error(f"Error triggering replication job: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error triggering replication job"
        )

@router.get("/jobs", response_model=List[ReplicationJob])
async def list_replication_jobs(
    bucket_name: Optional[str] = Query(None, description="Filter by bucket name"),
    limit: int = Query(100, ge=1, le=1000, description="Maximum number of jobs")
):
    """List replication jobs.
    
    Args:
        bucket_name: Filter by bucket name
        limit: Maximum number of jobs
        
    Returns:
        List[ReplicationJob]: Replication jobs
    """
    try:
        jobs = await replication_service.get_replication_jobs(bucket_name, limit)
        return jobs
        
    except Exception as e:
        logger.error(f"Error listing replication jobs: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error listing replication jobs"
        )

@router.get("/jobs/{job_id}", response_model=ReplicationJob)
async def get_replication_job(job_id: str):
    """Get replication job by ID.
    
    Args:
        job_id: Job ID
        
    Returns:
        ReplicationJob: Replication job details
    """
    try:
        job = replication_service.replication_jobs.get(job_id)
        if not job:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Replication job {job_id} not found"
            )
        
        return job
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting replication job: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error retrieving replication job"
        )

@router.get("/status/{bucket_name}", response_model=ReplicationStatus)
async def get_replication_status(bucket_name: str):
    """Get replication status for a bucket.
    
    Args:
        bucket_name: Bucket name
        
    Returns:
        ReplicationStatus: Replication status
    """
    try:
        status_info = await replication_service.get_replication_status(bucket_name)
        if not status_info:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"No replication status found for bucket {bucket_name}"
            )
        
        return status_info
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting replication status: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error retrieving replication status"
        )

@router.get("/health", response_model=ReplicationHealthCheck)
async def get_replication_health():
    """Get replication system health.
    
    Returns:
        ReplicationHealthCheck: Replication health status
    """
    try:
        health = await replication_service.get_replication_health()
        return health
        
    except Exception as e:
        logger.error(f"Error getting replication health: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error retrieving replication health"
        )

@router.get("/reports/{bucket_name}", response_model=ReplicationReport)
async def get_replication_report(
    bucket_name: str,
    days: int = Query(7, ge=1, le=30, description="Number of days for report")
):
    """Generate replication report for a bucket.
    
    Args:
        bucket_name: Bucket name
        days: Number of days for report
        
    Returns:
        ReplicationReport: Replication report
    """
    try:
        report = await replication_service.generate_replication_report(bucket_name, days)
        return report
        
    except Exception as e:
        logger.error(f"Error generating replication report: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error generating replication report"
        )

@router.get("/summary")
async def get_replication_summary():
    """Get replication system summary.
    
    Returns:
        dict: Replication system summary
    """
    try:
        total_configs = len(replication_service.configurations)
        total_jobs = len(replication_service.replication_jobs)
        
        # Count jobs by status
        job_status_counts = {}
        for job in replication_service.replication_jobs.values():
            status = job.status
            job_status_counts[status] = job_status_counts.get(status, 0) + 1
        
        # Get active buckets with replication
        active_buckets = list(replication_service.configurations.keys())
        
        # Calculate total bytes replicated
        total_bytes_replicated = sum(
            job.bytes_replicated for job in replication_service.replication_jobs.values()
            if job.status == "completed"
        )
        
        return {
            "total_configurations": total_configs,
            "total_jobs": total_jobs,
            "job_status_counts": job_status_counts,
            "active_buckets": active_buckets,
            "total_bytes_replicated": total_bytes_replicated,
            "replication_enabled_buckets": len(active_buckets)
        }
        
    except Exception as e:
        logger.error(f"Error getting replication summary: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error retrieving replication summary"
        )

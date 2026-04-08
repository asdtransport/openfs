"""API endpoints for health checks and monitoring."""

import asyncio
import time
from datetime import datetime, timezone
from typing import Dict, List, Optional

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel

from app.services.minio_client import minio_client
from app.core.config import settings
from loguru import logger

router = APIRouter(prefix="/monitoring", tags=["monitoring"])

class HealthStatus(BaseModel):
    """Health status model."""
    status: str
    timestamp: str
    response_time_ms: float
    details: Optional[Dict] = None

class ClusterHealth(BaseModel):
    """Cluster health model."""
    status: str
    timestamp: str
    minio_liveness: HealthStatus
    minio_cluster_write: HealthStatus
    minio_cluster_read: HealthStatus
    api_health: HealthStatus
    overall_status: str

class ServiceMetrics(BaseModel):
    """Service metrics model."""
    uptime_seconds: float
    total_requests: int
    active_streaming_sessions: int
    bucket_count: int
    total_objects: int
    total_size_bytes: int
    last_sync_operations: List[Dict]

# Global metrics tracking
service_start_time = time.time()
request_counter = 0
sync_operations_history = []

@router.get("/health", response_model=HealthStatus)
async def api_health_check():
    """Basic API health check endpoint.
    
    Returns:
        HealthStatus: Current API health status
    """
    global request_counter
    request_counter += 1
    
    start_time = time.time()
    
    try:
        # Test basic MinIO connectivity
        await minio_client.bucket_exists("health-check-test")
        
        response_time = (time.time() - start_time) * 1000
        
        return HealthStatus(
            status="healthy",
            timestamp=datetime.now(timezone.utc).isoformat(),
            response_time_ms=round(response_time, 2),
            details={
                "service": "MinIO Sync API",
                "version": "0.1.0",
                "minio_endpoint": settings.MINIO_ENDPOINT
            }
        )
        
    except Exception as e:
        response_time = (time.time() - start_time) * 1000
        logger.error(f"Health check failed: {e}")
        
        return HealthStatus(
            status="unhealthy",
            timestamp=datetime.now(timezone.utc).isoformat(),
            response_time_ms=round(response_time, 2),
            details={
                "error": str(e),
                "service": "MinIO Sync API"
            }
        )

@router.get("/health/minio/live")
async def minio_liveness_check():
    """MinIO liveness probe - checks if MinIO server is up and ready.
    
    Equivalent to: curl -I http://minio:9000/minio/health/live
    
    Returns:
        HealthStatus: MinIO liveness status
    """
    start_time = time.time()
    
    try:
        # Use MinIO client to test basic connectivity
        await minio_client.bucket_exists("liveness-test")
        
        response_time = (time.time() - start_time) * 1000
        
        return HealthStatus(
            status="healthy",
            timestamp=datetime.now(timezone.utc).isoformat(),
            response_time_ms=round(response_time, 2),
            details={
                "check_type": "liveness",
                "minio_endpoint": settings.MINIO_ENDPOINT,
                "message": "MinIO server is up and ready"
            }
        )
        
    except Exception as e:
        response_time = (time.time() - start_time) * 1000
        logger.error(f"MinIO liveness check failed: {e}")
        
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"MinIO server unavailable: {str(e)}"
        )

@router.get("/health/minio/cluster")
async def minio_cluster_write_check():
    """MinIO cluster write quorum check.
    
    Equivalent to: curl -I http://minio:9000/minio/health/cluster
    
    Returns:
        HealthStatus: MinIO cluster write quorum status
    """
    start_time = time.time()
    
    try:
        # Test write capability by attempting to create a test bucket
        test_bucket = f"write-quorum-test-{int(time.time())}"
        await minio_client.create_bucket(test_bucket)
        
        # Clean up test bucket
        try:
            minio_client.client.remove_bucket(test_bucket)
        except:
            pass  # Ignore cleanup errors
        
        response_time = (time.time() - start_time) * 1000
        
        return HealthStatus(
            status="healthy",
            timestamp=datetime.now(timezone.utc).isoformat(),
            response_time_ms=round(response_time, 2),
            details={
                "check_type": "cluster_write_quorum",
                "message": "Cluster has sufficient write quorum"
            }
        )
        
    except Exception as e:
        response_time = (time.time() - start_time) * 1000
        logger.error(f"MinIO cluster write check failed: {e}")
        
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Cluster write quorum unavailable: {str(e)}"
        )

@router.get("/health/minio/cluster/read")
async def minio_cluster_read_check():
    """MinIO cluster read quorum check.
    
    Equivalent to: curl -I http://minio:9000/minio/health/cluster/read
    
    Returns:
        HealthStatus: MinIO cluster read quorum status
    """
    start_time = time.time()
    
    try:
        # Test read capability by listing buckets
        buckets = minio_client.client.list_buckets()
        bucket_count = len(buckets)
        
        response_time = (time.time() - start_time) * 1000
        
        return HealthStatus(
            status="healthy",
            timestamp=datetime.now(timezone.utc).isoformat(),
            response_time_ms=round(response_time, 2),
            details={
                "check_type": "cluster_read_quorum",
                "bucket_count": bucket_count,
                "message": "Cluster has sufficient read quorum"
            }
        )
        
    except Exception as e:
        response_time = (time.time() - start_time) * 1000
        logger.error(f"MinIO cluster read check failed: {e}")
        
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Cluster read quorum unavailable: {str(e)}"
        )

@router.get("/health/comprehensive", response_model=ClusterHealth)
async def comprehensive_health_check():
    """Comprehensive health check covering all components.
    
    Returns:
        ClusterHealth: Complete system health status
    """
    timestamp = datetime.now(timezone.utc).isoformat()
    
    # Run all health checks concurrently
    try:
        api_health_task = api_health_check()
        minio_live_task = minio_liveness_check()
        minio_write_task = minio_cluster_write_check()
        minio_read_task = minio_cluster_read_check()
        
        # Wait for all checks with timeout
        api_health, minio_live, minio_write, minio_read = await asyncio.gather(
            api_health_task,
            minio_live_task,
            minio_write_task,
            minio_read_task,
            return_exceptions=True
        )
        
        # Convert exceptions to error status
        def to_health_status(result, check_name):
            if isinstance(result, Exception):
                return HealthStatus(
                    status="unhealthy",
                    timestamp=timestamp,
                    response_time_ms=0.0,
                    details={"error": str(result), "check": check_name}
                )
            return result
        
        api_health = to_health_status(api_health, "api")
        minio_live = to_health_status(minio_live, "minio_liveness")
        minio_write = to_health_status(minio_write, "minio_write")
        minio_read = to_health_status(minio_read, "minio_read")
        
        # Determine overall status
        all_healthy = all(
            check.status == "healthy" 
            for check in [api_health, minio_live, minio_write, minio_read]
        )
        
        overall_status = "healthy" if all_healthy else "degraded"
        
        return ClusterHealth(
            status=overall_status,
            timestamp=timestamp,
            minio_liveness=minio_live,
            minio_cluster_write=minio_write,
            minio_cluster_read=minio_read,
            api_health=api_health,
            overall_status=overall_status
        )
        
    except Exception as e:
        logger.error(f"Comprehensive health check failed: {e}")
        
        # Return degraded status with error details
        error_status = HealthStatus(
            status="unhealthy",
            timestamp=timestamp,
            response_time_ms=0.0,
            details={"error": str(e)}
        )
        
        return ClusterHealth(
            status="unhealthy",
            timestamp=timestamp,
            minio_liveness=error_status,
            minio_cluster_write=error_status,
            minio_cluster_read=error_status,
            api_health=error_status,
            overall_status="unhealthy"
        )

@router.get("/metrics", response_model=ServiceMetrics)
async def service_metrics():
    """Get service metrics and statistics.
    
    Returns:
        ServiceMetrics: Current service metrics
    """
    try:
        # Calculate uptime
        uptime = time.time() - service_start_time
        
        # Get active streaming sessions
        from app.api.v1.endpoints.streaming import active_streams
        active_sessions = len([s for s in active_streams.values() if s.get("active", False)])
        
        # Get bucket and object statistics
        buckets = minio_client.client.list_buckets()
        bucket_count = len(buckets)
        
        total_objects = 0
        total_size = 0
        
        for bucket in buckets:
            try:
                objects = await minio_client.list_objects(bucket.name)
                total_objects += len(objects)
                total_size += sum(obj.get("size", 0) for obj in objects)
            except Exception as e:
                logger.warning(f"Could not get stats for bucket {bucket.name}: {e}")
        
        return ServiceMetrics(
            uptime_seconds=round(uptime, 2),
            total_requests=request_counter,
            active_streaming_sessions=active_sessions,
            bucket_count=bucket_count,
            total_objects=total_objects,
            total_size_bytes=total_size,
            last_sync_operations=sync_operations_history[-10:]  # Last 10 operations
        )
        
    except Exception as e:
        logger.error(f"Error getting service metrics: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error retrieving metrics: {str(e)}"
        )

@router.get("/ready")
async def readiness_probe():
    """Kubernetes-style readiness probe.
    
    Returns 200 if service is ready to accept traffic.
    """
    try:
        # Quick connectivity test
        await minio_client.bucket_exists("readiness-test")
        return {"status": "ready", "timestamp": datetime.now(timezone.utc).isoformat()}
    except Exception as e:
        logger.error(f"Readiness probe failed: {e}")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Service not ready"
        )

@router.get("/live")
async def liveness_probe():
    """Kubernetes-style liveness probe.
    
    Returns 200 if service is alive and should not be restarted.
    """
    return {
        "status": "alive",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "uptime_seconds": round(time.time() - service_start_time, 2)
    }

# Utility function to track sync operations
def track_sync_operation(operation_type: str, details: Dict):
    """Track sync operations for metrics."""
    global sync_operations_history
    
    sync_operations_history.append({
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "operation_type": operation_type,
        "details": details
    })
    
    # Keep only last 50 operations
    if len(sync_operations_history) > 50:
        sync_operations_history = sync_operations_history[-50:]

"""API router configuration."""

from fastapi import APIRouter
from app.api.v1.endpoints import files, buckets, objects, sync, streaming, monitoring, dashboard, iam, analytics, search, notifications, replication, lifecycle, security

api_router = APIRouter()

# Include all endpoint routers
api_router.include_router(files.router, prefix="/files", tags=["files"])
api_router.include_router(buckets.router, tags=["buckets"])
api_router.include_router(objects.router, tags=["objects"])
api_router.include_router(sync.router, tags=["sync"])
api_router.include_router(streaming.router, tags=["streaming"])
api_router.include_router(monitoring.router, tags=["monitoring"])
api_router.include_router(dashboard.router, tags=["dashboard"])
api_router.include_router(iam.router, tags=["iam"])
api_router.include_router(analytics.router, tags=["analytics"])
api_router.include_router(search.router, tags=["search"])
api_router.include_router(notifications.router, tags=["notifications"])
api_router.include_router(replication.router, tags=["replication"])
api_router.include_router(lifecycle.router, tags=["lifecycle"])
api_router.include_router(security.router, tags=["security"])

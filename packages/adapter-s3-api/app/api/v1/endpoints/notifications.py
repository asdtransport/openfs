"""Notification and event system API endpoints."""

from typing import List, Optional
from fastapi import APIRouter, HTTPException, Query, status

from app.schemas.notifications import (
    BucketNotificationConfig, NotificationConfiguration, WebhookEndpoint,
    EventSubscription, NotificationStats, EventHistory, EventType,
    NotificationStatus, S3Event
)
from app.services.notification_service import notification_service
from loguru import logger

router = APIRouter(prefix="/notifications", tags=["notifications"])

@router.post("/buckets/{bucket_name}/configuration")
async def create_bucket_notification_config(bucket_name: str, config: BucketNotificationConfig):
    """Create notification configuration for a bucket.
    
    Args:
        bucket_name: Bucket name
        config: Notification configuration
        
    Returns:
        dict: Configuration creation confirmation
    """
    try:
        success = await notification_service.create_bucket_notification_config(bucket_name, config)
        
        if success:
            return {
                "message": f"Notification configuration created for bucket {bucket_name}",
                "bucket_name": bucket_name,
                "configurations_count": len(config.configurations)
            }
        else:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to create notification configuration"
            )
            
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    except Exception as e:
        logger.error(f"Error creating notification configuration: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error creating notification configuration"
        )

@router.get("/buckets/{bucket_name}/configuration", response_model=BucketNotificationConfig)
async def get_bucket_notification_config(bucket_name: str):
    """Get notification configuration for a bucket.
    
    Args:
        bucket_name: Bucket name
        
    Returns:
        BucketNotificationConfig: Notification configuration
    """
    try:
        config = await notification_service.get_bucket_notification_config(bucket_name)
        if not config:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"No notification configuration found for bucket {bucket_name}"
            )
        
        return config
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting notification configuration: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error retrieving notification configuration"
        )

@router.delete("/buckets/{bucket_name}/configuration")
async def delete_bucket_notification_config(bucket_name: str):
    """Delete notification configuration for a bucket.
    
    Args:
        bucket_name: Bucket name
        
    Returns:
        dict: Deletion confirmation
    """
    try:
        success = await notification_service.delete_bucket_notification_config(bucket_name)
        if not success:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"No notification configuration found for bucket {bucket_name}"
            )
        
        return {
            "message": f"Notification configuration deleted for bucket {bucket_name}",
            "bucket_name": bucket_name
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting notification configuration: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error deleting notification configuration"
        )

@router.post("/webhooks", response_model=WebhookEndpoint)
async def create_webhook_endpoint(webhook: WebhookEndpoint):
    """Create a webhook endpoint.
    
    Args:
        webhook: Webhook endpoint configuration
        
    Returns:
        WebhookEndpoint: Created webhook endpoint
    """
    try:
        success = await notification_service.create_webhook_endpoint(webhook)
        
        if success:
            return webhook
        else:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to create webhook endpoint"
            )
            
    except Exception as e:
        logger.error(f"Error creating webhook endpoint: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error creating webhook endpoint"
        )

@router.get("/webhooks", response_model=List[WebhookEndpoint])
async def list_webhook_endpoints():
    """List all webhook endpoints.
    
    Returns:
        List[WebhookEndpoint]: All webhook endpoints
    """
    try:
        webhooks = list(notification_service.webhooks.values())
        return webhooks
        
    except Exception as e:
        logger.error(f"Error listing webhook endpoints: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error listing webhook endpoints"
        )

@router.get("/webhooks/{endpoint_id}", response_model=WebhookEndpoint)
async def get_webhook_endpoint(endpoint_id: str):
    """Get webhook endpoint by ID.
    
    Args:
        endpoint_id: Webhook endpoint ID
        
    Returns:
        WebhookEndpoint: Webhook endpoint details
    """
    try:
        webhook = notification_service.webhooks.get(endpoint_id)
        if not webhook:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Webhook endpoint {endpoint_id} not found"
            )
        
        return webhook
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting webhook endpoint: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error retrieving webhook endpoint"
        )

@router.post("/webhooks/{endpoint_id}/test")
async def test_webhook_endpoint(endpoint_id: str):
    """Test a webhook endpoint.
    
    Args:
        endpoint_id: Webhook endpoint ID
        
    Returns:
        dict: Test result
    """
    try:
        success = await notification_service.test_webhook_endpoint(endpoint_id)
        
        return {
            "endpoint_id": endpoint_id,
            "test_successful": success,
            "message": "Test notification sent successfully" if success else "Test notification failed"
        }
        
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(e)
        )
    except Exception as e:
        logger.error(f"Error testing webhook endpoint: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error testing webhook endpoint"
        )

@router.delete("/webhooks/{endpoint_id}")
async def delete_webhook_endpoint(endpoint_id: str):
    """Delete a webhook endpoint.
    
    Args:
        endpoint_id: Webhook endpoint ID
        
    Returns:
        dict: Deletion confirmation
    """
    try:
        if endpoint_id not in notification_service.webhooks:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Webhook endpoint {endpoint_id} not found"
            )
        
        del notification_service.webhooks[endpoint_id]
        if endpoint_id in notification_service.destinations:
            del notification_service.destinations[endpoint_id]
        
        return {
            "message": f"Webhook endpoint {endpoint_id} deleted successfully",
            "endpoint_id": endpoint_id
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting webhook endpoint: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error deleting webhook endpoint"
        )

@router.post("/events/publish")
async def publish_event(
    bucket_name: str = Query(..., description="Bucket name"),
    object_key: str = Query(..., description="Object key"),
    event_type: EventType = Query(..., description="Event type"),
    user_identity: Optional[str] = Query(None, description="User identity"),
    source_ip: Optional[str] = Query(None, description="Source IP address")
):
    """Publish an S3 event.
    
    Args:
        bucket_name: Bucket name
        object_key: Object key
        event_type: Event type
        user_identity: User identity
        source_ip: Source IP address
        
    Returns:
        dict: Event publication confirmation
    """
    try:
        success = await notification_service.publish_event(
            bucket_name, object_key, event_type, user_identity, source_ip
        )
        
        if success:
            return {
                "message": "Event published successfully",
                "bucket_name": bucket_name,
                "object_key": object_key,
                "event_type": event_type.value
            }
        else:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to publish event"
            )
            
    except Exception as e:
        logger.error(f"Error publishing event: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error publishing event"
        )

@router.get("/events/history", response_model=List[EventHistory])
async def get_event_history(
    bucket_name: Optional[str] = Query(None, description="Filter by bucket name"),
    event_types: Optional[List[EventType]] = Query(None, description="Filter by event types"),
    limit: int = Query(100, ge=1, le=1000, description="Maximum number of events")
):
    """Get event history.
    
    Args:
        bucket_name: Filter by bucket name
        event_types: Filter by event types
        limit: Maximum number of events
        
    Returns:
        List[EventHistory]: Event history
    """
    try:
        events = await notification_service.search_event_history(
            bucket_name=bucket_name,
            event_types=event_types,
            limit=limit
        )
        return events
        
    except Exception as e:
        logger.error(f"Error getting event history: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error retrieving event history"
        )

@router.post("/subscriptions")
async def create_event_subscription(subscription: EventSubscription):
    """Create an event subscription.
    
    Args:
        subscription: Event subscription configuration
        
    Returns:
        dict: Subscription creation confirmation
    """
    try:
        success = await notification_service.create_event_subscription(subscription)
        
        if success:
            return {
                "message": f"Event subscription '{subscription.name}' created successfully",
                "subscription_id": subscription.subscription_id
            }
        else:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to create event subscription"
            )
            
    except Exception as e:
        logger.error(f"Error creating event subscription: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error creating event subscription"
        )

@router.get("/subscriptions", response_model=List[EventSubscription])
async def list_event_subscriptions():
    """List all event subscriptions.
    
    Returns:
        List[EventSubscription]: All event subscriptions
    """
    try:
        subscriptions = list(notification_service.subscriptions.values())
        return subscriptions
        
    except Exception as e:
        logger.error(f"Error listing event subscriptions: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error listing event subscriptions"
        )

@router.get("/stats", response_model=NotificationStats)
async def get_notification_stats():
    """Get notification statistics.
    
    Returns:
        NotificationStats: Notification statistics
    """
    try:
        stats = await notification_service.get_notification_stats()
        return stats
        
    except Exception as e:
        logger.error(f"Error getting notification stats: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error retrieving notification statistics"
        )

@router.get("/health")
async def get_notification_health():
    """Get notification system health.
    
    Returns:
        dict: Notification system health status
    """
    try:
        stats = await notification_service.get_notification_stats()
        
        # Calculate health metrics
        total_configs = stats.total_configurations
        active_configs = stats.active_configurations
        success_rate_24h = 0.0
        
        if stats.total_messages_24h > 0:
            success_rate_24h = (stats.successful_deliveries_24h / stats.total_messages_24h) * 100
        
        # Determine health status
        if success_rate_24h >= 95 and stats.failed_deliveries_24h < 10:
            health_status = "healthy"
        elif success_rate_24h >= 85:
            health_status = "warning"
        else:
            health_status = "critical"
        
        return {
            "status": health_status,
            "total_configurations": total_configs,
            "active_configurations": active_configs,
            "success_rate_24h": success_rate_24h,
            "failed_deliveries_24h": stats.failed_deliveries_24h,
            "average_delivery_time_ms": stats.average_delivery_time_ms,
            "queue_size": len(notification_service.message_queue),
            "generated_at": stats.generated_at.isoformat()
        }
        
    except Exception as e:
        logger.error(f"Error getting notification health: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error retrieving notification health"
        )

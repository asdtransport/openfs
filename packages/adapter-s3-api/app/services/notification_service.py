"""Notification and event system service implementation."""

import asyncio
import json
import secrets
from datetime import datetime, timedelta
from typing import Dict, List, Optional
from loguru import logger
import httpx

from app.schemas.notifications import (
    BucketNotificationConfig, NotificationConfiguration, NotificationDestination,
    S3Event, S3EventRecord, NotificationMessage, EventSubscription,
    WebhookEndpoint, EventHistory, NotificationStats,
    EventType, NotificationStatus, NotificationDestinationType
)
from app.services.minio_client import minio_client


class NotificationService:
    """Notification and event system service."""
    
    def __init__(self):
        """Initialize notification service."""
        self.bucket_configs: Dict[str, BucketNotificationConfig] = {}
        self.destinations: Dict[str, NotificationDestination] = {}
        self.webhooks: Dict[str, WebhookEndpoint] = {}
        self.subscriptions: Dict[str, EventSubscription] = {}
        self.message_queue: List[NotificationMessage] = []
        self.event_history: List[EventHistory] = []
        self.delivery_stats = {
            "total_sent": 0,
            "total_delivered": 0,
            "total_failed": 0
        }
        
        # Start background notification processor
        asyncio.create_task(self._notification_processor())
        
        # Start event cleanup task
        asyncio.create_task(self._cleanup_old_events())
    
    async def _notification_processor(self):
        """Background task to process notification queue."""
        while True:
            try:
                await self._process_notification_queue()
                await asyncio.sleep(5)  # Process every 5 seconds
            except Exception as e:
                logger.error(f"Error in notification processor: {e}")
                await asyncio.sleep(30)
    
    async def _cleanup_old_events(self):
        """Clean up old event history."""
        while True:
            try:
                cutoff_time = datetime.utcnow() - timedelta(days=30)  # Keep 30 days
                self.event_history = [
                    event for event in self.event_history
                    if event.event_time > cutoff_time
                ]
                
                # Sleep for 1 hour
                await asyncio.sleep(3600)
                
            except Exception as e:
                logger.error(f"Error cleaning up old events: {e}")
                await asyncio.sleep(3600)
    
    async def create_bucket_notification_config(self, bucket_name: str, config: BucketNotificationConfig) -> bool:
        """Create notification configuration for a bucket."""
        try:
            # Validate bucket exists
            if not await minio_client.bucket_exists(bucket_name):
                raise ValueError(f"Bucket {bucket_name} does not exist")
            
            # Validate destinations exist
            for notification_config in config.configurations:
                dest_id = notification_config.destination.id
                if dest_id not in self.destinations:
                    # Auto-create destination
                    self.destinations[dest_id] = notification_config.destination
            
            self.bucket_configs[bucket_name] = config
            
            logger.info(f"Created notification configuration for bucket {bucket_name} with {len(config.configurations)} configurations")
            return True
            
        except Exception as e:
            logger.error(f"Error creating bucket notification config: {e}")
            raise
    
    async def get_bucket_notification_config(self, bucket_name: str) -> Optional[BucketNotificationConfig]:
        """Get notification configuration for a bucket."""
        return self.bucket_configs.get(bucket_name)
    
    async def delete_bucket_notification_config(self, bucket_name: str) -> bool:
        """Delete notification configuration for a bucket."""
        if bucket_name in self.bucket_configs:
            del self.bucket_configs[bucket_name]
            logger.info(f"Deleted notification configuration for bucket {bucket_name}")
            return True
        return False
    
    async def create_webhook_endpoint(self, webhook: WebhookEndpoint) -> bool:
        """Create a webhook endpoint."""
        try:
            self.webhooks[webhook.endpoint_id] = webhook
            
            # Also create as a destination
            destination = NotificationDestination(
                id=webhook.endpoint_id,
                type=NotificationDestinationType.WEBHOOK,
                endpoint=webhook.url,
                headers=webhook.headers
            )
            self.destinations[webhook.endpoint_id] = destination
            
            logger.info(f"Created webhook endpoint {webhook.endpoint_id}: {webhook.name}")
            return True
            
        except Exception as e:
            logger.error(f"Error creating webhook endpoint: {e}")
            raise
    
    async def test_webhook_endpoint(self, endpoint_id: str) -> bool:
        """Test a webhook endpoint."""
        try:
            webhook = self.webhooks.get(endpoint_id)
            if not webhook:
                raise ValueError(f"Webhook endpoint {endpoint_id} not found")
            
            # Create test event
            test_event = S3Event(
                aws_region="us-east-1",
                event_name=EventType.OBJECT_CREATED_PUT,
                s3={
                    "bucket": {"name": "test-bucket"},
                    "object": {"key": "test-object.txt", "size": 1024}
                }
            )
            
            # Send test notification
            success = await self._send_webhook_notification(webhook, test_event)
            
            if success:
                webhook.last_success = datetime.utcnow()
                webhook.success_count += 1
            else:
                webhook.last_failure = datetime.utcnow()
                webhook.failure_count += 1
            
            return success
            
        except Exception as e:
            logger.error(f"Error testing webhook endpoint: {e}")
            return False
    
    async def publish_event(self, bucket_name: str, object_key: str, event_type: EventType,
                          user_identity: Optional[str] = None, source_ip: Optional[str] = None) -> bool:
        """Publish an S3 event."""
        try:
            # Create S3 event
            event = S3Event(
                aws_region="us-east-1",
                event_name=event_type,
                user_identity={"principalId": user_identity or "anonymous"},
                s3={
                    "bucket": {"name": bucket_name},
                    "object": {"key": object_key}
                }
            )
            
            # Store in event history
            event_history = EventHistory(
                event_id=f"event-{secrets.token_hex(8)}",
                bucket_name=bucket_name,
                object_key=object_key,
                event_type=event_type,
                event_time=datetime.utcnow(),
                user_identity=user_identity,
                source_ip=source_ip
            )
            self.event_history.append(event_history)
            
            # Find matching notification configurations
            bucket_config = self.bucket_configs.get(bucket_name)
            if not bucket_config:
                logger.debug(f"No notification configuration for bucket {bucket_name}")
                return True
            
            notifications_sent = 0
            notifications_success = 0
            notifications_failed = 0
            
            for config in bucket_config.configurations:
                if not config.is_enabled:
                    continue
                
                # Check if event type matches
                if event_type not in config.events and EventType.OBJECT_CREATED not in config.events:
                    continue
                
                # Check filters
                if not self._event_matches_filter(event, config.filter):
                    continue
                
                # Create notification message
                message = NotificationMessage(
                    message_id=f"msg-{secrets.token_hex(8)}",
                    notification_config_id=config.id,
                    bucket_name=bucket_name,
                    event=event,
                    destination=config.destination,
                    payload={"Records": [event.dict()]}
                )
                
                self.message_queue.append(message)
                notifications_sent += 1
            
            # Update event history
            event_history.notifications_sent = notifications_sent
            
            logger.info(f"Published event {event_type.value} for {bucket_name}/{object_key}, queued {notifications_sent} notifications")
            return True
            
        except Exception as e:
            logger.error(f"Error publishing event: {e}")
            return False
    
    def _event_matches_filter(self, event: S3Event, filter_config) -> bool:
        """Check if event matches notification filter."""
        if not filter_config:
            return True
        
        object_key = event.s3.get("object", {}).get("key", "")
        
        # Check key filters
        if filter_config.key:
            for rule in filter_config.key:
                if rule.name == "prefix" and not object_key.startswith(rule.value):
                    return False
                elif rule.name == "suffix" and not object_key.endswith(rule.value):
                    return False
        
        # Check metadata filters (simplified)
        if filter_config.metadata:
            # Would need actual object metadata to check
            pass
        
        # Check size filters
        if filter_config.size_range:
            object_size = event.s3.get("object", {}).get("size", 0)
            min_size = filter_config.size_range.get("min", 0)
            max_size = filter_config.size_range.get("max", float('inf'))
            if not (min_size <= object_size <= max_size):
                return False
        
        return True
    
    async def _process_notification_queue(self):
        """Process pending notifications."""
        if not self.message_queue:
            return
        
        # Process up to 10 messages at a time
        messages_to_process = self.message_queue[:10]
        self.message_queue = self.message_queue[10:]
        
        for message in messages_to_process:
            try:
                success = await self._deliver_notification(message)
                
                if success:
                    message.status = NotificationStatus.DELIVERED
                    message.delivered_at = datetime.utcnow()
                    self.delivery_stats["total_delivered"] += 1
                else:
                    message.status = NotificationStatus.FAILED
                    message.retry_count += 1
                    self.delivery_stats["total_failed"] += 1
                    
                    # Retry logic
                    if message.retry_count < 3:
                        message.status = NotificationStatus.RETRYING
                        # Re-queue for retry (with delay)
                        await asyncio.sleep(5)
                        self.message_queue.append(message)
                
                self.delivery_stats["total_sent"] += 1
                
            except Exception as e:
                logger.error(f"Error processing notification message {message.message_id}: {e}")
                message.status = NotificationStatus.FAILED
                message.error_message = str(e)
    
    async def _deliver_notification(self, message: NotificationMessage) -> bool:
        """Deliver a notification message."""
        try:
            destination = message.destination
            
            if destination.type == NotificationDestinationType.WEBHOOK:
                return await self._send_webhook_notification_from_message(message)
            elif destination.type == NotificationDestinationType.EMAIL:
                return await self._send_email_notification(message)
            elif destination.type == NotificationDestinationType.SLACK:
                return await self._send_slack_notification(message)
            else:
                logger.warning(f"Unsupported destination type: {destination.type}")
                return False
                
        except Exception as e:
            logger.error(f"Error delivering notification: {e}")
            return False
    
    async def _send_webhook_notification_from_message(self, message: NotificationMessage) -> bool:
        """Send webhook notification from message."""
        try:
            destination = message.destination
            
            headers = {
                "Content-Type": "application/json",
                "User-Agent": "MinIO-Notification-Service/1.0"
            }
            
            if destination.headers:
                headers.update(destination.headers)
            
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(
                    destination.endpoint,
                    json=message.payload,
                    headers=headers
                )
                
                if response.status_code == 200:
                    logger.info(f"Successfully sent webhook notification to {destination.endpoint}")
                    return True
                else:
                    logger.error(f"Webhook notification failed with status {response.status_code}: {response.text}")
                    return False
                    
        except Exception as e:
            logger.error(f"Error sending webhook notification: {e}")
            return False
    
    async def _send_webhook_notification(self, webhook: WebhookEndpoint, event: S3Event) -> bool:
        """Send webhook notification for testing."""
        try:
            headers = {
                "Content-Type": "application/json",
                "User-Agent": "MinIO-Notification-Service/1.0"
            }
            
            if webhook.headers:
                headers.update(webhook.headers)
            
            payload = {"Records": [event.dict()]}
            
            async with httpx.AsyncClient(timeout=webhook.timeout_seconds) as client:
                response = await client.post(
                    webhook.url,
                    json=payload,
                    headers=headers
                )
                
                if response.status_code == 200:
                    logger.info(f"Successfully sent test webhook to {webhook.url}")
                    return True
                else:
                    logger.error(f"Test webhook failed with status {response.status_code}: {response.text}")
                    return False
                    
        except Exception as e:
            logger.error(f"Error sending test webhook: {e}")
            return False
    
    async def _send_email_notification(self, message: NotificationMessage) -> bool:
        """Send email notification (placeholder)."""
        # TODO: Implement email notification
        logger.info(f"Email notification would be sent to {message.destination.endpoint}")
        return True
    
    async def _send_slack_notification(self, message: NotificationMessage) -> bool:
        """Send Slack notification (placeholder)."""
        # TODO: Implement Slack notification
        logger.info(f"Slack notification would be sent to {message.destination.endpoint}")
        return True
    
    async def create_event_subscription(self, subscription: EventSubscription) -> bool:
        """Create an event subscription."""
        try:
            self.subscriptions[subscription.subscription_id] = subscription
            logger.info(f"Created event subscription {subscription.subscription_id} for user {subscription.user_id}")
            return True
            
        except Exception as e:
            logger.error(f"Error creating event subscription: {e}")
            raise
    
    async def get_notification_stats(self) -> NotificationStats:
        """Get notification statistics."""
        try:
            # Count active configurations
            total_configs = sum(len(config.configurations) for config in self.bucket_configs.values())
            active_configs = sum(
                len([c for c in config.configurations if c.is_enabled])
                for config in self.bucket_configs.values()
            )
            
            # Get recent messages (last 24 hours)
            last_24h = datetime.utcnow() - timedelta(hours=24)
            recent_messages = [
                msg for msg in self.message_queue + self._get_recent_processed_messages()
                if msg.created_at > last_24h
            ]
            
            successful_24h = len([msg for msg in recent_messages if msg.status == NotificationStatus.DELIVERED])
            failed_24h = len([msg for msg in recent_messages if msg.status == NotificationStatus.FAILED])
            
            # Calculate average delivery time
            delivered_messages = [msg for msg in recent_messages if msg.delivered_at and msg.sent_at]
            avg_delivery_time = 0.0
            if delivered_messages:
                total_time = sum(
                    (msg.delivered_at - msg.sent_at).total_seconds() * 1000
                    for msg in delivered_messages
                )
                avg_delivery_time = total_time / len(delivered_messages)
            
            # Top event types
            event_counts = {}
            for event in self.event_history[-1000:]:  # Last 1000 events
                event_type = event.event_type.value
                event_counts[event_type] = event_counts.get(event_type, 0) + 1
            
            top_event_types = [
                {"event_type": event_type, "count": count}
                for event_type, count in sorted(event_counts.items(), key=lambda x: x[1], reverse=True)[:5]
            ]
            
            # Destination health
            destination_health = {}
            for dest_id, dest in self.destinations.items():
                if dest_id in self.webhooks:
                    webhook = self.webhooks[dest_id]
                    total_attempts = webhook.success_count + webhook.failure_count
                    success_rate = (webhook.success_count / total_attempts * 100) if total_attempts > 0 else 0
                    
                    destination_health[dest_id] = {
                        "name": dest.endpoint,
                        "success_rate": round(success_rate, 2),
                        "total_attempts": total_attempts,
                        "last_success": webhook.last_success.isoformat() if webhook.last_success else None
                    }
            
            return NotificationStats(
                total_configurations=total_configs,
                active_configurations=active_configs,
                total_messages_24h=len(recent_messages),
                successful_deliveries_24h=successful_24h,
                failed_deliveries_24h=failed_24h,
                average_delivery_time_ms=avg_delivery_time,
                top_event_types=top_event_types,
                destination_health=destination_health
            )
            
        except Exception as e:
            logger.error(f"Error getting notification stats: {e}")
            raise
    
    def _get_recent_processed_messages(self) -> List[NotificationMessage]:
        """Get recently processed messages (placeholder for persistent storage)."""
        # In a real implementation, this would query a database
        return []
    
    async def search_event_history(self, bucket_name: Optional[str] = None,
                                 event_types: Optional[List[EventType]] = None,
                                 start_time: Optional[datetime] = None,
                                 end_time: Optional[datetime] = None,
                                 limit: int = 100) -> List[EventHistory]:
        """Search event history."""
        try:
            events = self.event_history
            
            # Apply filters
            if bucket_name:
                events = [e for e in events if e.bucket_name == bucket_name]
            
            if event_types:
                events = [e for e in events if e.event_type in event_types]
            
            if start_time:
                events = [e for e in events if e.event_time >= start_time]
            
            if end_time:
                events = [e for e in events if e.event_time <= end_time]
            
            # Sort by time (most recent first)
            events.sort(key=lambda x: x.event_time, reverse=True)
            
            return events[:limit]
            
        except Exception as e:
            logger.error(f"Error searching event history: {e}")
            raise


# Global notification service instance
notification_service = NotificationService()

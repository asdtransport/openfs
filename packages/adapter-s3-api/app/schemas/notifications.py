"""Notification and event system schemas."""

from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Optional, Union
from pydantic import BaseModel, Field, validator


class EventType(str, Enum):
    """S3 event types."""
    # Object events
    OBJECT_CREATED = "s3:ObjectCreated:*"
    OBJECT_CREATED_PUT = "s3:ObjectCreated:Put"
    OBJECT_CREATED_POST = "s3:ObjectCreated:Post"
    OBJECT_CREATED_COPY = "s3:ObjectCreated:Copy"
    OBJECT_CREATED_MULTIPART = "s3:ObjectCreated:CompleteMultipartUpload"
    
    OBJECT_REMOVED = "s3:ObjectRemoved:*"
    OBJECT_REMOVED_DELETE = "s3:ObjectRemoved:Delete"
    OBJECT_REMOVED_DELETE_MARKER = "s3:ObjectRemoved:DeleteMarkerCreated"
    
    OBJECT_RESTORE = "s3:ObjectRestore:*"
    OBJECT_RESTORE_POST = "s3:ObjectRestore:Post"
    OBJECT_RESTORE_COMPLETED = "s3:ObjectRestore:Completed"
    
    OBJECT_TRANSITION = "s3:ObjectTransition"
    OBJECT_ACL_PUT = "s3:ObjectAcl:Put"
    OBJECT_TAGGING = "s3:ObjectTagging:*"
    OBJECT_TAGGING_PUT = "s3:ObjectTagging:Put"
    OBJECT_TAGGING_DELETE = "s3:ObjectTagging:Delete"
    
    # Bucket events
    BUCKET_CREATED = "s3:BucketCreated"
    BUCKET_REMOVED = "s3:BucketRemoved"
    
    # Replication events
    REPLICATION = "s3:Replication:*"
    REPLICATION_FAILED = "s3:Replication:OperationFailedReplication"
    REPLICATION_NOT_TRACKED = "s3:Replication:OperationNotTracked"
    REPLICATION_MISSED_THRESHOLD = "s3:Replication:OperationMissedThreshold"
    REPLICATION_REPLICA_CREATED = "s3:Replication:OperationReplicatedAfterThreshold"


class NotificationDestinationType(str, Enum):
    """Notification destination types."""
    SQS = "sqs"
    SNS = "sns"
    LAMBDA = "lambda"
    WEBHOOK = "webhook"
    EMAIL = "email"
    SLACK = "slack"
    TEAMS = "teams"
    DISCORD = "discord"
    KAFKA = "kafka"
    RABBITMQ = "rabbitmq"
    REDIS = "redis"


class NotificationStatus(str, Enum):
    """Notification delivery status."""
    PENDING = "pending"
    SENT = "sent"
    DELIVERED = "delivered"
    FAILED = "failed"
    RETRYING = "retrying"
    EXPIRED = "expired"


class FilterRule(BaseModel):
    """Notification filter rule."""
    name: str = Field(..., description="Filter name (prefix, suffix)")
    value: str = Field(..., description="Filter value")
    
    @validator('name')
    def validate_filter_name(cls, v):
        """Validate filter name."""
        if v not in ['prefix', 'suffix']:
            raise ValueError("Filter name must be 'prefix' or 'suffix'")
        return v


class NotificationFilter(BaseModel):
    """Notification filter configuration."""
    key: Optional[List[FilterRule]] = Field(None, description="Key-based filters")
    metadata: Optional[Dict[str, str]] = Field(None, description="Metadata filters")
    size_range: Optional[Dict[str, int]] = Field(None, description="Size range filters")
    content_type: Optional[List[str]] = Field(None, description="Content type filters")


class NotificationDestination(BaseModel):
    """Notification destination configuration."""
    id: str = Field(..., description="Destination identifier")
    type: NotificationDestinationType = Field(..., description="Destination type")
    endpoint: str = Field(..., description="Destination endpoint/URL")
    credentials: Optional[Dict[str, str]] = Field(None, description="Authentication credentials", exclude=True)
    headers: Optional[Dict[str, str]] = Field(None, description="Additional headers")
    retry_policy: Optional[Dict[str, Union[int, str]]] = Field(None, description="Retry configuration")
    is_active: bool = Field(True, description="Destination active status")
    created_at: datetime = Field(default_factory=datetime.utcnow)
    last_used: Optional[datetime] = Field(None, description="Last used timestamp")


class NotificationConfiguration(BaseModel):
    """Bucket notification configuration."""
    id: str = Field(..., description="Configuration identifier")
    events: List[EventType] = Field(..., description="Events to monitor")
    filter: Optional[NotificationFilter] = Field(None, description="Event filters")
    destination: NotificationDestination = Field(..., description="Notification destination")
    is_enabled: bool = Field(True, description="Configuration enabled status")
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)


class BucketNotificationConfig(BaseModel):
    """Complete bucket notification configuration."""
    bucket_name: str = Field(..., description="Bucket name")
    configurations: List[NotificationConfiguration] = Field(
        default_factory=list, description="Notification configurations"
    )
    
    @validator('configurations')
    def validate_unique_ids(cls, v):
        """Ensure configuration IDs are unique."""
        config_ids = [config.id for config in v]
        if len(config_ids) != len(set(config_ids)):
            raise ValueError("Configuration IDs must be unique")
        return v


class S3Event(BaseModel):
    """S3 event record."""
    event_version: str = Field("2.1", description="Event version")
    event_source: str = Field("aws:s3", description="Event source")
    aws_region: str = Field(..., description="AWS region")
    event_time: datetime = Field(default_factory=datetime.utcnow, description="Event timestamp")
    event_name: EventType = Field(..., description="Event name")
    user_identity: Dict[str, str] = Field(default_factory=dict, description="User identity")
    request_parameters: Dict[str, str] = Field(default_factory=dict, description="Request parameters")
    response_elements: Dict[str, str] = Field(default_factory=dict, description="Response elements")
    s3: Dict[str, Any] = Field(..., description="S3 event data")
    glacier_event_data: Optional[Dict[str, Any]] = Field(None, description="Glacier event data")


class S3EventRecord(BaseModel):
    """Complete S3 event record."""
    records: List[S3Event] = Field(..., description="Event records")


class NotificationMessage(BaseModel):
    """Notification message."""
    message_id: str = Field(..., description="Message identifier")
    notification_config_id: str = Field(..., description="Associated notification configuration")
    bucket_name: str = Field(..., description="Source bucket")
    event: S3Event = Field(..., description="S3 event")
    destination: NotificationDestination = Field(..., description="Target destination")
    status: NotificationStatus = Field(NotificationStatus.PENDING, description="Delivery status")
    created_at: datetime = Field(default_factory=datetime.utcnow)
    sent_at: Optional[datetime] = Field(None, description="Sent timestamp")
    delivered_at: Optional[datetime] = Field(None, description="Delivered timestamp")
    retry_count: int = Field(0, description="Retry attempt count")
    error_message: Optional[str] = Field(None, description="Error message if failed")
    payload: Dict[str, Any] = Field(default_factory=dict, description="Message payload")


class EventSubscription(BaseModel):
    """Event subscription for real-time notifications."""
    subscription_id: str = Field(..., description="Subscription identifier")
    user_id: str = Field(..., description="Subscriber user ID")
    bucket_name: Optional[str] = Field(None, description="Bucket filter")
    event_types: List[EventType] = Field(..., description="Subscribed event types")
    filter: Optional[NotificationFilter] = Field(None, description="Event filters")
    delivery_method: NotificationDestinationType = Field(..., description="Delivery method")
    endpoint: str = Field(..., description="Delivery endpoint")
    is_active: bool = Field(True, description="Subscription active status")
    created_at: datetime = Field(default_factory=datetime.utcnow)
    last_notification: Optional[datetime] = Field(None, description="Last notification timestamp")


class WebhookEndpoint(BaseModel):
    """Webhook endpoint configuration."""
    endpoint_id: str = Field(..., description="Endpoint identifier")
    name: str = Field(..., description="Endpoint name")
    url: str = Field(..., description="Webhook URL")
    secret: Optional[str] = Field(None, description="Webhook secret for verification", exclude=True)
    headers: Optional[Dict[str, str]] = Field(None, description="Custom headers")
    timeout_seconds: int = Field(30, ge=1, le=300, description="Request timeout")
    max_retries: int = Field(3, ge=0, le=10, description="Maximum retry attempts")
    retry_delay_seconds: int = Field(5, ge=1, le=3600, description="Delay between retries")
    is_active: bool = Field(True, description="Endpoint active status")
    ssl_verify: bool = Field(True, description="Verify SSL certificates")
    created_at: datetime = Field(default_factory=datetime.utcnow)
    last_success: Optional[datetime] = Field(None, description="Last successful delivery")
    last_failure: Optional[datetime] = Field(None, description="Last failed delivery")
    success_count: int = Field(0, description="Total successful deliveries")
    failure_count: int = Field(0, description="Total failed deliveries")


class EventTemplate(BaseModel):
    """Event notification template."""
    template_id: str = Field(..., description="Template identifier")
    name: str = Field(..., description="Template name")
    description: Optional[str] = Field(None, description="Template description")
    event_types: List[EventType] = Field(..., description="Applicable event types")
    template_format: str = Field(..., description="Template format (json, xml, text)")
    template_content: str = Field(..., description="Template content with placeholders")
    variables: List[str] = Field(default_factory=list, description="Available template variables")
    is_default: bool = Field(False, description="Default template for event types")
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)


# Request/Response Models
class CreateNotificationConfigRequest(BaseModel):
    """Create notification configuration request."""
    bucket_name: str = Field(..., description="Bucket name")
    configuration: NotificationConfiguration = Field(..., description="Notification configuration")


class UpdateNotificationConfigRequest(BaseModel):
    """Update notification configuration request."""
    bucket_name: str = Field(..., description="Bucket name")
    config_id: str = Field(..., description="Configuration ID")
    configuration: NotificationConfiguration = Field(..., description="Updated configuration")


class CreateWebhookRequest(BaseModel):
    """Create webhook endpoint request."""
    webhook: WebhookEndpoint = Field(..., description="Webhook configuration")


class TestNotificationRequest(BaseModel):
    """Test notification request."""
    bucket_name: str = Field(..., description="Bucket name")
    config_id: str = Field(..., description="Configuration ID")
    test_event: Optional[EventType] = Field(EventType.OBJECT_CREATED_PUT, description="Test event type")


class NotificationStats(BaseModel):
    """Notification statistics."""
    total_configurations: int = Field(..., description="Total notification configurations")
    active_configurations: int = Field(..., description="Active configurations")
    total_messages_24h: int = Field(..., description="Messages sent in last 24 hours")
    successful_deliveries_24h: int = Field(..., description="Successful deliveries in last 24 hours")
    failed_deliveries_24h: int = Field(..., description="Failed deliveries in last 24 hours")
    average_delivery_time_ms: float = Field(..., description="Average delivery time in milliseconds")
    top_event_types: List[Dict[str, Union[str, int]]] = Field(
        default_factory=list, description="Most frequent event types"
    )
    destination_health: Dict[str, Dict[str, Union[str, int]]] = Field(
        default_factory=dict, description="Destination health status"
    )
    generated_at: datetime = Field(default_factory=datetime.utcnow)


class EventHistory(BaseModel):
    """Event history record."""
    event_id: str = Field(..., description="Event identifier")
    bucket_name: str = Field(..., description="Source bucket")
    object_key: Optional[str] = Field(None, description="Object key")
    event_type: EventType = Field(..., description="Event type")
    event_time: datetime = Field(..., description="Event timestamp")
    user_identity: Optional[str] = Field(None, description="User identity")
    source_ip: Optional[str] = Field(None, description="Source IP address")
    user_agent: Optional[str] = Field(None, description="User agent")
    request_id: Optional[str] = Field(None, description="Request ID")
    notifications_sent: int = Field(0, description="Number of notifications sent")
    notification_success: int = Field(0, description="Successful notifications")
    notification_failures: int = Field(0, description="Failed notifications")


class EventSearchQuery(BaseModel):
    """Event search query parameters."""
    bucket_name: Optional[str] = Field(None, description="Filter by bucket")
    event_types: Optional[List[EventType]] = Field(None, description="Filter by event types")
    start_time: datetime = Field(..., description="Search start time")
    end_time: datetime = Field(..., description="Search end time")
    object_prefix: Optional[str] = Field(None, description="Filter by object prefix")
    user_identity: Optional[str] = Field(None, description="Filter by user")
    limit: int = Field(100, ge=1, le=1000, description="Maximum results")
    offset: int = Field(0, ge=0, description="Result offset")


class EventSearchResponse(BaseModel):
    """Event search response."""
    events: List[EventHistory] = Field(..., description="Matching events")
    total_count: int = Field(..., description="Total matching events")
    has_more: bool = Field(..., description="More results available")
    query: EventSearchQuery = Field(..., description="Original query")
    generated_at: datetime = Field(default_factory=datetime.utcnow)

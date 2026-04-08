"""Bucket replication schemas."""

from datetime import datetime
from enum import Enum
from typing import Dict, List, Optional, Union
from pydantic import BaseModel, Field


class ReplicationStatus(str, Enum):
    """Replication status."""
    ENABLED = "Enabled"
    DISABLED = "Disabled"


class ReplicationRuleStatus(str, Enum):
    """Replication rule status."""
    ENABLED = "Enabled"
    DISABLED = "Disabled"


class StorageClass(str, Enum):
    """Storage classes for replication."""
    STANDARD = "STANDARD"
    STANDARD_IA = "STANDARD_IA"
    ONEZONE_IA = "ONEZONE_IA"
    REDUCED_REDUNDANCY = "REDUCED_REDUNDANCY"
    GLACIER = "GLACIER"
    DEEP_ARCHIVE = "DEEP_ARCHIVE"


class ReplicationTimeStatus(str, Enum):
    """Replication time control status."""
    ENABLED = "Enabled"
    DISABLED = "Disabled"


class ReplicationFilter(BaseModel):
    """Replication rule filter."""
    prefix: Optional[str] = Field(None, description="Object key prefix")
    tags: Dict[str, str] = Field(default_factory=dict, description="Object tags")


class ReplicationDestination(BaseModel):
    """Replication destination configuration."""
    bucket: str = Field(..., description="Destination bucket name")
    storage_class: Optional[StorageClass] = Field(None, description="Storage class override")
    access_control_translation: Optional[Dict[str, str]] = Field(None, description="Access control translation")
    account: Optional[str] = Field(None, description="Destination account ID")
    replication_time: Optional[Dict[str, Union[str, int]]] = Field(None, description="Replication time control")
    metrics: Optional[Dict[str, str]] = Field(None, description="Replication metrics")


class ReplicationRule(BaseModel):
    """Bucket replication rule."""
    id: str = Field(..., description="Rule identifier")
    status: ReplicationRuleStatus = Field(..., description="Rule status")
    priority: Optional[int] = Field(None, description="Rule priority")
    filter: Optional[ReplicationFilter] = Field(None, description="Rule filter")
    destination: ReplicationDestination = Field(..., description="Replication destination")
    delete_marker_replication: Optional[Dict[str, str]] = Field(None, description="Delete marker replication")
    existing_object_replication: Optional[Dict[str, str]] = Field(None, description="Existing object replication")


class BucketReplicationConfiguration(BaseModel):
    """Complete bucket replication configuration."""
    role: str = Field(..., description="IAM role ARN for replication")
    rules: List[ReplicationRule] = Field(..., min_items=1, max_items=1000, description="Replication rules")


class ReplicationMetrics(BaseModel):
    """Replication metrics."""
    status: str = Field(..., description="Metrics status")
    event_threshold: Optional[Dict[str, int]] = Field(None, description="Event threshold configuration")


class ReplicationJob(BaseModel):
    """Replication job execution."""
    job_id: str = Field(..., description="Job identifier")
    source_bucket: str = Field(..., description="Source bucket")
    destination_bucket: str = Field(..., description="Destination bucket")
    rule_id: str = Field(..., description="Associated rule ID")
    object_key: str = Field(..., description="Object key")
    status: str = Field(..., description="Job status")
    created_at: datetime = Field(default_factory=datetime.utcnow)
    started_at: Optional[datetime] = Field(None, description="Job start time")
    completed_at: Optional[datetime] = Field(None, description="Job completion time")
    bytes_replicated: int = Field(0, description="Bytes replicated")
    error_message: Optional[str] = Field(None, description="Error message if failed")


class ReplicationStatus(BaseModel):
    """Replication status for a bucket."""
    bucket_name: str = Field(..., description="Bucket name")
    replication_enabled: bool = Field(..., description="Replication enabled status")
    total_rules: int = Field(..., description="Total number of rules")
    active_rules: int = Field(..., description="Number of active rules")
    pending_jobs: int = Field(0, description="Number of pending jobs")
    completed_jobs_24h: int = Field(0, description="Jobs completed in last 24 hours")
    failed_jobs_24h: int = Field(0, description="Jobs failed in last 24 hours")
    bytes_replicated_24h: int = Field(0, description="Bytes replicated in last 24 hours")
    last_replication: Optional[datetime] = Field(None, description="Last replication timestamp")


class ReplicationReport(BaseModel):
    """Replication report."""
    report_id: str = Field(..., description="Report identifier")
    bucket_name: str = Field(..., description="Source bucket")
    report_date: datetime = Field(default_factory=datetime.utcnow)
    total_objects_replicated: int = Field(..., description="Total objects replicated")
    total_bytes_replicated: int = Field(..., description="Total bytes replicated")
    successful_replications: int = Field(..., description="Successful replications")
    failed_replications: int = Field(..., description="Failed replications")
    average_replication_time_ms: float = Field(..., description="Average replication time")
    replication_by_rule: Dict[str, int] = Field(default_factory=dict, description="Replications by rule")
    destinations: List[str] = Field(default_factory=list, description="Destination buckets")


# Request/Response Models
class CreateReplicationConfigRequest(BaseModel):
    """Create replication configuration request."""
    bucket_name: str = Field(..., description="Source bucket name")
    replication_configuration: BucketReplicationConfiguration = Field(..., description="Replication configuration")


class ReplicationConfigResponse(BaseModel):
    """Replication configuration response."""
    bucket_name: str
    replication_configuration: BucketReplicationConfiguration
    created_at: datetime
    last_modified: datetime


class StartReplicationJobRequest(BaseModel):
    """Start replication job request."""
    source_bucket: str = Field(..., description="Source bucket")
    object_key: str = Field(..., description="Object key")
    rule_id: Optional[str] = Field(None, description="Specific rule ID")


class ReplicationHealthCheck(BaseModel):
    """Replication health check."""
    overall_health: str = Field(..., description="Overall health status")
    total_configurations: int = Field(..., description="Total replication configurations")
    active_jobs: int = Field(..., description="Active replication jobs")
    failed_jobs_1h: int = Field(..., description="Failed jobs in last hour")
    average_replication_lag_ms: float = Field(..., description="Average replication lag")
    destination_connectivity: Dict[str, str] = Field(default_factory=dict, description="Destination connectivity status")
    issues: List[str] = Field(default_factory=list, description="Current issues")
    recommendations: List[str] = Field(default_factory=list, description="Recommendations")
    generated_at: datetime = Field(default_factory=datetime.utcnow)

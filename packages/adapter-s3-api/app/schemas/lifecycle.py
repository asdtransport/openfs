"""Bucket lifecycle management schemas."""

from datetime import datetime
from enum import Enum
from typing import Dict, List, Optional, Union
from pydantic import BaseModel, Field, field_validator


class LifecycleStatus(str, Enum):
    """Lifecycle rule status."""
    ENABLED = "Enabled"
    DISABLED = "Disabled"


class TransitionStorageClass(str, Enum):
    """Storage classes for lifecycle transitions."""
    STANDARD = "STANDARD"
    STANDARD_IA = "STANDARD_IA"
    ONEZONE_IA = "ONEZONE_IA"
    REDUCED_REDUNDANCY = "REDUCED_REDUNDANCY"
    GLACIER = "GLACIER"
    DEEP_ARCHIVE = "DEEP_ARCHIVE"
    INTELLIGENT_TIERING = "INTELLIGENT_TIERING"


class ExpirationUnit(str, Enum):
    """Units for expiration times."""
    DAYS = "Days"
    DATE = "Date"


class FilterType(str, Enum):
    """Lifecycle filter types."""
    PREFIX = "Prefix"
    TAG = "Tag"
    AND = "And"
    SIZE_GREATER_THAN = "ObjectSizeGreaterThan"
    SIZE_LESS_THAN = "ObjectSizeLessThan"


class LifecycleTransition(BaseModel):
    """Lifecycle transition configuration."""
    days: Optional[int] = Field(None, ge=0, description="Number of days after object creation")
    date: Optional[str] = Field(None, description="Specific date for transition (ISO format)")
    storage_class: TransitionStorageClass = Field(..., description="Target storage class")


class LifecycleExpiration(BaseModel):
    """Lifecycle expiration configuration."""
    days: Optional[int] = Field(None, ge=1, description="Number of days after object creation")
    date: Optional[str] = Field(None, description="Specific expiration date (ISO format)")
    expired_object_delete_marker: Optional[bool] = Field(None, description="Delete expired object delete markers")


class NoncurrentVersionTransition(BaseModel):
    """Lifecycle transition for noncurrent versions."""
    noncurrent_days: int = Field(..., ge=1, description="Number of days after version becomes noncurrent")
    storage_class: TransitionStorageClass = Field(..., description="Target storage class")
    newer_noncurrent_versions: Optional[int] = Field(None, ge=1, description="Number of newer versions to retain")


class NoncurrentVersionExpiration(BaseModel):
    """Lifecycle expiration for noncurrent versions."""
    noncurrent_days: int = Field(..., ge=1, description="Number of days after version becomes noncurrent")
    newer_noncurrent_versions: Optional[int] = Field(None, ge=1, description="Number of newer versions to retain")


class AbortIncompleteMultipartUpload(BaseModel):
    """Configuration for aborting incomplete multipart uploads."""
    days_after_initiation: int = Field(..., ge=1, description="Days after upload initiation")


class LifecycleTag(BaseModel):
    """Tag filter for lifecycle rules."""
    key: str = Field(..., description="Tag key")
    value: str = Field(..., description="Tag value")


class LifecycleFilter(BaseModel):
    """Lifecycle rule filter."""
    prefix: Optional[str] = Field(None, description="Object key prefix")
    tag: Optional[LifecycleTag] = Field(None, description="Object tag filter")
    object_size_greater_than: Optional[int] = Field(None, ge=0, description="Minimum object size in bytes")
    object_size_less_than: Optional[int] = Field(None, ge=1, description="Maximum object size in bytes")
    # Remove recursive reference to avoid recursion issues
    # and_filters: Optional[List['LifecycleFilter']] = Field(None, description="AND combination of filters")
    
# Removed validator to fix Pydantic v2 compatibility


# Remove model rebuild since we removed the recursive reference


class LifecycleRule(BaseModel):
    """Lifecycle management rule."""
    id: str = Field(..., max_length=255, description="Unique rule identifier")
    status: LifecycleStatus = Field(..., description="Rule status")
    filter: Optional[LifecycleFilter] = Field(None, description="Rule filter criteria")
    transitions: list = Field(default_factory=list, description="Storage class transitions")
    expiration: Optional[LifecycleExpiration] = Field(None, description="Object expiration")
    noncurrent_version_transitions: list = Field(
        default_factory=list, description="Noncurrent version transitions"
    )
    noncurrent_version_expiration: Optional[NoncurrentVersionExpiration] = Field(
        None, description="Noncurrent version expiration"
    )
    abort_incomplete_multipart_upload: Optional[AbortIncompleteMultipartUpload] = Field(
        None, description="Abort incomplete multipart uploads"
    )
    
# Removed validator to fix Pydantic v2 compatibility


class BucketLifecycleConfiguration(BaseModel):
    """Complete bucket lifecycle configuration."""
    rules: list = Field(..., description="Lifecycle rules")
    
# Removed validator to fix Pydantic v2 compatibility


class LifecycleAction(BaseModel):
    """Lifecycle action execution record."""
    action_id: str = Field(..., description="Unique action ID")
    rule_id: str = Field(..., description="Associated rule ID")
    bucket_name: str = Field(..., description="Target bucket")
    object_key: str = Field(..., description="Target object key")
    action_type: str = Field(..., description="Type of action (transition, expiration, etc.)")
    from_storage_class: Optional[str] = Field(None, description="Source storage class")
    to_storage_class: Optional[str] = Field(None, description="Target storage class")
    executed_at: datetime = Field(default_factory=datetime.utcnow, description="Execution timestamp")
    status: str = Field(..., description="Action status (success, failed, pending)")
    error_message: Optional[str] = Field(None, description="Error message if failed")


class LifecycleExecutionReport(BaseModel):
    """Lifecycle execution report."""
    report_id: str = Field(..., description="Report ID")
    bucket_name: str = Field(..., description="Bucket name")
    execution_date: str = Field(..., description="Execution date (ISO format)")
    total_objects_processed: int = Field(..., description="Total objects processed")
    successful_actions: int = Field(..., description="Successful actions")
    failed_actions: int = Field(..., description="Failed actions")
    actions_by_type: dict = Field(default_factory=dict, description="Actions grouped by type")
    storage_saved_bytes: int = Field(0, description="Storage saved in bytes")
    cost_savings_estimate: float = Field(0.0, description="Estimated cost savings")
    execution_duration_seconds: int = Field(..., description="Execution duration")
    generated_at: datetime = Field(default_factory=datetime.utcnow)


# Request/Response Models
class CreateLifecycleConfigRequest(BaseModel):
    """Create lifecycle configuration request."""
    bucket_name: str = Field(..., description="Bucket name")
    lifecycle_configuration: BucketLifecycleConfiguration = Field(..., description="Lifecycle configuration")


class UpdateLifecycleRuleRequest(BaseModel):
    """Update lifecycle rule request."""
    bucket_name: str = Field(..., description="Bucket name")
    rule_id: str = Field(..., description="Rule ID to update")
    rule: LifecycleRule = Field(..., description="Updated rule")


class LifecycleConfigResponse(BaseModel):
    """Lifecycle configuration response."""
    bucket_name: str
    lifecycle_configuration: BucketLifecycleConfiguration
    created_at: datetime
    last_modified: datetime


class LifecycleExecutionStatus(BaseModel):
    """Lifecycle execution status."""
    bucket_name: str
    last_execution: Optional[datetime] = Field(None, description="Last execution time")
    next_execution: Optional[datetime] = Field(None, description="Next scheduled execution")
    execution_frequency: str = Field("daily", description="Execution frequency")
    is_enabled: bool = Field(True, description="Execution enabled status")
    pending_actions: int = Field(0, description="Number of pending actions")
    total_rules: int = Field(0, description="Total number of rules")
    active_rules: int = Field(0, description="Number of active rules")


class LifecycleSimulationRequest(BaseModel):
    """Lifecycle simulation request."""
    bucket_name: str = Field(..., description="Bucket name")
    simulation_date: Optional[str] = Field(None, description="Simulation date (ISO format, default: today)")
    dry_run: bool = Field(True, description="Dry run mode")
    object_prefix: Optional[str] = Field(None, description="Limit simulation to objects with prefix")


class LifecycleSimulationResult(BaseModel):
    """Lifecycle simulation result."""
    simulation_id: str = Field(..., description="Simulation ID")
    bucket_name: str
    simulation_date: str = Field(..., description="Simulation date (ISO format)")
    total_objects_evaluated: int
    actions_to_execute: list = Field(default_factory=list, description="Actions to execute")
    estimated_storage_impact: dict = Field(default_factory=dict, description="Storage impact")
    estimated_cost_impact: float
    warnings: list = Field(default_factory=list, description="Warnings")
    generated_at: datetime = Field(default_factory=datetime.utcnow)

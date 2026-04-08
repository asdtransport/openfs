"""Object versioning and retention schemas."""

from datetime import datetime, timedelta
from enum import Enum
from typing import Dict, List, Optional
from pydantic import BaseModel, Field, validator


class RetentionMode(str, Enum):
    """Object retention mode."""
    GOVERNANCE = "GOVERNANCE"
    COMPLIANCE = "COMPLIANCE"


class LegalHoldStatus(str, Enum):
    """Legal hold status."""
    ON = "ON"
    OFF = "OFF"


class VersioningStatus(str, Enum):
    """Bucket versioning status."""
    ENABLED = "Enabled"
    SUSPENDED = "Suspended"


class ObjectVersion(BaseModel):
    """Object version information."""
    version_id: str = Field(..., description="Version ID")
    object_name: str = Field(..., description="Object name")
    bucket_name: str = Field(..., description="Bucket name")
    size: int = Field(..., description="Object size in bytes")
    etag: str = Field(..., description="Object ETag")
    last_modified: datetime = Field(..., description="Last modified timestamp")
    is_latest: bool = Field(..., description="Is this the latest version")
    is_delete_marker: bool = Field(False, description="Is this a delete marker")
    storage_class: Optional[str] = Field(None, description="Storage class")
    owner: Optional[str] = Field(None, description="Object owner")
    content_type: Optional[str] = Field(None, description="Content type")
    metadata: Dict[str, str] = Field(default_factory=dict, description="Object metadata")


class ObjectRetention(BaseModel):
    """Object retention configuration."""
    mode: RetentionMode = Field(..., description="Retention mode")
    retain_until_date: datetime = Field(..., description="Retention expiry date")
    
    @validator('retain_until_date')
    def validate_future_date(cls, v):
        """Ensure retention date is in the future."""
        if v <= datetime.utcnow():
            raise ValueError("Retention date must be in the future")
        return v


class ObjectLegalHold(BaseModel):
    """Object legal hold configuration."""
    status: LegalHoldStatus = Field(..., description="Legal hold status")
    applied_by: Optional[str] = Field(None, description="User who applied the hold")
    applied_at: Optional[datetime] = Field(None, description="When the hold was applied")
    reason: Optional[str] = Field(None, description="Reason for legal hold")


class BucketVersioning(BaseModel):
    """Bucket versioning configuration."""
    status: VersioningStatus = Field(..., description="Versioning status")
    mfa_delete: Optional[str] = Field(None, description="MFA delete status")


class ObjectLockConfiguration(BaseModel):
    """Bucket object lock configuration."""
    object_lock_enabled: bool = Field(..., description="Object lock enabled")
    default_retention: Optional[ObjectRetention] = Field(None, description="Default retention")
    
    @validator('default_retention')
    def validate_retention_with_lock(cls, v, values):
        """Validate retention settings when object lock is enabled."""
        if values.get('object_lock_enabled') and v is None:
            raise ValueError("Default retention required when object lock is enabled")
        return v


class VersionedObject(BaseModel):
    """Complete versioned object information."""
    object_name: str = Field(..., description="Object name")
    bucket_name: str = Field(..., description="Bucket name")
    versions: List[ObjectVersion] = Field(..., description="All object versions")
    latest_version: ObjectVersion = Field(..., description="Latest version")
    total_versions: int = Field(..., description="Total number of versions")
    total_size: int = Field(..., description="Total size of all versions")
    retention: Optional[ObjectRetention] = Field(None, description="Object retention")
    legal_hold: Optional[ObjectLegalHold] = Field(None, description="Legal hold status")


# Request/Response Models
class EnableVersioningRequest(BaseModel):
    """Enable versioning request."""
    bucket_name: str = Field(..., description="Bucket name")
    mfa_delete: Optional[bool] = Field(False, description="Enable MFA delete")


class SetRetentionRequest(BaseModel):
    """Set object retention request."""
    bucket_name: str = Field(..., description="Bucket name")
    object_name: str = Field(..., description="Object name")
    version_id: Optional[str] = Field(None, description="Specific version ID")
    retention: ObjectRetention = Field(..., description="Retention configuration")
    bypass_governance: bool = Field(False, description="Bypass governance mode")


class SetLegalHoldRequest(BaseModel):
    """Set legal hold request."""
    bucket_name: str = Field(..., description="Bucket name")
    object_name: str = Field(..., description="Object name")
    version_id: Optional[str] = Field(None, description="Specific version ID")
    legal_hold: LegalHoldStatus = Field(..., description="Legal hold status")
    reason: Optional[str] = Field(None, description="Reason for legal hold")


class ObjectLockConfigRequest(BaseModel):
    """Object lock configuration request."""
    bucket_name: str = Field(..., description="Bucket name")
    object_lock_enabled: bool = Field(..., description="Enable object lock")
    default_retention_mode: Optional[RetentionMode] = Field(None, description="Default retention mode")
    default_retention_days: Optional[int] = Field(None, description="Default retention period in days")
    
    @validator('default_retention_days')
    def validate_retention_days(cls, v, values):
        """Validate retention days."""
        if v is not None and v <= 0:
            raise ValueError("Retention days must be positive")
        if values.get('object_lock_enabled') and values.get('default_retention_mode') and v is None:
            raise ValueError("Retention days required when mode is specified")
        return v


class VersionListResponse(BaseModel):
    """Version list response."""
    bucket_name: str
    object_name: str
    versions: List[ObjectVersion]
    delete_markers: List[ObjectVersion]
    is_truncated: bool = Field(False, description="More versions available")
    next_version_id_marker: Optional[str] = Field(None, description="Next version marker")
    max_keys: int = Field(1000, description="Maximum keys returned")


class RetentionComplianceReport(BaseModel):
    """Retention compliance report."""
    bucket_name: str
    total_objects: int
    objects_with_retention: int
    objects_with_legal_hold: int
    compliance_percentage: float
    upcoming_expirations: List[Dict[str, str]]  # Objects expiring soon
    violations: List[Dict[str, str]]  # Compliance violations
    generated_at: datetime = Field(default_factory=datetime.utcnow)

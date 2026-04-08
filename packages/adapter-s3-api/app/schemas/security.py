"""Security and encryption schemas."""

from datetime import datetime
from enum import Enum
from typing import Dict, List, Optional, Union
from pydantic import BaseModel, Field, validator


class EncryptionType(str, Enum):
    """Encryption types."""
    NONE = "None"
    AES256 = "AES256"
    AWS_KMS = "aws:kms"
    SSE_C = "SSE-C"


class KeyManagementService(str, Enum):
    """Key management services."""
    AWS_KMS = "AWS-KMS"
    AZURE_KEY_VAULT = "Azure-KeyVault"
    GOOGLE_KMS = "Google-KMS"
    HASHICORP_VAULT = "HashiCorp-Vault"
    MINIO_KES = "MinIO-KES"


class AccessControlType(str, Enum):
    """Access control types."""
    PRIVATE = "private"
    PUBLIC_READ = "public-read"
    PUBLIC_READ_WRITE = "public-read-write"
    AUTHENTICATED_READ = "authenticated-read"
    BUCKET_OWNER_READ = "bucket-owner-read"
    BUCKET_OWNER_FULL_CONTROL = "bucket-owner-full-control"


class SecurityEventType(str, Enum):
    """Security event types."""
    LOGIN_SUCCESS = "login_success"
    LOGIN_FAILURE = "login_failure"
    ACCESS_DENIED = "access_denied"
    PERMISSION_ESCALATION = "permission_escalation"
    SUSPICIOUS_ACTIVITY = "suspicious_activity"
    DATA_BREACH_ATTEMPT = "data_breach_attempt"
    ENCRYPTION_KEY_ROTATION = "encryption_key_rotation"
    POLICY_VIOLATION = "policy_violation"


class ThreatLevel(str, Enum):
    """Threat severity levels."""
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


class BucketEncryption(BaseModel):
    """Bucket encryption configuration."""
    sse_algorithm: EncryptionType = Field(..., description="Server-side encryption algorithm")
    kms_master_key_id: Optional[str] = Field(None, description="KMS master key ID")
    kms_context: Optional[Dict[str, str]] = Field(None, description="KMS encryption context")
    bucket_key_enabled: bool = Field(False, description="Use bucket key for cost optimization")
    
    @validator('kms_master_key_id')
    def validate_kms_key(cls, v, values):
        """Validate KMS key when using KMS encryption."""
        if values.get('sse_algorithm') == EncryptionType.AWS_KMS and not v:
            raise ValueError("KMS master key ID required for KMS encryption")
        return v


class ObjectEncryption(BaseModel):
    """Object-level encryption configuration."""
    sse_algorithm: EncryptionType = Field(..., description="Server-side encryption algorithm")
    kms_key_id: Optional[str] = Field(None, description="KMS key ID")
    kms_context: Optional[Dict[str, str]] = Field(None, description="KMS encryption context")
    customer_key: Optional[str] = Field(None, description="Customer-provided encryption key", exclude=True)
    customer_key_md5: Optional[str] = Field(None, description="MD5 hash of customer key")


class EncryptionKey(BaseModel):
    """Encryption key information."""
    key_id: str = Field(..., description="Unique key identifier")
    key_alias: Optional[str] = Field(None, description="Key alias")
    key_type: str = Field(..., description="Key type (symmetric, asymmetric)")
    key_usage: str = Field(..., description="Key usage (encrypt, decrypt, sign)")
    key_spec: str = Field(..., description="Key specification")
    key_state: str = Field(..., description="Key state (enabled, disabled, deleted)")
    creation_date: datetime = Field(..., description="Key creation date")
    last_rotation_date: Optional[datetime] = Field(None, description="Last rotation date")
    next_rotation_date: Optional[datetime] = Field(None, description="Next scheduled rotation")
    key_manager: KeyManagementService = Field(..., description="Key management service")
    key_policy: Optional[Dict] = Field(None, description="Key policy document")


class AccessControlList(BaseModel):
    """Access Control List (ACL) configuration."""
    owner: str = Field(..., description="Resource owner")
    grants: List[Dict[str, str]] = Field(default_factory=list, description="Access grants")
    canned_acl: Optional[AccessControlType] = Field(None, description="Canned ACL")


class SecurityPolicy(BaseModel):
    """Security policy configuration."""
    policy_id: str = Field(..., description="Policy identifier")
    policy_name: str = Field(..., description="Policy name")
    description: Optional[str] = Field(None, description="Policy description")
    policy_type: str = Field(..., description="Policy type (bucket, object, user)")
    enforce_encryption: bool = Field(False, description="Enforce encryption")
    allowed_encryption_types: List[EncryptionType] = Field(default_factory=list)
    require_mfa: bool = Field(False, description="Require multi-factor authentication")
    allowed_ip_ranges: List[str] = Field(default_factory=list, description="Allowed IP ranges")
    denied_ip_ranges: List[str] = Field(default_factory=list, description="Denied IP ranges")
    max_object_size: Optional[int] = Field(None, description="Maximum object size in bytes")
    allowed_content_types: List[str] = Field(default_factory=list, description="Allowed content types")
    scan_for_malware: bool = Field(False, description="Enable malware scanning")
    data_classification_required: bool = Field(False, description="Require data classification")
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)


class SecurityEvent(BaseModel):
    """Security event record."""
    event_id: str = Field(..., description="Unique event identifier")
    event_type: SecurityEventType = Field(..., description="Type of security event")
    severity: ThreatLevel = Field(..., description="Event severity level")
    timestamp: datetime = Field(default_factory=datetime.utcnow)
    source_ip: Optional[str] = Field(None, description="Source IP address")
    user_agent: Optional[str] = Field(None, description="User agent string")
    username: Optional[str] = Field(None, description="Associated username")
    resource: Optional[str] = Field(None, description="Affected resource")
    action: Optional[str] = Field(None, description="Attempted action")
    result: str = Field(..., description="Event result (success, failure, blocked)")
    details: Dict[str, str] = Field(default_factory=dict, description="Additional event details")
    geolocation: Optional[Dict[str, str]] = Field(None, description="Geographic location data")
    risk_score: float = Field(0.0, ge=0.0, le=100.0, description="Risk score (0-100)")


class ThreatIntelligence(BaseModel):
    """Threat intelligence data."""
    indicator_id: str = Field(..., description="Threat indicator ID")
    indicator_type: str = Field(..., description="Indicator type (IP, domain, hash)")
    indicator_value: str = Field(..., description="Indicator value")
    threat_type: str = Field(..., description="Threat type (malware, phishing, etc.)")
    severity: ThreatLevel = Field(..., description="Threat severity")
    confidence: float = Field(..., ge=0.0, le=100.0, description="Confidence score")
    source: str = Field(..., description="Intelligence source")
    first_seen: datetime = Field(..., description="First seen timestamp")
    last_seen: datetime = Field(..., description="Last seen timestamp")
    is_active: bool = Field(True, description="Indicator active status")
    tags: List[str] = Field(default_factory=list, description="Threat tags")


class SecurityScan(BaseModel):
    """Security scan configuration and results."""
    scan_id: str = Field(..., description="Scan identifier")
    scan_type: str = Field(..., description="Scan type (malware, vulnerability, compliance)")
    target_bucket: Optional[str] = Field(None, description="Target bucket")
    target_object: Optional[str] = Field(None, description="Target object")
    scan_status: str = Field(..., description="Scan status (pending, running, completed, failed)")
    started_at: datetime = Field(default_factory=datetime.utcnow)
    completed_at: Optional[datetime] = Field(None, description="Completion timestamp")
    scan_results: Dict[str, Union[str, int, bool]] = Field(default_factory=dict)
    threats_found: int = Field(0, description="Number of threats found")
    quarantined_objects: List[str] = Field(default_factory=list, description="Quarantined object keys")
    scan_engine: str = Field(..., description="Scanning engine used")
    engine_version: str = Field(..., description="Engine version")


class ComplianceFramework(BaseModel):
    """Compliance framework configuration."""
    framework_id: str = Field(..., description="Framework identifier")
    framework_name: str = Field(..., description="Framework name (SOX, HIPAA, GDPR, etc.)")
    version: str = Field(..., description="Framework version")
    requirements: List[Dict[str, str]] = Field(default_factory=list, description="Compliance requirements")
    controls: List[Dict[str, str]] = Field(default_factory=list, description="Security controls")
    is_enabled: bool = Field(True, description="Framework enabled status")


class ComplianceAssessment(BaseModel):
    """Compliance assessment results."""
    assessment_id: str = Field(..., description="Assessment identifier")
    framework_id: str = Field(..., description="Associated framework")
    assessment_date: datetime = Field(default_factory=datetime.utcnow)
    scope: str = Field(..., description="Assessment scope")
    overall_score: float = Field(..., ge=0.0, le=100.0, description="Overall compliance score")
    compliant_controls: int = Field(..., description="Number of compliant controls")
    non_compliant_controls: int = Field(..., description="Number of non-compliant controls")
    findings: List[Dict[str, str]] = Field(default_factory=list, description="Assessment findings")
    recommendations: List[str] = Field(default_factory=list, description="Remediation recommendations")
    next_assessment_date: Optional[datetime] = Field(None, description="Next scheduled assessment")


# Request/Response Models
class EnableEncryptionRequest(BaseModel):
    """Enable encryption request."""
    bucket_name: str = Field(..., description="Bucket name")
    encryption_config: BucketEncryption = Field(..., description="Encryption configuration")


class CreateSecurityPolicyRequest(BaseModel):
    """Create security policy request."""
    policy: SecurityPolicy = Field(..., description="Security policy")


class SecurityEventQuery(BaseModel):
    """Security event query parameters."""
    start_time: datetime = Field(..., description="Query start time")
    end_time: datetime = Field(..., description="Query end time")
    event_types: Optional[List[SecurityEventType]] = Field(None, description="Filter by event types")
    severity_levels: Optional[List[ThreatLevel]] = Field(None, description="Filter by severity")
    username: Optional[str] = Field(None, description="Filter by username")
    source_ip: Optional[str] = Field(None, description="Filter by source IP")
    min_risk_score: Optional[float] = Field(None, ge=0.0, le=100.0, description="Minimum risk score")


class SecurityDashboard(BaseModel):
    """Security dashboard data."""
    total_events_24h: int = Field(..., description="Total events in last 24 hours")
    high_severity_events: int = Field(..., description="High severity events")
    failed_logins: int = Field(..., description="Failed login attempts")
    blocked_requests: int = Field(..., description="Blocked requests")
    active_threats: int = Field(..., description="Active threat indicators")
    compliance_score: float = Field(..., ge=0.0, le=100.0, description="Overall compliance score")
    encrypted_buckets: int = Field(..., description="Number of encrypted buckets")
    unencrypted_buckets: int = Field(..., description="Number of unencrypted buckets")
    recent_events: List[SecurityEvent] = Field(default_factory=list, description="Recent security events")
    threat_trends: Dict[str, int] = Field(default_factory=dict, description="Threat trends by type")
    geographic_threats: Dict[str, int] = Field(default_factory=dict, description="Threats by country")
    generated_at: datetime = Field(default_factory=datetime.utcnow)


class SecurityRecommendation(BaseModel):
    """Security recommendation."""
    recommendation_id: str = Field(..., description="Recommendation ID")
    title: str = Field(..., description="Recommendation title")
    description: str = Field(..., description="Detailed description")
    severity: ThreatLevel = Field(..., description="Recommendation severity")
    category: str = Field(..., description="Recommendation category")
    affected_resources: List[str] = Field(default_factory=list, description="Affected resources")
    remediation_steps: List[str] = Field(default_factory=list, description="Remediation steps")
    estimated_effort: str = Field(..., description="Estimated effort (low, medium, high)")
    compliance_impact: List[str] = Field(default_factory=list, description="Compliance frameworks affected")
    created_at: datetime = Field(default_factory=datetime.utcnow)
    due_date: Optional[datetime] = Field(None, description="Recommended completion date")
    status: str = Field("open", description="Recommendation status")

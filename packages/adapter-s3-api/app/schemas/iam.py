"""IAM and Policy Management schemas."""

from datetime import datetime
from enum import Enum
from typing import Dict, List, Optional, Union
from pydantic import BaseModel, Field, field_validator


class PolicyEffect(str, Enum):
    """Policy effect enumeration."""
    ALLOW = "Allow"
    DENY = "Deny"


class S3Action(str, Enum):
    """S3 Actions supported by MinIO."""
    # Object Operations
    GET_OBJECT = "s3:GetObject"
    PUT_OBJECT = "s3:PutObject"
    DELETE_OBJECT = "s3:DeleteObject"
    LIST_OBJECTS = "s3:ListBucket"
    
    # Bucket Operations
    CREATE_BUCKET = "s3:CreateBucket"
    DELETE_BUCKET = "s3:DeleteBucket"
    GET_BUCKET_LOCATION = "s3:GetBucketLocation"
    LIST_ALL_BUCKETS = "s3:ListAllMyBuckets"
    
    # Versioning and Retention
    PUT_OBJECT_LEGAL_HOLD = "s3:PutObjectLegalHold"
    GET_OBJECT_LEGAL_HOLD = "s3:GetObjectLegalHold"
    PUT_OBJECT_RETENTION = "s3:PutObjectRetention"
    GET_OBJECT_RETENTION = "s3:GetObjectRetention"
    GET_BUCKET_OBJECT_LOCK_CONFIGURATION = "s3:GetBucketObjectLockConfiguration"
    PUT_BUCKET_OBJECT_LOCK_CONFIGURATION = "s3:PutBucketObjectLockConfiguration"
    
    # Lifecycle Management
    PUT_LIFECYCLE_CONFIGURATION = "s3:PutLifecycleConfiguration"
    GET_LIFECYCLE_CONFIGURATION = "s3:GetLifecycleConfiguration"
    
    # Encryption
    PUT_ENCRYPTION_CONFIGURATION = "s3:PutEncryptionConfiguration"
    GET_ENCRYPTION_CONFIGURATION = "s3:GetEncryptionConfiguration"
    
    # Replication
    GET_REPLICATION_CONFIGURATION = "s3:GetReplicationConfiguration"
    PUT_REPLICATION_CONFIGURATION = "s3:PutReplicationConfiguration"
    REPLICATE_OBJECT = "s3:ReplicateObject"
    REPLICATE_DELETE = "s3:ReplicateDelete"
    REPLICATE_TAGS = "s3:ReplicateTags"
    
    # Notifications
    GET_BUCKET_NOTIFICATION = "s3:GetBucketNotification"
    PUT_BUCKET_NOTIFICATION = "s3:PutBucketNotification"
    LISTEN_NOTIFICATION = "s3:ListenNotification"
    LISTEN_BUCKET_NOTIFICATION = "s3:ListenBucketNotification"
    
    # Multipart Upload
    ABORT_MULTIPART_UPLOAD = "s3:AbortMultipartUpload"
    LIST_MULTIPART_UPLOAD_PARTS = "s3:ListMultipartUploadParts"
    LIST_BUCKET_MULTIPART_UPLOADS = "s3:ListBucketMultipartUploads"


class PolicyCondition(BaseModel):
    """IAM Policy condition."""
    condition_type: str = Field(..., description="Condition type (e.g., StringEquals, IpAddress)")
    key: str = Field(..., description="Condition key")
    values: Union[str, List[str]] = Field(..., description="Condition values")


class PolicyStatement(BaseModel):
    """IAM Policy statement."""
    sid: Optional[str] = Field(None, description="Statement ID")
    effect: PolicyEffect = Field(..., description="Allow or Deny")
    actions: List[Union[S3Action, str]] = Field(..., description="List of actions")
    resources: List[str] = Field(..., description="List of resource ARNs")
    conditions: Optional[Dict[str, Dict[str, Union[str, List[str]]]]] = Field(
        None, description="Policy conditions"
    )
    
    @field_validator('resources')
    @classmethod
    def validate_resources(cls, v):
        """Validate resource ARN format."""
        for resource in v:
            if not (resource.startswith('arn:aws:s3:::') or resource == '*'):
                raise ValueError(f"Invalid resource ARN format: {resource}")
        return v


class IAMPolicy(BaseModel):
    """IAM Policy document."""
    version: str = Field("2012-10-17", description="Policy language version")
    id: Optional[str] = Field(None, description="Policy ID")
    statements: List[PolicyStatement] = Field(..., alias="Statement")
    
    model_config = {"populate_by_name": True}


class User(BaseModel):
    """IAM User."""
    username: str = Field(..., description="Unique username")
    email: Optional[str] = Field(None, description="User email")
    full_name: Optional[str] = Field(None, description="Full display name")
    access_key: Optional[str] = Field(None, description="S3 access key")
    secret_key: Optional[str] = Field(None, description="S3 secret key", exclude=True)
    policies: List[str] = Field(default_factory=list, description="Attached policy names")
    groups: List[str] = Field(default_factory=list, description="User groups")
    tags: Dict[str, str] = Field(default_factory=dict, description="User tags")
    created_at: datetime = Field(default_factory=datetime.utcnow)
    last_login: Optional[datetime] = Field(None, description="Last login timestamp")
    is_active: bool = Field(True, description="User active status")
    mfa_enabled: bool = Field(False, description="Multi-factor authentication enabled")


class Group(BaseModel):
    """IAM Group."""
    name: str = Field(..., description="Group name")
    description: Optional[str] = Field(None, description="Group description")
    policies: List[str] = Field(default_factory=list, description="Attached policy names")
    users: List[str] = Field(default_factory=list, description="Group members")
    created_at: datetime = Field(default_factory=datetime.utcnow)


class Role(BaseModel):
    """IAM Role."""
    name: str = Field(..., description="Role name")
    description: Optional[str] = Field(None, description="Role description")
    assume_role_policy: IAMPolicy = Field(..., description="Trust policy")
    policies: List[str] = Field(default_factory=list, description="Attached policy names")
    max_session_duration: int = Field(3600, description="Maximum session duration in seconds")
    created_at: datetime = Field(default_factory=datetime.utcnow)


class AccessKey(BaseModel):
    """IAM Access Key."""
    access_key_id: str = Field(..., description="Access key ID")
    secret_access_key: str = Field(..., description="Secret access key", exclude=True)
    status: str = Field("Active", description="Key status (Active/Inactive)")
    created_at: datetime = Field(default_factory=datetime.utcnow)
    last_used: Optional[datetime] = Field(None, description="Last used timestamp")
    username: str = Field(..., description="Associated username")


class PolicyAttachment(BaseModel):
    """Policy attachment to user/group/role."""
    policy_name: str = Field(..., description="Policy name")
    entity_type: str = Field(..., description="Entity type (user/group/role)")
    entity_name: str = Field(..., description="Entity name")
    attached_at: datetime = Field(default_factory=datetime.utcnow)


# Request/Response Models
class CreateUserRequest(BaseModel):
    """Create user request."""
    username: str = Field(..., min_length=1, max_length=64)
    email: Optional[str] = None
    full_name: Optional[str] = None
    generate_access_key: bool = Field(True, description="Generate access key pair")
    policies: List[str] = Field(default_factory=list)
    groups: List[str] = Field(default_factory=list)
    tags: Dict[str, str] = Field(default_factory=dict)


class CreateUserResponse(BaseModel):
    """Create user response."""
    user: User
    access_key: Optional[AccessKey] = None


class CreatePolicyRequest(BaseModel):
    """Create policy request."""
    name: str = Field(..., min_length=1, max_length=128)
    description: Optional[str] = None
    policy_document: IAMPolicy


class AttachPolicyRequest(BaseModel):
    """Attach policy request."""
    policy_name: str
    entity_type: str = Field(..., pattern="^(user|group|role)$")
    entity_name: str


class UserListResponse(BaseModel):
    """User list response."""
    users: list = Field(default_factory=list, description="List of users")
    total_count: int
    page: int
    page_size: int


class PolicyListResponse(BaseModel):
    """Policy list response."""
    policies: list = Field(default_factory=list, description="List of policies")
    total_count: int
    page: int
    page_size: int

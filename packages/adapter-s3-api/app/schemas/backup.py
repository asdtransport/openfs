"""Backup and disaster recovery schemas."""

from datetime import datetime, timedelta
from enum import Enum
from typing import Dict, List, Optional, Union
from pydantic import BaseModel, Field, validator


class BackupType(str, Enum):
    """Backup types."""
    FULL = "full"
    INCREMENTAL = "incremental"
    DIFFERENTIAL = "differential"
    SNAPSHOT = "snapshot"
    CONTINUOUS = "continuous"


class BackupStatus(str, Enum):
    """Backup status."""
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"
    EXPIRED = "expired"


class RestoreStatus(str, Enum):
    """Restore operation status."""
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"
    VALIDATING = "validating"


class BackupDestination(str, Enum):
    """Backup destination types."""
    S3 = "s3"
    AZURE_BLOB = "azure_blob"
    GOOGLE_CLOUD = "google_cloud"
    LOCAL_DISK = "local_disk"
    NETWORK_SHARE = "network_share"
    TAPE = "tape"
    GLACIER = "glacier"
    DEEP_ARCHIVE = "deep_archive"


class RecoveryPointObjective(str, Enum):
    """Recovery Point Objective (RPO) levels."""
    MINUTES_15 = "15_minutes"
    HOUR_1 = "1_hour"
    HOURS_4 = "4_hours"
    HOURS_12 = "12_hours"
    DAY_1 = "1_day"
    DAYS_7 = "7_days"
    DAYS_30 = "30_days"


class RecoveryTimeObjective(str, Enum):
    """Recovery Time Objective (RTO) levels."""
    MINUTES_15 = "15_minutes"
    HOUR_1 = "1_hour"
    HOURS_4 = "4_hours"
    HOURS_12 = "12_hours"
    DAY_1 = "1_day"
    DAYS_3 = "3_days"


class BackupRetentionPolicy(BaseModel):
    """Backup retention policy."""
    daily_retention_days: int = Field(7, ge=1, le=365, description="Daily backup retention in days")
    weekly_retention_weeks: int = Field(4, ge=1, le=52, description="Weekly backup retention in weeks")
    monthly_retention_months: int = Field(12, ge=1, le=120, description="Monthly backup retention in months")
    yearly_retention_years: int = Field(7, ge=1, le=50, description="Yearly backup retention in years")
    legal_hold_enabled: bool = Field(False, description="Legal hold enabled")
    compliance_retention_days: Optional[int] = Field(None, description="Compliance retention period")


class BackupConfiguration(BaseModel):
    """Backup configuration."""
    config_id: str = Field(..., description="Configuration identifier")
    name: str = Field(..., description="Configuration name")
    description: Optional[str] = Field(None, description="Configuration description")
    bucket_name: str = Field(..., description="Source bucket")
    object_prefix: Optional[str] = Field(None, description="Object prefix filter")
    backup_type: BackupType = Field(..., description="Backup type")
    destination: BackupDestination = Field(..., description="Backup destination")
    destination_config: Dict[str, str] = Field(default_factory=dict, description="Destination configuration")
    schedule_cron: str = Field(..., description="Backup schedule (cron expression)")
    retention_policy: BackupRetentionPolicy = Field(..., description="Retention policy")
    encryption_enabled: bool = Field(True, description="Encryption enabled")
    compression_enabled: bool = Field(True, description="Compression enabled")
    verification_enabled: bool = Field(True, description="Backup verification enabled")
    bandwidth_limit_mbps: Optional[int] = Field(None, description="Bandwidth limit in Mbps")
    parallel_transfers: int = Field(4, ge=1, le=16, description="Number of parallel transfers")
    is_enabled: bool = Field(True, description="Configuration enabled")
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)
    last_backup: Optional[datetime] = Field(None, description="Last backup timestamp")
    next_backup: Optional[datetime] = Field(None, description="Next scheduled backup")


class BackupJob(BaseModel):
    """Backup job execution."""
    job_id: str = Field(..., description="Job identifier")
    config_id: str = Field(..., description="Associated configuration ID")
    backup_type: BackupType = Field(..., description="Backup type")
    status: BackupStatus = Field(BackupStatus.PENDING, description="Job status")
    started_at: Optional[datetime] = Field(None, description="Job start time")
    completed_at: Optional[datetime] = Field(None, description="Job completion time")
    duration_seconds: Optional[int] = Field(None, description="Job duration in seconds")
    total_objects: int = Field(0, description="Total objects to backup")
    processed_objects: int = Field(0, description="Objects processed")
    successful_objects: int = Field(0, description="Successfully backed up objects")
    failed_objects: int = Field(0, description="Failed objects")
    skipped_objects: int = Field(0, description="Skipped objects (unchanged)")
    total_size_bytes: int = Field(0, description="Total data size in bytes")
    transferred_bytes: int = Field(0, description="Bytes transferred")
    compression_ratio: Optional[float] = Field(None, description="Compression ratio")
    backup_location: Optional[str] = Field(None, description="Backup storage location")
    verification_status: Optional[str] = Field(None, description="Verification status")
    error_messages: List[str] = Field(default_factory=list, description="Error messages")
    warnings: List[str] = Field(default_factory=list, description="Warning messages")
    metadata: Dict[str, str] = Field(default_factory=dict, description="Additional metadata")


class BackupCatalog(BaseModel):
    """Backup catalog entry."""
    catalog_id: str = Field(..., description="Catalog entry identifier")
    job_id: str = Field(..., description="Associated backup job ID")
    config_id: str = Field(..., description="Associated configuration ID")
    backup_name: str = Field(..., description="Backup name")
    backup_type: BackupType = Field(..., description="Backup type")
    created_at: datetime = Field(..., description="Backup creation time")
    expires_at: Optional[datetime] = Field(None, description="Backup expiration time")
    size_bytes: int = Field(..., description="Backup size in bytes")
    object_count: int = Field(..., description="Number of objects in backup")
    checksum: str = Field(..., description="Backup checksum")
    encryption_key_id: Optional[str] = Field(None, description="Encryption key identifier")
    storage_location: str = Field(..., description="Storage location")
    tags: Dict[str, str] = Field(default_factory=dict, description="Backup tags")
    is_verified: bool = Field(False, description="Backup verification status")
    verification_date: Optional[datetime] = Field(None, description="Last verification date")
    parent_backup_id: Optional[str] = Field(None, description="Parent backup for incrementals")
    dependencies: List[str] = Field(default_factory=list, description="Backup dependencies")


class RestoreJob(BaseModel):
    """Restore job configuration and status."""
    restore_id: str = Field(..., description="Restore job identifier")
    catalog_id: str = Field(..., description="Source backup catalog ID")
    restore_type: str = Field(..., description="Restore type (full, partial, point-in-time)")
    target_bucket: str = Field(..., description="Target bucket for restore")
    target_prefix: Optional[str] = Field(None, description="Target object prefix")
    object_filters: List[str] = Field(default_factory=list, description="Object filters for partial restore")
    point_in_time: Optional[datetime] = Field(None, description="Point-in-time for restore")
    overwrite_existing: bool = Field(False, description="Overwrite existing objects")
    preserve_metadata: bool = Field(True, description="Preserve object metadata")
    status: RestoreStatus = Field(RestoreStatus.PENDING, description="Restore status")
    started_at: Optional[datetime] = Field(None, description="Restore start time")
    completed_at: Optional[datetime] = Field(None, description="Restore completion time")
    duration_seconds: Optional[int] = Field(None, description="Restore duration")
    total_objects: int = Field(0, description="Total objects to restore")
    restored_objects: int = Field(0, description="Objects restored")
    failed_objects: int = Field(0, description="Failed objects")
    skipped_objects: int = Field(0, description="Skipped objects")
    total_size_bytes: int = Field(0, description="Total data size")
    transferred_bytes: int = Field(0, description="Bytes transferred")
    error_messages: List[str] = Field(default_factory=list, description="Error messages")
    created_by: str = Field(..., description="User who initiated restore")


class DisasterRecoveryPlan(BaseModel):
    """Disaster recovery plan."""
    plan_id: str = Field(..., description="Plan identifier")
    name: str = Field(..., description="Plan name")
    description: Optional[str] = Field(None, description="Plan description")
    scope: List[str] = Field(..., description="Buckets covered by the plan")
    rpo: RecoveryPointObjective = Field(..., description="Recovery Point Objective")
    rto: RecoveryTimeObjective = Field(..., description="Recovery Time Objective")
    backup_configs: List[str] = Field(..., description="Associated backup configuration IDs")
    recovery_procedures: List[Dict[str, str]] = Field(
        default_factory=list, description="Recovery procedures"
    )
    contact_list: List[Dict[str, str]] = Field(default_factory=list, description="Emergency contacts")
    testing_schedule: str = Field(..., description="DR testing schedule")
    last_test_date: Optional[datetime] = Field(None, description="Last DR test date")
    test_results: Optional[Dict[str, str]] = Field(None, description="Last test results")
    is_active: bool = Field(True, description="Plan active status")
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)


class BackupHealth(BaseModel):
    """Backup system health status."""
    overall_health: str = Field(..., description="Overall health status")
    active_configs: int = Field(..., description="Number of active backup configurations")
    failed_jobs_24h: int = Field(..., description="Failed jobs in last 24 hours")
    successful_jobs_24h: int = Field(..., description="Successful jobs in last 24 hours")
    total_backup_size_gb: float = Field(..., description="Total backup size in GB")
    oldest_backup_age_days: int = Field(..., description="Age of oldest backup in days")
    newest_backup_age_hours: int = Field(..., description="Age of newest backup in hours")
    storage_utilization_percent: float = Field(..., description="Storage utilization percentage")
    average_backup_duration_minutes: float = Field(..., description="Average backup duration")
    compliance_status: str = Field(..., description="Compliance status")
    issues: List[str] = Field(default_factory=list, description="Current issues")
    recommendations: List[str] = Field(default_factory=list, description="Recommendations")
    generated_at: datetime = Field(default_factory=datetime.utcnow)


class BackupReport(BaseModel):
    """Backup report."""
    report_id: str = Field(..., description="Report identifier")
    report_type: str = Field(..., description="Report type")
    period_start: datetime = Field(..., description="Report period start")
    period_end: datetime = Field(..., description="Report period end")
    total_backups: int = Field(..., description="Total backups in period")
    successful_backups: int = Field(..., description="Successful backups")
    failed_backups: int = Field(..., description="Failed backups")
    total_data_backed_up_gb: float = Field(..., description="Total data backed up in GB")
    storage_cost_estimate: float = Field(..., description="Estimated storage cost")
    compliance_score: float = Field(..., ge=0.0, le=100.0, description="Compliance score")
    rpo_violations: int = Field(..., description="RPO violations")
    rto_violations: int = Field(..., description="RTO violations")
    backup_trends: Dict[str, int] = Field(default_factory=dict, description="Backup trends")
    top_issues: List[str] = Field(default_factory=list, description="Top issues encountered")
    recommendations: List[str] = Field(default_factory=list, description="Recommendations")
    generated_at: datetime = Field(default_factory=datetime.utcnow)


# Request/Response Models
class CreateBackupConfigRequest(BaseModel):
    """Create backup configuration request."""
    config: BackupConfiguration = Field(..., description="Backup configuration")


class StartBackupJobRequest(BaseModel):
    """Start backup job request."""
    config_id: str = Field(..., description="Configuration ID")
    backup_type: Optional[BackupType] = Field(None, description="Override backup type")
    force_full_backup: bool = Field(False, description="Force full backup")


class StartRestoreJobRequest(BaseModel):
    """Start restore job request."""
    restore_job: RestoreJob = Field(..., description="Restore job configuration")


class CreateDRPlanRequest(BaseModel):
    """Create disaster recovery plan request."""
    plan: DisasterRecoveryPlan = Field(..., description="DR plan configuration")


class BackupSearchQuery(BaseModel):
    """Backup search query."""
    bucket_name: Optional[str] = Field(None, description="Filter by bucket")
    backup_type: Optional[BackupType] = Field(None, description="Filter by backup type")
    date_from: Optional[datetime] = Field(None, description="Date range start")
    date_to: Optional[datetime] = Field(None, description="Date range end")
    status: Optional[BackupStatus] = Field(None, description="Filter by status")
    tags: Optional[Dict[str, str]] = Field(None, description="Filter by tags")
    limit: int = Field(50, ge=1, le=500, description="Maximum results")
    offset: int = Field(0, ge=0, description="Result offset")


class BackupSearchResponse(BaseModel):
    """Backup search response."""
    backups: List[BackupCatalog] = Field(..., description="Matching backups")
    total_count: int = Field(..., description="Total matching backups")
    has_more: bool = Field(..., description="More results available")


class BackupValidationResult(BaseModel):
    """Backup validation result."""
    validation_id: str = Field(..., description="Validation identifier")
    catalog_id: str = Field(..., description="Validated backup catalog ID")
    validation_type: str = Field(..., description="Validation type")
    status: str = Field(..., description="Validation status")
    started_at: datetime = Field(..., description="Validation start time")
    completed_at: Optional[datetime] = Field(None, description="Validation completion time")
    total_objects_checked: int = Field(..., description="Total objects checked")
    valid_objects: int = Field(..., description="Valid objects")
    invalid_objects: int = Field(..., description="Invalid objects")
    missing_objects: int = Field(..., description="Missing objects")
    checksum_mismatches: int = Field(..., description="Checksum mismatches")
    issues_found: List[str] = Field(default_factory=list, description="Issues found")
    overall_integrity: float = Field(..., ge=0.0, le=100.0, description="Overall integrity percentage")


class BackupMetrics(BaseModel):
    """Backup metrics and statistics."""
    total_backup_configs: int = Field(..., description="Total backup configurations")
    active_backup_configs: int = Field(..., description="Active backup configurations")
    total_backup_jobs: int = Field(..., description="Total backup jobs")
    successful_jobs_rate: float = Field(..., description="Success rate percentage")
    average_backup_size_gb: float = Field(..., description="Average backup size in GB")
    total_storage_used_tb: float = Field(..., description="Total storage used in TB")
    monthly_storage_growth_gb: float = Field(..., description="Monthly storage growth in GB")
    average_rpo_hours: float = Field(..., description="Average RPO in hours")
    average_rto_hours: float = Field(..., description="Average RTO in hours")
    compliance_violations: int = Field(..., description="Compliance violations")
    cost_per_gb_month: float = Field(..., description="Cost per GB per month")
    generated_at: datetime = Field(default_factory=datetime.utcnow)

"""Advanced analytics and reporting schemas."""

from datetime import datetime, timedelta
from enum import Enum
from typing import Dict, List, Optional, Union
from pydantic import BaseModel, Field


class MetricType(str, Enum):
    """Metric type enumeration."""
    STORAGE_USAGE = "storage_usage"
    REQUEST_COUNT = "request_count"
    BANDWIDTH = "bandwidth"
    ERROR_RATE = "error_rate"
    RESPONSE_TIME = "response_time"
    ACTIVE_USERS = "active_users"
    OBJECT_COUNT = "object_count"
    BUCKET_COUNT = "bucket_count"


class TimeGranularity(str, Enum):
    """Time granularity for metrics."""
    MINUTE = "1m"
    HOUR = "1h"
    DAY = "1d"
    WEEK = "1w"
    MONTH = "1M"


class RequestType(str, Enum):
    """S3 request types."""
    GET = "GET"
    PUT = "PUT"
    DELETE = "DELETE"
    HEAD = "HEAD"
    LIST = "LIST"
    POST = "POST"


class StorageClass(str, Enum):
    """Storage class types."""
    STANDARD = "STANDARD"
    REDUCED_REDUNDANCY = "REDUCED_REDUNDANCY"
    COLD = "COLD"
    GLACIER = "GLACIER"


class DataPoint(BaseModel):
    """Single data point in a time series."""
    timestamp: datetime = Field(..., description="Data point timestamp")
    value: Union[int, float] = Field(..., description="Metric value")
    labels: Dict[str, str] = Field(default_factory=dict, description="Additional labels")


class TimeSeries(BaseModel):
    """Time series data."""
    metric_name: str = Field(..., description="Metric name")
    metric_type: MetricType = Field(..., description="Metric type")
    unit: str = Field(..., description="Metric unit (bytes, requests, ms, etc.)")
    data_points: List[DataPoint] = Field(..., description="Time series data points")
    start_time: datetime = Field(..., description="Series start time")
    end_time: datetime = Field(..., description="Series end time")
    granularity: TimeGranularity = Field(..., description="Data granularity")


class UsageMetrics(BaseModel):
    """Storage usage metrics."""
    total_storage_bytes: int = Field(..., description="Total storage used in bytes")
    total_objects: int = Field(..., description="Total number of objects")
    total_buckets: int = Field(..., description="Total number of buckets")
    storage_by_class: Dict[StorageClass, int] = Field(default_factory=dict)
    largest_bucket: Optional[str] = Field(None, description="Name of largest bucket")
    largest_bucket_size: int = Field(0, description="Size of largest bucket")
    average_object_size: float = Field(0.0, description="Average object size")
    storage_growth_rate: float = Field(0.0, description="Storage growth rate percentage")


class RequestMetrics(BaseModel):
    """Request metrics."""
    total_requests: int = Field(..., description="Total requests")
    requests_by_type: Dict[RequestType, int] = Field(default_factory=dict)
    successful_requests: int = Field(..., description="Successful requests (2xx)")
    client_errors: int = Field(..., description="Client errors (4xx)")
    server_errors: int = Field(..., description="Server errors (5xx)")
    average_response_time: float = Field(..., description="Average response time in ms")
    p95_response_time: float = Field(..., description="95th percentile response time")
    p99_response_time: float = Field(..., description="99th percentile response time")
    requests_per_second: float = Field(..., description="Average requests per second")


class BandwidthMetrics(BaseModel):
    """Bandwidth metrics."""
    total_bytes_uploaded: int = Field(..., description="Total bytes uploaded")
    total_bytes_downloaded: int = Field(..., description="Total bytes downloaded")
    upload_bandwidth_mbps: float = Field(..., description="Average upload bandwidth Mbps")
    download_bandwidth_mbps: float = Field(..., description="Average download bandwidth Mbps")
    peak_upload_bandwidth: float = Field(..., description="Peak upload bandwidth Mbps")
    peak_download_bandwidth: float = Field(..., description="Peak download bandwidth Mbps")


class UserActivityMetrics(BaseModel):
    """User activity metrics."""
    total_users: int = Field(..., description="Total number of users")
    active_users_daily: int = Field(..., description="Daily active users")
    active_users_weekly: int = Field(..., description="Weekly active users")
    active_users_monthly: int = Field(..., description="Monthly active users")
    top_users_by_requests: List[Dict[str, Union[str, int]]] = Field(default_factory=list)
    top_users_by_storage: List[Dict[str, Union[str, int]]] = Field(default_factory=list)
    new_users_today: int = Field(0, description="New users registered today")


class BucketAnalytics(BaseModel):
    """Per-bucket analytics."""
    bucket_name: str = Field(..., description="Bucket name")
    object_count: int = Field(..., description="Number of objects")
    total_size: int = Field(..., description="Total size in bytes")
    average_object_size: float = Field(..., description="Average object size")
    last_modified: datetime = Field(..., description="Last modification time")
    request_count: int = Field(..., description="Total requests to bucket")
    bandwidth_usage: int = Field(..., description="Bandwidth usage in bytes")
    storage_class_distribution: Dict[StorageClass, int] = Field(default_factory=dict)
    top_objects: List[Dict[str, Union[str, int]]] = Field(default_factory=list)
    access_patterns: Dict[str, int] = Field(default_factory=dict)


class SystemHealthMetrics(BaseModel):
    """System health metrics."""
    cpu_usage_percent: float = Field(..., description="CPU usage percentage")
    memory_usage_percent: float = Field(..., description="Memory usage percentage")
    disk_usage_percent: float = Field(..., description="Disk usage percentage")
    network_io_bytes: int = Field(..., description="Network I/O bytes")
    disk_io_bytes: int = Field(..., description="Disk I/O bytes")
    active_connections: int = Field(..., description="Active connections")
    uptime_seconds: int = Field(..., description="System uptime in seconds")
    error_rate: float = Field(..., description="Error rate percentage")
    availability_percent: float = Field(..., description="System availability percentage")


class ComplianceReport(BaseModel):
    """Compliance and audit report."""
    report_id: str = Field(..., description="Unique report ID")
    generated_at: datetime = Field(default_factory=datetime.utcnow)
    report_period_start: datetime = Field(..., description="Report period start")
    report_period_end: datetime = Field(..., description="Report period end")
    total_objects_audited: int = Field(..., description="Total objects audited")
    compliant_objects: int = Field(..., description="Compliant objects")
    non_compliant_objects: int = Field(..., description="Non-compliant objects")
    compliance_percentage: float = Field(..., description="Compliance percentage")
    violations: List[Dict[str, str]] = Field(default_factory=list, description="Compliance violations")
    recommendations: List[str] = Field(default_factory=list, description="Compliance recommendations")


class CostAnalysis(BaseModel):
    """Cost analysis report."""
    total_storage_cost: float = Field(..., description="Total storage cost")
    total_request_cost: float = Field(..., description="Total request cost")
    total_bandwidth_cost: float = Field(..., description="Total bandwidth cost")
    cost_by_bucket: Dict[str, float] = Field(default_factory=dict)
    cost_by_storage_class: Dict[StorageClass, float] = Field(default_factory=dict)
    cost_by_user: Dict[str, float] = Field(default_factory=dict)
    projected_monthly_cost: float = Field(..., description="Projected monthly cost")
    cost_optimization_suggestions: List[str] = Field(default_factory=list)


# Request/Response Models
class AnalyticsQuery(BaseModel):
    """Analytics query parameters."""
    metric_types: List[MetricType] = Field(..., description="Metrics to query")
    start_time: datetime = Field(..., description="Query start time")
    end_time: datetime = Field(..., description="Query end time")
    granularity: TimeGranularity = Field(TimeGranularity.HOUR, description="Data granularity")
    bucket_filter: Optional[str] = Field(None, description="Filter by bucket name")
    user_filter: Optional[str] = Field(None, description="Filter by user")
    group_by: Optional[List[str]] = Field(None, description="Group by dimensions")


class DashboardData(BaseModel):
    """Dashboard data response."""
    usage_metrics: UsageMetrics
    request_metrics: RequestMetrics
    bandwidth_metrics: BandwidthMetrics
    user_activity: UserActivityMetrics
    system_health: SystemHealthMetrics
    top_buckets: List[BucketAnalytics]
    recent_activity: List[Dict[str, str]]
    alerts: List[Dict[str, str]]
    generated_at: datetime = Field(default_factory=datetime.utcnow)


class ReportRequest(BaseModel):
    """Report generation request."""
    report_type: str = Field(..., description="Type of report to generate")
    start_date: datetime = Field(..., description="Report start date")
    end_date: datetime = Field(..., description="Report end date")
    filters: Dict[str, str] = Field(default_factory=dict, description="Report filters")
    format: str = Field("json", description="Report format (json, csv, pdf)")
    email_recipients: List[str] = Field(default_factory=list, description="Email recipients")


class AlertRule(BaseModel):
    """Alert rule configuration."""
    rule_id: str = Field(..., description="Unique rule ID")
    name: str = Field(..., description="Alert rule name")
    description: Optional[str] = Field(None, description="Rule description")
    metric_type: MetricType = Field(..., description="Metric to monitor")
    threshold: float = Field(..., description="Alert threshold")
    comparison: str = Field(..., description="Comparison operator (>, <, ==, etc.)")
    duration: int = Field(..., description="Duration in seconds before alerting")
    enabled: bool = Field(True, description="Rule enabled status")
    notification_channels: List[str] = Field(default_factory=list, description="Notification channels")
    created_at: datetime = Field(default_factory=datetime.utcnow)
    last_triggered: Optional[datetime] = Field(None, description="Last trigger time")

"""Advanced search and indexing schemas."""

from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Optional, Union
from pydantic import BaseModel, Field, validator


class SearchIndexType(str, Enum):
    """Search index types."""
    METADATA = "metadata"
    CONTENT = "content"
    TAGS = "tags"
    FULL_TEXT = "full_text"
    GEOSPATIAL = "geospatial"
    TEMPORAL = "temporal"


class SearchOperator(str, Enum):
    """Search operators."""
    AND = "AND"
    OR = "OR"
    NOT = "NOT"
    EQUALS = "="
    NOT_EQUALS = "!="
    GREATER_THAN = ">"
    LESS_THAN = "<"
    GREATER_EQUAL = ">="
    LESS_EQUAL = "<="
    CONTAINS = "CONTAINS"
    STARTS_WITH = "STARTS_WITH"
    ENDS_WITH = "ENDS_WITH"
    REGEX = "REGEX"
    FUZZY = "FUZZY"
    RANGE = "RANGE"
    IN = "IN"
    NOT_IN = "NOT_IN"


class SortOrder(str, Enum):
    """Sort order."""
    ASC = "asc"
    DESC = "desc"


class IndexStatus(str, Enum):
    """Index status."""
    CREATING = "creating"
    ACTIVE = "active"
    UPDATING = "updating"
    DELETING = "deleting"
    FAILED = "failed"


class ContentType(str, Enum):
    """Supported content types for indexing."""
    TEXT = "text/plain"
    PDF = "application/pdf"
    WORD = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    EXCEL = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    POWERPOINT = "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    JSON = "application/json"
    XML = "application/xml"
    CSV = "text/csv"
    HTML = "text/html"
    MARKDOWN = "text/markdown"


class SearchField(BaseModel):
    """Search field definition."""
    name: str = Field(..., description="Field name")
    type: str = Field(..., description="Field type (string, number, date, boolean)")
    indexed: bool = Field(True, description="Field is indexed")
    stored: bool = Field(True, description="Field value is stored")
    analyzed: bool = Field(False, description="Field is analyzed for full-text search")
    boost: float = Field(1.0, description="Field boost factor for relevance scoring")
    faceted: bool = Field(False, description="Field supports faceted search")


class SearchIndex(BaseModel):
    """Search index configuration."""
    index_id: str = Field(..., description="Index identifier")
    index_name: str = Field(..., description="Index name")
    description: Optional[str] = Field(None, description="Index description")
    index_type: SearchIndexType = Field(..., description="Index type")
    bucket_name: str = Field(..., description="Associated bucket")
    object_prefix: Optional[str] = Field(None, description="Object prefix filter")
    content_types: List[ContentType] = Field(default_factory=list, description="Supported content types")
    fields: List[SearchField] = Field(..., description="Index fields")
    settings: Dict[str, Any] = Field(default_factory=dict, description="Index settings")
    status: IndexStatus = Field(IndexStatus.CREATING, description="Index status")
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)
    last_indexed: Optional[datetime] = Field(None, description="Last indexing timestamp")
    document_count: int = Field(0, description="Number of indexed documents")
    index_size_bytes: int = Field(0, description="Index size in bytes")


class SearchCondition(BaseModel):
    """Search condition."""
    field: str = Field(..., description="Field name")
    operator: SearchOperator = Field(..., description="Search operator")
    value: Union[str, int, float, bool, List[Any]] = Field(..., description="Search value")
    boost: Optional[float] = Field(None, description="Condition boost factor")


class SearchQuery(BaseModel):
    """Advanced search query."""
    query_id: Optional[str] = Field(None, description="Query identifier for caching")
    index_name: Optional[str] = Field(None, description="Target index name")
    bucket_name: Optional[str] = Field(None, description="Bucket filter")
    conditions: List[SearchCondition] = Field(default_factory=list, description="Search conditions")
    query_string: Optional[str] = Field(None, description="Free-text query string")
    filters: Optional[Dict[str, Any]] = Field(None, description="Additional filters")
    sort_by: Optional[List[Dict[str, str]]] = Field(None, description="Sort criteria")
    limit: int = Field(20, ge=1, le=1000, description="Maximum results")
    offset: int = Field(0, ge=0, description="Result offset")
    include_facets: bool = Field(False, description="Include facet counts")
    include_highlights: bool = Field(False, description="Include search highlights")
    include_suggestions: bool = Field(False, description="Include search suggestions")
    timeout_seconds: int = Field(30, ge=1, le=300, description="Query timeout")


class SearchResult(BaseModel):
    """Search result item."""
    document_id: str = Field(..., description="Document identifier")
    bucket_name: str = Field(..., description="Source bucket")
    object_key: str = Field(..., description="Object key")
    score: float = Field(..., description="Relevance score")
    fields: Dict[str, Any] = Field(default_factory=dict, description="Document fields")
    highlights: Optional[Dict[str, List[str]]] = Field(None, description="Search highlights")
    metadata: Dict[str, Any] = Field(default_factory=dict, description="Object metadata")


class SearchResponse(BaseModel):
    """Search response."""
    query_id: Optional[str] = Field(None, description="Query identifier")
    results: List[SearchResult] = Field(..., description="Search results")
    total_hits: int = Field(..., description="Total number of matching documents")
    max_score: float = Field(..., description="Maximum relevance score")
    took_ms: int = Field(..., description="Query execution time in milliseconds")
    timed_out: bool = Field(False, description="Query timed out")
    facets: Optional[Dict[str, Dict[str, int]]] = Field(None, description="Facet counts")
    suggestions: Optional[List[str]] = Field(None, description="Search suggestions")
    aggregations: Optional[Dict[str, Any]] = Field(None, description="Search aggregations")
    generated_at: datetime = Field(default_factory=datetime.utcnow)


class IndexDocument(BaseModel):
    """Document to be indexed."""
    document_id: str = Field(..., description="Document identifier")
    bucket_name: str = Field(..., description="Source bucket")
    object_key: str = Field(..., description="Object key")
    content_type: str = Field(..., description="Content type")
    content: Optional[str] = Field(None, description="Extracted text content")
    metadata: Dict[str, Any] = Field(default_factory=dict, description="Document metadata")
    tags: Dict[str, str] = Field(default_factory=dict, description="Object tags")
    custom_fields: Dict[str, Any] = Field(default_factory=dict, description="Custom indexed fields")
    indexed_at: datetime = Field(default_factory=datetime.utcnow)


class IndexingJob(BaseModel):
    """Indexing job configuration."""
    job_id: str = Field(..., description="Job identifier")
    index_name: str = Field(..., description="Target index")
    bucket_name: str = Field(..., description="Source bucket")
    object_prefix: Optional[str] = Field(None, description="Object prefix filter")
    content_types: List[ContentType] = Field(default_factory=list, description="Content type filters")
    batch_size: int = Field(100, ge=1, le=1000, description="Batch size for processing")
    parallel_workers: int = Field(4, ge=1, le=16, description="Number of parallel workers")
    status: str = Field("pending", description="Job status")
    created_at: datetime = Field(default_factory=datetime.utcnow)
    started_at: Optional[datetime] = Field(None, description="Job start time")
    completed_at: Optional[datetime] = Field(None, description="Job completion time")
    total_objects: int = Field(0, description="Total objects to process")
    processed_objects: int = Field(0, description="Objects processed")
    successful_objects: int = Field(0, description="Successfully indexed objects")
    failed_objects: int = Field(0, description="Failed objects")
    error_messages: List[str] = Field(default_factory=list, description="Error messages")


class SearchAnalytics(BaseModel):
    """Search analytics data."""
    total_queries: int = Field(..., description="Total search queries")
    unique_users: int = Field(..., description="Unique users performing searches")
    average_response_time_ms: float = Field(..., description="Average response time")
    top_queries: List[Dict[str, Union[str, int]]] = Field(
        default_factory=list, description="Most frequent queries"
    )
    top_results: List[Dict[str, Union[str, int]]] = Field(
        default_factory=list, description="Most frequently accessed results"
    )
    query_trends: Dict[str, int] = Field(default_factory=dict, description="Query trends by time")
    zero_result_queries: List[str] = Field(default_factory=list, description="Queries with no results")
    slow_queries: List[Dict[str, Union[str, int]]] = Field(
        default_factory=list, description="Slowest queries"
    )
    index_usage: Dict[str, int] = Field(default_factory=dict, description="Index usage statistics")
    generated_at: datetime = Field(default_factory=datetime.utcnow)


class SavedSearch(BaseModel):
    """Saved search configuration."""
    search_id: str = Field(..., description="Search identifier")
    name: str = Field(..., description="Search name")
    description: Optional[str] = Field(None, description="Search description")
    user_id: str = Field(..., description="Owner user ID")
    query: SearchQuery = Field(..., description="Search query")
    is_public: bool = Field(False, description="Search is public")
    tags: List[str] = Field(default_factory=list, description="Search tags")
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)
    last_executed: Optional[datetime] = Field(None, description="Last execution time")
    execution_count: int = Field(0, description="Number of times executed")


class SearchAlert(BaseModel):
    """Search-based alert configuration."""
    alert_id: str = Field(..., description="Alert identifier")
    name: str = Field(..., description="Alert name")
    description: Optional[str] = Field(None, description="Alert description")
    user_id: str = Field(..., description="Owner user ID")
    query: SearchQuery = Field(..., description="Alert query")
    threshold: int = Field(..., ge=0, description="Result count threshold")
    comparison: str = Field(..., description="Comparison operator (>, <, =, etc.)")
    check_interval_minutes: int = Field(60, ge=1, le=10080, description="Check interval in minutes")
    notification_channels: List[str] = Field(default_factory=list, description="Notification channels")
    is_enabled: bool = Field(True, description="Alert enabled status")
    created_at: datetime = Field(default_factory=datetime.utcnow)
    last_checked: Optional[datetime] = Field(None, description="Last check time")
    last_triggered: Optional[datetime] = Field(None, description="Last trigger time")
    trigger_count: int = Field(0, description="Number of times triggered")


# Request/Response Models
class CreateIndexRequest(BaseModel):
    """Create search index request."""
    index: SearchIndex = Field(..., description="Index configuration")


class UpdateIndexRequest(BaseModel):
    """Update search index request."""
    index_name: str = Field(..., description="Index name")
    updates: Dict[str, Any] = Field(..., description="Index updates")


class StartIndexingJobRequest(BaseModel):
    """Start indexing job request."""
    job: IndexingJob = Field(..., description="Indexing job configuration")


class SaveSearchRequest(BaseModel):
    """Save search request."""
    saved_search: SavedSearch = Field(..., description="Saved search configuration")


class CreateSearchAlertRequest(BaseModel):
    """Create search alert request."""
    alert: SearchAlert = Field(..., description="Search alert configuration")


class SearchSuggestion(BaseModel):
    """Search suggestion."""
    suggestion: str = Field(..., description="Suggested query")
    score: float = Field(..., description="Suggestion relevance score")
    type: str = Field(..., description="Suggestion type (completion, correction, etc.)")


class AutocompleteRequest(BaseModel):
    """Autocomplete request."""
    prefix: str = Field(..., description="Search prefix")
    index_name: Optional[str] = Field(None, description="Target index")
    field: Optional[str] = Field(None, description="Target field")
    limit: int = Field(10, ge=1, le=50, description="Maximum suggestions")


class AutocompleteResponse(BaseModel):
    """Autocomplete response."""
    suggestions: List[SearchSuggestion] = Field(..., description="Autocomplete suggestions")
    took_ms: int = Field(..., description="Response time in milliseconds")


class SearchExportRequest(BaseModel):
    """Search export request."""
    query: SearchQuery = Field(..., description="Search query")
    format: str = Field("json", description="Export format (json, csv, xlsx)")
    include_content: bool = Field(False, description="Include document content")
    max_results: int = Field(10000, ge=1, le=100000, description="Maximum results to export")


class IndexHealth(BaseModel):
    """Index health status."""
    index_name: str = Field(..., description="Index name")
    status: IndexStatus = Field(..., description="Index status")
    document_count: int = Field(..., description="Number of documents")
    index_size_bytes: int = Field(..., description="Index size in bytes")
    last_updated: datetime = Field(..., description="Last update time")
    health_score: float = Field(..., ge=0.0, le=100.0, description="Health score (0-100)")
    issues: List[str] = Field(default_factory=list, description="Health issues")
    recommendations: List[str] = Field(default_factory=list, description="Optimization recommendations")

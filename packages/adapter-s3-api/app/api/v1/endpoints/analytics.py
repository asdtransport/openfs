"""Advanced analytics and reporting API endpoints."""

from datetime import datetime, timedelta
from typing import List, Optional
from fastapi import APIRouter, HTTPException, Query, status, Depends
from fastapi.responses import JSONResponse

from app.schemas.analytics import (
    AnalyticsQuery, DashboardData, TimeSeries, UsageMetrics,
    RequestMetrics, BandwidthMetrics, UserActivityMetrics,
    SystemHealthMetrics, ReportRequest, AlertRule, MetricType,
    TimeGranularity
)
from app.services.analytics_service import analytics_service
from loguru import logger

router = APIRouter(prefix="/analytics", tags=["analytics"])

@router.get("/dashboard", response_model=DashboardData)
async def get_dashboard_data():
    """Get comprehensive dashboard data.
    
    Returns:
        DashboardData: Complete dashboard metrics and information
    """
    try:
        dashboard_data = await analytics_service.get_dashboard_data()
        return dashboard_data
        
    except Exception as e:
        logger.error(f"Error getting dashboard data: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error retrieving dashboard data"
        )

@router.get("/metrics/usage", response_model=UsageMetrics)
async def get_usage_metrics():
    """Get storage usage metrics.
    
    Returns:
        UsageMetrics: Current storage usage statistics
    """
    try:
        return await analytics_service.get_usage_metrics()
        
    except Exception as e:
        logger.error(f"Error getting usage metrics: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error retrieving usage metrics"
        )

@router.get("/metrics/requests", response_model=RequestMetrics)
async def get_request_metrics():
    """Get API request metrics.
    
    Returns:
        RequestMetrics: Request statistics and performance metrics
    """
    try:
        return await analytics_service.get_request_metrics()
        
    except Exception as e:
        logger.error(f"Error getting request metrics: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error retrieving request metrics"
        )

@router.get("/metrics/bandwidth", response_model=BandwidthMetrics)
async def get_bandwidth_metrics():
    """Get bandwidth usage metrics.
    
    Returns:
        BandwidthMetrics: Bandwidth usage and transfer statistics
    """
    try:
        return await analytics_service.get_bandwidth_metrics()
        
    except Exception as e:
        logger.error(f"Error getting bandwidth metrics: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error retrieving bandwidth metrics"
        )

@router.get("/metrics/users", response_model=UserActivityMetrics)
async def get_user_activity_metrics():
    """Get user activity metrics.
    
    Returns:
        UserActivityMetrics: User activity and engagement statistics
    """
    try:
        return await analytics_service.get_user_activity_metrics()
        
    except Exception as e:
        logger.error(f"Error getting user activity metrics: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error retrieving user activity metrics"
        )

@router.get("/metrics/system", response_model=SystemHealthMetrics)
async def get_system_health_metrics():
    """Get system health metrics.
    
    Returns:
        SystemHealthMetrics: System performance and health statistics
    """
    try:
        return await analytics_service.get_system_health_metrics()
        
    except Exception as e:
        logger.error(f"Error getting system health metrics: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error retrieving system health metrics"
        )

@router.post("/query", response_model=List[TimeSeries])
async def query_time_series(query: AnalyticsQuery):
    """Query time series data.
    
    Args:
        query: Analytics query parameters
        
    Returns:
        List[TimeSeries]: Time series data matching the query
    """
    try:
        # Validate time range
        if query.end_time <= query.start_time:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="End time must be after start time"
            )
        
        # Limit query range to prevent excessive data
        max_range = timedelta(days=90)
        if query.end_time - query.start_time > max_range:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Query range cannot exceed 90 days"
            )
        
        time_series = await analytics_service.get_time_series(query)
        return time_series
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error querying time series: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error querying time series data"
        )

@router.get("/timeseries")
async def get_timeseries_data(
    metric: str = Query(..., description="Metric name"),
    hours: int = Query(24, ge=1, le=168, description="Hours of data to retrieve")
):
    """Get time series data for a specific metric.
    
    Args:
        metric: Metric name (storage_usage, request_count, etc.)
        hours: Number of hours of data to retrieve
        
    Returns:
        dict: Time series data
    """
    try:
        # Generate sample time series data
        from datetime import datetime, timedelta
        import random
        
        end_time = datetime.utcnow()
        start_time = end_time - timedelta(hours=hours)
        
        # Generate hourly data points
        data_points = []
        current_time = start_time
        base_value = random.randint(100, 1000)
        
        while current_time <= end_time:
            # Add some variation to the data
            variation = random.uniform(0.8, 1.2)
            value = base_value * variation
            
            data_points.append({
                "timestamp": current_time.isoformat(),
                "value": round(value, 2)
            })
            
            current_time += timedelta(hours=1)
        
        return {
            "metric": metric,
            "start_time": start_time.isoformat(),
            "end_time": end_time.isoformat(),
            "data_points": data_points,
            "total_points": len(data_points)
        }
        
    except Exception as e:
        logger.error(f"Error getting timeseries data: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error retrieving timeseries data"
        )

@router.get("/metrics/real-time")
async def get_real_time_metrics(
    metric_types: List[MetricType] = Query(..., description="Metric types to retrieve"),
    last_n_minutes: int = Query(5, ge=1, le=60, description="Last N minutes of data")
):
    """Get real-time metrics for the last N minutes.
    
    Args:
        metric_types: List of metric types to retrieve
        last_n_minutes: Number of minutes of recent data
        
    Returns:
        dict: Real-time metrics data
    """
    try:
        end_time = datetime.utcnow()
        start_time = end_time - timedelta(minutes=last_n_minutes)
        
        query = AnalyticsQuery(
            metric_types=metric_types,
            start_time=start_time,
            end_time=end_time,
            granularity=TimeGranularity.MINUTE
        )
        
        time_series = await analytics_service.get_time_series(query)
        
        # Format for real-time display
        real_time_data = {}
        for ts in time_series:
            real_time_data[ts.metric_name] = {
                "current_value": ts.data_points[-1].value if ts.data_points else 0,
                "trend": "up" if len(ts.data_points) >= 2 and ts.data_points[-1].value > ts.data_points[-2].value else "down",
                "data_points": [
                    {
                        "timestamp": dp.timestamp.isoformat(),
                        "value": dp.value
                    }
                    for dp in ts.data_points[-20:]  # Last 20 points
                ],
                "unit": ts.unit
            }
        
        return {
            "timestamp": end_time.isoformat(),
            "metrics": real_time_data,
            "time_range_minutes": last_n_minutes
        }
        
    except Exception as e:
        logger.error(f"Error getting real-time metrics: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error retrieving real-time metrics"
        )

@router.post("/alerts/rules")
async def create_alert_rule(rule: AlertRule):
    """Create a new alert rule.
    
    Args:
        rule: Alert rule configuration
        
    Returns:
        dict: Creation confirmation
    """
    try:
        success = await analytics_service.create_alert_rule(rule)
        
        if success:
            return {
                "message": f"Alert rule '{rule.name}' created successfully",
                "rule_id": rule.rule_id
            }
        else:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to create alert rule"
            )
            
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating alert rule: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error creating alert rule"
        )

@router.get("/alerts/rules")
async def list_alert_rules():
    """List all alert rules.
    
    Returns:
        dict: List of alert rules
    """
    try:
        rules = list(analytics_service.alert_rules.values())
        return {
            "rules": [
                {
                    "rule_id": rule.rule_id,
                    "name": rule.name,
                    "description": rule.description,
                    "metric_type": rule.metric_type.value,
                    "threshold": rule.threshold,
                    "comparison": rule.comparison,
                    "enabled": rule.enabled,
                    "last_triggered": rule.last_triggered.isoformat() if rule.last_triggered else None
                }
                for rule in rules
            ],
            "total_count": len(rules)
        }
        
    except Exception as e:
        logger.error(f"Error listing alert rules: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error retrieving alert rules"
        )

@router.get("/reports/summary")
async def get_summary_report(
    days: int = Query(7, ge=1, le=90, description="Number of days to include in report")
):
    """Get summary report for the specified time period.
    
    Args:
        days: Number of days to include in the report
        
    Returns:
        dict: Summary report data
    """
    try:
        end_time = datetime.utcnow()
        start_time = end_time - timedelta(days=days)
        
        # Get current metrics
        usage_metrics = await analytics_service.get_usage_metrics()
        request_metrics = await analytics_service.get_request_metrics()
        bandwidth_metrics = await analytics_service.get_bandwidth_metrics()
        user_activity = await analytics_service.get_user_activity_metrics()
        system_health = await analytics_service.get_system_health_metrics()
        
        # Calculate period-specific metrics
        period_requests = [
            log for log in analytics_service.request_logs
            if log["timestamp"] >= start_time
        ]
        
        report = {
            "report_period": {
                "start_date": start_time.isoformat(),
                "end_date": end_time.isoformat(),
                "days": days
            },
            "summary": {
                "total_storage_gb": round(usage_metrics.total_storage_bytes / (1024**3), 2),
                "total_objects": usage_metrics.total_objects,
                "total_buckets": usage_metrics.total_buckets,
                "total_requests": len(period_requests),
                "average_response_time_ms": request_metrics.average_response_time,
                "error_rate_percent": system_health.error_rate,
                "active_users": user_activity.active_users_daily,
                "uptime_hours": round(system_health.uptime_seconds / 3600, 1)
            },
            "top_statistics": {
                "busiest_day": None,  # TODO: Calculate
                "peak_requests_per_hour": None,  # TODO: Calculate
                "largest_upload_mb": None,  # TODO: Calculate
                "most_active_user": user_activity.top_users_by_requests[0]["user"] if user_activity.top_users_by_requests else None
            },
            "trends": {
                "storage_growth_rate": usage_metrics.storage_growth_rate,
                "request_volume_trend": "stable",  # TODO: Calculate
                "error_rate_trend": "stable"  # TODO: Calculate
            },
            "generated_at": datetime.utcnow().isoformat()
        }
        
        return report
        
    except Exception as e:
        logger.error(f"Error generating summary report: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error generating summary report"
        )

@router.get("/metrics/export")
async def export_metrics(
    format: str = Query("json", pattern="^(json|csv)$", description="Export format"),
    start_date: Optional[datetime] = Query(None, description="Start date for export"),
    end_date: Optional[datetime] = Query(None, description="End date for export"),
    metric_types: List[MetricType] = Query([], description="Specific metrics to export")
):
    """Export metrics data in various formats.
    
    Args:
        format: Export format (json or csv)
        start_date: Start date for export
        end_date: End date for export
        metric_types: Specific metrics to export
        
    Returns:
        Response with exported data
    """
    try:
        # Set default date range if not provided
        if not end_date:
            end_date = datetime.utcnow()
        if not start_date:
            start_date = end_date - timedelta(days=7)
        
        # Use all metric types if none specified
        if not metric_types:
            metric_types = list(MetricType)
        
        query = AnalyticsQuery(
            metric_types=metric_types,
            start_time=start_date,
            end_time=end_date,
            granularity=TimeGranularity.HOUR
        )
        
        time_series = await analytics_service.get_time_series(query)
        
        if format == "json":
            export_data = {
                "export_info": {
                    "generated_at": datetime.utcnow().isoformat(),
                    "start_date": start_date.isoformat(),
                    "end_date": end_date.isoformat(),
                    "metric_count": len(time_series)
                },
                "metrics": [
                    {
                        "metric_name": ts.metric_name,
                        "metric_type": ts.metric_type.value,
                        "unit": ts.unit,
                        "data_points": [
                            {
                                "timestamp": dp.timestamp.isoformat(),
                                "value": dp.value,
                                "labels": dp.labels
                            }
                            for dp in ts.data_points
                        ]
                    }
                    for ts in time_series
                ]
            }
            
            return JSONResponse(
                content=export_data,
                headers={
                    "Content-Disposition": f"attachment; filename=metrics_export_{start_date.strftime('%Y%m%d')}_{end_date.strftime('%Y%m%d')}.json"
                }
            )
        
        elif format == "csv":
            # TODO: Implement CSV export
            raise HTTPException(
                status_code=status.HTTP_501_NOT_IMPLEMENTED,
                detail="CSV export not yet implemented"
            )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error exporting metrics: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error exporting metrics data"
        )

@router.post("/log-request")
async def log_api_request(
    method: str,
    path: str,
    status_code: int,
    response_time: float,
    user: Optional[str] = None,
    bytes_sent: int = 0,
    bytes_received: int = 0
):
    """Log an API request for analytics (internal endpoint).
    
    Args:
        method: HTTP method
        path: Request path
        status_code: Response status code
        response_time: Response time in milliseconds
        user: Username (if authenticated)
        bytes_sent: Bytes sent in response
        bytes_received: Bytes received in request
        
    Returns:
        dict: Logging confirmation
    """
    try:
        await analytics_service.log_request(
            method=method,
            path=path,
            status_code=status_code,
            response_time=response_time,
            user=user,
            bytes_sent=bytes_sent,
            bytes_received=bytes_received
        )
        
        return {"message": "Request logged successfully"}
        
    except Exception as e:
        logger.error(f"Error logging request: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error logging request"
        )

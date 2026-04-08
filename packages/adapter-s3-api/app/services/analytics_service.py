"""Advanced analytics and reporting service."""

import asyncio
import time
from collections import defaultdict
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Tuple
from loguru import logger

from app.schemas.analytics import (
    MetricType, TimeGranularity, RequestType, StorageClass,
    DataPoint, TimeSeries, UsageMetrics, RequestMetrics,
    BandwidthMetrics, UserActivityMetrics, BucketAnalytics,
    SystemHealthMetrics, ComplianceReport, CostAnalysis,
    AnalyticsQuery, DashboardData, ReportRequest, AlertRule
)
from app.services.minio_client import minio_client


class AnalyticsService:
    """Advanced analytics and reporting service."""
    
    def __init__(self):
        """Initialize analytics service."""
        self.metrics_storage: Dict[str, List[DataPoint]] = defaultdict(list)
        self.request_logs: List[Dict] = []
        self.user_activity: Dict[str, List[Dict]] = defaultdict(list)
        self.system_metrics: List[Dict] = []
        self.alert_rules: Dict[str, AlertRule] = {}
        self.start_time = time.time()
        
        # Start background metrics collection
        asyncio.create_task(self._collect_system_metrics())
    
    async def _collect_system_metrics(self):
        """Collect system metrics in background."""
        while True:
            try:
                # Collect system health metrics
                await self._collect_health_metrics()
                
                # Collect storage metrics
                await self._collect_storage_metrics()
                
                # Process alert rules
                await self._process_alerts()
                
                # Sleep for 1 minute
                await asyncio.sleep(60)
                
            except Exception as e:
                logger.error(f"Error collecting system metrics: {e}")
                await asyncio.sleep(60)
    
    async def _collect_health_metrics(self):
        """Collect system health metrics."""
        try:
            import psutil
            
            # CPU and memory metrics
            cpu_percent = psutil.cpu_percent(interval=1)
            memory = psutil.virtual_memory()
            disk = psutil.disk_usage('/')
            
            # Network I/O
            network = psutil.net_io_counters()
            
            # Store metrics
            timestamp = datetime.utcnow()
            
            self.metrics_storage["cpu_usage"].append(
                DataPoint(timestamp=timestamp, value=cpu_percent)
            )
            
            self.metrics_storage["memory_usage"].append(
                DataPoint(timestamp=timestamp, value=memory.percent)
            )
            
            self.metrics_storage["disk_usage"].append(
                DataPoint(timestamp=timestamp, value=disk.percent)
            )
            
            self.metrics_storage["network_io"].append(
                DataPoint(timestamp=timestamp, value=network.bytes_sent + network.bytes_recv)
            )
            
            # Keep only last 24 hours of data
            cutoff_time = timestamp - timedelta(hours=24)
            for metric_name in self.metrics_storage:
                self.metrics_storage[metric_name] = [
                    dp for dp in self.metrics_storage[metric_name]
                    if dp.timestamp > cutoff_time
                ]
                
        except ImportError:
            # psutil not available, use mock data
            timestamp = datetime.utcnow()
            self.metrics_storage["cpu_usage"].append(
                DataPoint(timestamp=timestamp, value=25.5)
            )
            self.metrics_storage["memory_usage"].append(
                DataPoint(timestamp=timestamp, value=60.2)
            )
        except Exception as e:
            logger.error(f"Error collecting health metrics: {e}")
    
    async def _collect_storage_metrics(self):
        """Collect storage usage metrics."""
        try:
            # Get bucket information
            buckets = minio_client.client.list_buckets()
            total_objects = 0
            total_size = 0
            
            for bucket in buckets:
                try:
                    objects = await minio_client.list_objects(bucket.name)
                    bucket_objects = len(objects)
                    bucket_size = sum(obj.get("size", 0) for obj in objects)
                    
                    total_objects += bucket_objects
                    total_size += bucket_size
                    
                    # Store per-bucket metrics
                    timestamp = datetime.utcnow()
                    self.metrics_storage[f"bucket_{bucket.name}_objects"].append(
                        DataPoint(timestamp=timestamp, value=bucket_objects)
                    )
                    self.metrics_storage[f"bucket_{bucket.name}_size"].append(
                        DataPoint(timestamp=timestamp, value=bucket_size)
                    )
                    
                except Exception as e:
                    logger.warning(f"Error collecting metrics for bucket {bucket.name}: {e}")
            
            # Store total metrics
            timestamp = datetime.utcnow()
            self.metrics_storage["total_objects"].append(
                DataPoint(timestamp=timestamp, value=total_objects)
            )
            self.metrics_storage["total_storage"].append(
                DataPoint(timestamp=timestamp, value=total_size)
            )
            
        except Exception as e:
            logger.error(f"Error collecting storage metrics: {e}")
    
    async def _process_alerts(self):
        """Process alert rules and trigger notifications."""
        try:
            current_time = datetime.utcnow()
            
            for rule_id, rule in self.alert_rules.items():
                if not rule.enabled:
                    continue
                
                # Get recent metric data
                metric_data = self.metrics_storage.get(rule.metric_type.value, [])
                if not metric_data:
                    continue
                
                # Check threshold
                recent_data = [
                    dp for dp in metric_data
                    if dp.timestamp > current_time - timedelta(seconds=rule.duration)
                ]
                
                if not recent_data:
                    continue
                
                # Evaluate condition
                latest_value = recent_data[-1].value
                threshold_breached = self._evaluate_threshold(
                    latest_value, rule.threshold, rule.comparison
                )
                
                if threshold_breached:
                    # Trigger alert
                    await self._trigger_alert(rule, latest_value)
                    
        except Exception as e:
            logger.error(f"Error processing alerts: {e}")
    
    def _evaluate_threshold(self, value: float, threshold: float, comparison: str) -> bool:
        """Evaluate threshold condition."""
        if comparison == ">":
            return value > threshold
        elif comparison == "<":
            return value < threshold
        elif comparison == ">=":
            return value >= threshold
        elif comparison == "<=":
            return value <= threshold
        elif comparison == "==":
            return value == threshold
        elif comparison == "!=":
            return value != threshold
        return False
    
    async def _trigger_alert(self, rule: AlertRule, current_value: float):
        """Trigger alert notification."""
        try:
            # Update last triggered time
            rule.last_triggered = datetime.utcnow()
            
            # Log alert
            logger.warning(
                f"Alert triggered: {rule.name} - "
                f"Current value: {current_value}, Threshold: {rule.threshold}"
            )
            
            # In production, send notifications via email, Slack, etc.
            # For now, just log the alert
            
        except Exception as e:
            logger.error(f"Error triggering alert: {e}")
    
    async def log_request(self, method: str, path: str, status_code: int, 
                         response_time: float, user: Optional[str] = None,
                         bytes_sent: int = 0, bytes_received: int = 0):
        """Log API request for analytics."""
        try:
            request_log = {
                "timestamp": datetime.utcnow(),
                "method": method,
                "path": path,
                "status_code": status_code,
                "response_time": response_time,
                "user": user,
                "bytes_sent": bytes_sent,
                "bytes_received": bytes_received
            }
            
            self.request_logs.append(request_log)
            
            # Keep only last 7 days of request logs
            cutoff_time = datetime.utcnow() - timedelta(days=7)
            self.request_logs = [
                log for log in self.request_logs
                if log["timestamp"] > cutoff_time
            ]
            
            # Update user activity
            if user:
                self.user_activity[user].append(request_log)
                
                # Keep only last 30 days of user activity
                self.user_activity[user] = [
                    log for log in self.user_activity[user]
                    if log["timestamp"] > datetime.utcnow() - timedelta(days=30)
                ]
            
        except Exception as e:
            logger.error(f"Error logging request: {e}")
    
    async def get_usage_metrics(self) -> UsageMetrics:
        """Get current storage usage metrics."""
        try:
            # Get latest storage metrics
            total_storage_data = self.metrics_storage.get("total_storage", [])
            total_objects_data = self.metrics_storage.get("total_objects", [])
            
            total_storage = total_storage_data[-1].value if total_storage_data else 0
            total_objects = int(total_objects_data[-1].value) if total_objects_data else 0
            
            # Get bucket count
            buckets = minio_client.client.list_buckets()
            total_buckets = len(buckets)
            
            # Find largest bucket
            largest_bucket = None
            largest_bucket_size = 0
            
            for bucket in buckets:
                bucket_size_data = self.metrics_storage.get(f"bucket_{bucket.name}_size", [])
                if bucket_size_data:
                    bucket_size = bucket_size_data[-1].value
                    if bucket_size > largest_bucket_size:
                        largest_bucket = bucket.name
                        largest_bucket_size = bucket_size
            
            # Calculate average object size
            average_object_size = total_storage / total_objects if total_objects > 0 else 0
            
            # Calculate growth rate (simplified)
            growth_rate = 0.0
            if len(total_storage_data) >= 2:
                current = total_storage_data[-1].value
                previous = total_storage_data[-2].value
                if previous > 0:
                    growth_rate = ((current - previous) / previous) * 100
            
            return UsageMetrics(
                total_storage_bytes=int(total_storage),
                total_objects=total_objects,
                total_buckets=total_buckets,
                storage_by_class={StorageClass.STANDARD: int(total_storage)},
                largest_bucket=largest_bucket,
                largest_bucket_size=int(largest_bucket_size),
                average_object_size=average_object_size,
                storage_growth_rate=growth_rate
            )
            
        except Exception as e:
            logger.error(f"Error getting usage metrics: {e}")
            return UsageMetrics(
                total_storage_bytes=0,
                total_objects=0,
                total_buckets=0
            )
    
    async def get_request_metrics(self) -> RequestMetrics:
        """Get request metrics."""
        try:
            if not self.request_logs:
                return RequestMetrics(
                    total_requests=0,
                    successful_requests=0,
                    client_errors=0,
                    server_errors=0,
                    average_response_time=0.0,
                    p95_response_time=0.0,
                    p99_response_time=0.0,
                    requests_per_second=0.0
                )
            
            # Calculate metrics from request logs
            total_requests = len(self.request_logs)
            successful_requests = len([log for log in self.request_logs if 200 <= log["status_code"] < 300])
            client_errors = len([log for log in self.request_logs if 400 <= log["status_code"] < 500])
            server_errors = len([log for log in self.request_logs if log["status_code"] >= 500])
            
            # Response time metrics
            response_times = [log["response_time"] for log in self.request_logs]
            average_response_time = sum(response_times) / len(response_times)
            
            # Percentiles
            sorted_times = sorted(response_times)
            p95_index = int(0.95 * len(sorted_times))
            p99_index = int(0.99 * len(sorted_times))
            p95_response_time = sorted_times[p95_index] if p95_index < len(sorted_times) else 0
            p99_response_time = sorted_times[p99_index] if p99_index < len(sorted_times) else 0
            
            # Requests per second (last hour)
            one_hour_ago = datetime.utcnow() - timedelta(hours=1)
            recent_requests = [log for log in self.request_logs if log["timestamp"] > one_hour_ago]
            requests_per_second = len(recent_requests) / 3600.0
            
            # Requests by type
            requests_by_type = defaultdict(int)
            for log in self.request_logs:
                method = log["method"].upper()
                if method in ["GET", "PUT", "POST", "DELETE", "HEAD"]:
                    requests_by_type[RequestType(method)] += 1
            
            return RequestMetrics(
                total_requests=total_requests,
                requests_by_type=dict(requests_by_type),
                successful_requests=successful_requests,
                client_errors=client_errors,
                server_errors=server_errors,
                average_response_time=average_response_time,
                p95_response_time=p95_response_time,
                p99_response_time=p99_response_time,
                requests_per_second=requests_per_second
            )
            
        except Exception as e:
            logger.error(f"Error getting request metrics: {e}")
            return RequestMetrics(
                total_requests=0,
                successful_requests=0,
                client_errors=0,
                server_errors=0,
                average_response_time=0.0,
                p95_response_time=0.0,
                p99_response_time=0.0,
                requests_per_second=0.0
            )
    
    async def get_bandwidth_metrics(self) -> BandwidthMetrics:
        """Get bandwidth usage metrics."""
        try:
            # Calculate from request logs
            total_bytes_uploaded = sum(log.get("bytes_received", 0) for log in self.request_logs)
            total_bytes_downloaded = sum(log.get("bytes_sent", 0) for log in self.request_logs)
            
            # Calculate bandwidth (simplified)
            time_span_hours = 24  # Last 24 hours
            upload_bandwidth_mbps = (total_bytes_uploaded * 8) / (time_span_hours * 3600 * 1_000_000)
            download_bandwidth_mbps = (total_bytes_downloaded * 8) / (time_span_hours * 3600 * 1_000_000)
            
            return BandwidthMetrics(
                total_bytes_uploaded=total_bytes_uploaded,
                total_bytes_downloaded=total_bytes_downloaded,
                upload_bandwidth_mbps=upload_bandwidth_mbps,
                download_bandwidth_mbps=download_bandwidth_mbps,
                peak_upload_bandwidth=upload_bandwidth_mbps * 2,  # Simplified
                peak_download_bandwidth=download_bandwidth_mbps * 2
            )
            
        except Exception as e:
            logger.error(f"Error getting bandwidth metrics: {e}")
            return BandwidthMetrics(
                total_bytes_uploaded=0,
                total_bytes_downloaded=0,
                upload_bandwidth_mbps=0.0,
                download_bandwidth_mbps=0.0,
                peak_upload_bandwidth=0.0,
                peak_download_bandwidth=0.0
            )
    
    async def get_user_activity_metrics(self) -> UserActivityMetrics:
        """Get user activity metrics."""
        try:
            total_users = len(self.user_activity)
            
            # Calculate active users
            now = datetime.utcnow()
            daily_active = len([
                user for user, activity in self.user_activity.items()
                if any(log["timestamp"] > now - timedelta(days=1) for log in activity)
            ])
            
            weekly_active = len([
                user for user, activity in self.user_activity.items()
                if any(log["timestamp"] > now - timedelta(days=7) for log in activity)
            ])
            
            monthly_active = len([
                user for user, activity in self.user_activity.items()
                if any(log["timestamp"] > now - timedelta(days=30) for log in activity)
            ])
            
            # Top users by requests
            user_request_counts = {
                user: len(activity) for user, activity in self.user_activity.items()
            }
            top_users_by_requests = [
                {"user": user, "requests": count}
                for user, count in sorted(user_request_counts.items(), 
                                        key=lambda x: x[1], reverse=True)[:10]
            ]
            
            return UserActivityMetrics(
                total_users=total_users,
                active_users_daily=daily_active,
                active_users_weekly=weekly_active,
                active_users_monthly=monthly_active,
                top_users_by_requests=top_users_by_requests,
                top_users_by_storage=[],  # TODO: Implement
                new_users_today=0  # TODO: Implement
            )
            
        except Exception as e:
            logger.error(f"Error getting user activity metrics: {e}")
            return UserActivityMetrics(
                total_users=0,
                active_users_daily=0,
                active_users_weekly=0,
                active_users_monthly=0
            )
    
    async def get_system_health_metrics(self) -> SystemHealthMetrics:
        """Get system health metrics."""
        try:
            # Get latest system metrics
            cpu_data = self.metrics_storage.get("cpu_usage", [])
            memory_data = self.metrics_storage.get("memory_usage", [])
            disk_data = self.metrics_storage.get("disk_usage", [])
            network_data = self.metrics_storage.get("network_io", [])
            
            cpu_usage = cpu_data[-1].value if cpu_data else 0
            memory_usage = memory_data[-1].value if memory_data else 0
            disk_usage = disk_data[-1].value if disk_data else 0
            network_io = int(network_data[-1].value) if network_data else 0
            
            # Calculate uptime
            uptime_seconds = int(time.time() - self.start_time)
            
            # Calculate error rate
            total_requests = len(self.request_logs)
            error_requests = len([log for log in self.request_logs if log["status_code"] >= 400])
            error_rate = (error_requests / total_requests * 100) if total_requests > 0 else 0
            
            # Calculate availability (simplified)
            availability_percent = max(0, 100 - error_rate)
            
            return SystemHealthMetrics(
                cpu_usage_percent=cpu_usage,
                memory_usage_percent=memory_usage,
                disk_usage_percent=disk_usage,
                network_io_bytes=network_io,
                disk_io_bytes=0,  # TODO: Implement
                active_connections=0,  # TODO: Implement
                uptime_seconds=uptime_seconds,
                error_rate=error_rate,
                availability_percent=availability_percent
            )
            
        except Exception as e:
            logger.error(f"Error getting system health metrics: {e}")
            return SystemHealthMetrics(
                cpu_usage_percent=0,
                memory_usage_percent=0,
                disk_usage_percent=0,
                network_io_bytes=0,
                disk_io_bytes=0,
                active_connections=0,
                uptime_seconds=0,
                error_rate=0,
                availability_percent=100
            )
    
    async def get_dashboard_data(self) -> DashboardData:
        """Get comprehensive dashboard data."""
        try:
            # Gather all metrics concurrently
            usage_metrics, request_metrics, bandwidth_metrics, user_activity, system_health = await asyncio.gather(
                self.get_usage_metrics(),
                self.get_request_metrics(),
                self.get_bandwidth_metrics(),
                self.get_user_activity_metrics(),
                self.get_system_health_metrics()
            )
            
            # Get top buckets (simplified)
            top_buckets = []  # TODO: Implement detailed bucket analytics
            
            # Recent activity (last 10 requests)
            recent_activity = [
                {
                    "timestamp": log["timestamp"].isoformat(),
                    "method": log["method"],
                    "path": log["path"],
                    "status": str(log["status_code"]),
                    "user": log.get("user", "anonymous")
                }
                for log in self.request_logs[-10:]
            ]
            
            # Alerts (active alerts)
            alerts = [
                {
                    "rule_name": rule.name,
                    "severity": "warning",
                    "message": f"{rule.name} threshold breached",
                    "triggered_at": rule.last_triggered.isoformat() if rule.last_triggered else ""
                }
                for rule in self.alert_rules.values()
                if rule.last_triggered and rule.last_triggered > datetime.utcnow() - timedelta(hours=1)
            ]
            
            return DashboardData(
                usage_metrics=usage_metrics,
                request_metrics=request_metrics,
                bandwidth_metrics=bandwidth_metrics,
                user_activity=user_activity,
                system_health=system_health,
                top_buckets=top_buckets,
                recent_activity=recent_activity,
                alerts=alerts
            )
            
        except Exception as e:
            logger.error(f"Error getting dashboard data: {e}")
            raise
    
    async def create_alert_rule(self, rule: AlertRule) -> bool:
        """Create a new alert rule."""
        try:
            self.alert_rules[rule.rule_id] = rule
            logger.info(f"Created alert rule: {rule.name}")
            return True
        except Exception as e:
            logger.error(f"Error creating alert rule: {e}")
            return False
    
    async def get_time_series(self, query: AnalyticsQuery) -> List[TimeSeries]:
        """Get time series data based on query."""
        try:
            result = []
            
            for metric_type in query.metric_types:
                metric_data = self.metrics_storage.get(metric_type.value, [])
                
                # Filter by time range
                filtered_data = [
                    dp for dp in metric_data
                    if query.start_time <= dp.timestamp <= query.end_time
                ]
                
                if filtered_data:
                    time_series = TimeSeries(
                        metric_name=metric_type.value,
                        metric_type=metric_type,
                        unit=self._get_metric_unit(metric_type),
                        data_points=filtered_data,
                        start_time=query.start_time,
                        end_time=query.end_time,
                        granularity=query.granularity
                    )
                    result.append(time_series)
            
            return result
            
        except Exception as e:
            logger.error(f"Error getting time series: {e}")
            return []
    
    def _get_metric_unit(self, metric_type: MetricType) -> str:
        """Get unit for metric type."""
        unit_map = {
            MetricType.STORAGE_USAGE: "bytes",
            MetricType.REQUEST_COUNT: "requests",
            MetricType.BANDWIDTH: "bytes/s",
            MetricType.ERROR_RATE: "percent",
            MetricType.RESPONSE_TIME: "ms",
            MetricType.ACTIVE_USERS: "users",
            MetricType.OBJECT_COUNT: "objects",
            MetricType.BUCKET_COUNT: "buckets"
        }
        return unit_map.get(metric_type, "count")


# Global analytics service instance
analytics_service = AnalyticsService()

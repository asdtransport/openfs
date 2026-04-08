"""Bucket replication service implementation."""

import asyncio
import secrets
from datetime import datetime, timedelta
from typing import Dict, List, Optional
from loguru import logger

from app.schemas.replication import (
    BucketReplicationConfiguration, ReplicationRule, ReplicationJob,
    ReplicationStatus, ReplicationReport, CreateReplicationConfigRequest,
    ReplicationConfigResponse, ReplicationHealthCheck
)
from app.services.minio_client import minio_client


class ReplicationService:
    """Bucket replication service for cross-bucket and cross-region replication."""
    
    def __init__(self):
        """Initialize replication service."""
        self.configurations: Dict[str, BucketReplicationConfiguration] = {}
        self.replication_jobs: Dict[str, ReplicationJob] = {}
        self.replication_status: Dict[str, ReplicationStatus] = {}
        
        # Start background replication processor
        asyncio.create_task(self._replication_processor())
    
    async def _replication_processor(self):
        """Background task to process replication jobs."""
        while True:
            try:
                await self._process_replication_queue()
                await asyncio.sleep(10)  # Process every 10 seconds
            except Exception as e:
                logger.error(f"Error in replication processor: {e}")
                await asyncio.sleep(60)
    
    async def create_replication_configuration(self, request: CreateReplicationConfigRequest) -> ReplicationConfigResponse:
        """Create replication configuration for a bucket."""
        try:
            bucket_name = request.bucket_name
            config = request.replication_configuration
            
            # Validate source bucket exists
            if not await minio_client.bucket_exists(bucket_name):
                raise ValueError(f"Source bucket {bucket_name} does not exist")
            
            # Validate destination buckets
            for rule in config.rules:
                dest_bucket = rule.destination.bucket
                if not await minio_client.bucket_exists(dest_bucket):
                    logger.warning(f"Destination bucket {dest_bucket} does not exist")
            
            # Store configuration
            self.configurations[bucket_name] = config
            
            # Initialize replication status
            self.replication_status[bucket_name] = ReplicationStatus(
                bucket_name=bucket_name,
                replication_enabled=True,
                total_rules=len(config.rules),
                active_rules=len([r for r in config.rules if r.status.value == "Enabled"])
            )
            
            logger.info(f"Created replication configuration for bucket {bucket_name} with {len(config.rules)} rules")
            
            return ReplicationConfigResponse(
                bucket_name=bucket_name,
                replication_configuration=config,
                created_at=datetime.utcnow(),
                last_modified=datetime.utcnow()
            )
            
        except Exception as e:
            logger.error(f"Error creating replication configuration: {e}")
            raise
    
    async def get_replication_configuration(self, bucket_name: str) -> Optional[ReplicationConfigResponse]:
        """Get replication configuration for a bucket."""
        config = self.configurations.get(bucket_name)
        if not config:
            return None
        
        return ReplicationConfigResponse(
            bucket_name=bucket_name,
            replication_configuration=config,
            created_at=datetime.utcnow(),  # TODO: Store actual creation time
            last_modified=datetime.utcnow()
        )
    
    async def delete_replication_configuration(self, bucket_name: str) -> bool:
        """Delete replication configuration for a bucket."""
        if bucket_name in self.configurations:
            del self.configurations[bucket_name]
            if bucket_name in self.replication_status:
                del self.replication_status[bucket_name]
            logger.info(f"Deleted replication configuration for bucket {bucket_name}")
            return True
        return False
    
    async def trigger_object_replication(self, source_bucket: str, object_key: str, rule_id: Optional[str] = None) -> List[str]:
        """Trigger replication for a specific object."""
        try:
            if source_bucket not in self.configurations:
                raise ValueError(f"No replication configuration found for bucket {source_bucket}")
            
            config = self.configurations[source_bucket]
            job_ids = []
            
            for rule in config.rules:
                if rule.status.value != "Enabled":
                    continue
                
                if rule_id and rule.id != rule_id:
                    continue
                
                # Check if object matches rule filter
                if not self._object_matches_filter(object_key, rule.filter):
                    continue
                
                # Create replication job
                job_id = f"repl-{secrets.token_hex(8)}"
                job = ReplicationJob(
                    job_id=job_id,
                    source_bucket=source_bucket,
                    destination_bucket=rule.destination.bucket,
                    rule_id=rule.id,
                    object_key=object_key,
                    status="pending"
                )
                
                self.replication_jobs[job_id] = job
                job_ids.append(job_id)
                
                logger.info(f"Created replication job {job_id} for {source_bucket}/{object_key} -> {rule.destination.bucket}")
            
            return job_ids
            
        except Exception as e:
            logger.error(f"Error triggering object replication: {e}")
            raise
    
    def _object_matches_filter(self, object_key: str, filter_config) -> bool:
        """Check if object matches replication filter."""
        if not filter_config:
            return True
        
        # Check prefix filter
        if filter_config.prefix and not object_key.startswith(filter_config.prefix):
            return False
        
        # Check tag filters (simplified - would need actual tag support)
        if filter_config.tags:
            # TODO: Implement tag matching when tag support is added
            pass
        
        return True
    
    async def _process_replication_queue(self):
        """Process pending replication jobs."""
        pending_jobs = [job for job in self.replication_jobs.values() if job.status == "pending"]
        
        for job in pending_jobs[:10]:  # Process up to 10 jobs at a time
            try:
                await self._execute_replication_job(job)
            except Exception as e:
                logger.error(f"Error processing replication job {job.job_id}: {e}")
                job.status = "failed"
                job.error_message = str(e)
                job.completed_at = datetime.utcnow()
    
    async def _execute_replication_job(self, job: ReplicationJob):
        """Execute a replication job."""
        try:
            job.status = "running"
            job.started_at = datetime.utcnow()
            
            # Get object from source bucket
            try:
                object_data = await minio_client.get_object_data(job.source_bucket, job.object_key)
                if not object_data:
                    raise Exception("Object not found in source bucket")
                
                object_size = len(object_data)
                
                # Upload to destination bucket
                success = await minio_client.put_object_data(
                    job.destination_bucket,
                    job.object_key,
                    object_data
                )
                
                if success:
                    job.status = "completed"
                    job.bytes_replicated = object_size
                    logger.info(f"Successfully replicated {job.source_bucket}/{job.object_key} to {job.destination_bucket}")
                else:
                    job.status = "failed"
                    job.error_message = "Failed to upload to destination bucket"
                
            except Exception as e:
                job.status = "failed"
                job.error_message = f"Replication error: {str(e)}"
                logger.error(f"Replication job {job.job_id} failed: {e}")
            
            job.completed_at = datetime.utcnow()
            
            # Update replication status
            if job.source_bucket in self.replication_status:
                status = self.replication_status[job.source_bucket]
                if job.status == "completed":
                    status.last_replication = datetime.utcnow()
                    status.bytes_replicated_24h += job.bytes_replicated
                    status.completed_jobs_24h += 1
                elif job.status == "failed":
                    status.failed_jobs_24h += 1
            
        except Exception as e:
            logger.error(f"Error executing replication job {job.job_id}: {e}")
            job.status = "failed"
            job.error_message = str(e)
            job.completed_at = datetime.utcnow()
    
    async def get_replication_status(self, bucket_name: str) -> Optional[ReplicationStatus]:
        """Get replication status for a bucket."""
        return self.replication_status.get(bucket_name)
    
    async def get_replication_jobs(self, bucket_name: Optional[str] = None, limit: int = 100) -> List[ReplicationJob]:
        """Get replication jobs."""
        jobs = list(self.replication_jobs.values())
        
        if bucket_name:
            jobs = [job for job in jobs if job.source_bucket == bucket_name]
        
        # Sort by creation time (most recent first)
        jobs.sort(key=lambda x: x.created_at, reverse=True)
        return jobs[:limit]
    
    async def get_replication_health(self) -> ReplicationHealthCheck:
        """Get replication system health."""
        try:
            total_configs = len(self.configurations)
            active_jobs = len([job for job in self.replication_jobs.values() if job.status == "running"])
            
            # Failed jobs in last hour
            one_hour_ago = datetime.utcnow() - timedelta(hours=1)
            failed_jobs_1h = len([
                job for job in self.replication_jobs.values()
                if job.status == "failed" and job.completed_at and job.completed_at > one_hour_ago
            ])
            
            # Calculate average replication lag
            completed_jobs = [
                job for job in self.replication_jobs.values()
                if job.status == "completed" and job.started_at and job.completed_at
            ]
            
            avg_lag = 0.0
            if completed_jobs:
                total_lag = sum(
                    (job.completed_at - job.started_at).total_seconds() * 1000
                    for job in completed_jobs[-100:]  # Last 100 jobs
                )
                avg_lag = total_lag / min(len(completed_jobs), 100)
            
            # Determine overall health
            if failed_jobs_1h > 10:
                overall_health = "critical"
            elif failed_jobs_1h > 5:
                overall_health = "warning"
            elif total_configs == 0:
                overall_health = "no_replication"
            else:
                overall_health = "healthy"
            
            # Issues and recommendations
            issues = []
            recommendations = []
            
            if failed_jobs_1h > 5:
                issues.append(f"{failed_jobs_1h} replication jobs failed in the last hour")
                recommendations.append("Check destination bucket connectivity and permissions")
            
            if avg_lag > 60000:  # More than 1 minute
                issues.append("High replication lag detected")
                recommendations.append("Consider increasing replication workers or checking network performance")
            
            if total_configs == 0:
                recommendations.append("Configure bucket replication to enable cross-bucket data redundancy")
            
            # Destination connectivity (simplified)
            destination_connectivity = {}
            for config in self.configurations.values():
                for rule in config.rules:
                    dest_bucket = rule.destination.bucket
                    # Simplified connectivity check
                    destination_connectivity[dest_bucket] = "connected"
            
            return ReplicationHealthCheck(
                overall_health=overall_health,
                total_configurations=total_configs,
                active_jobs=active_jobs,
                failed_jobs_1h=failed_jobs_1h,
                average_replication_lag_ms=avg_lag,
                destination_connectivity=destination_connectivity,
                issues=issues,
                recommendations=recommendations
            )
            
        except Exception as e:
            logger.error(f"Error getting replication health: {e}")
            raise
    
    async def generate_replication_report(self, bucket_name: str, days: int = 7) -> ReplicationReport:
        """Generate replication report for a bucket."""
        try:
            end_time = datetime.utcnow()
            start_time = end_time - timedelta(days=days)
            
            # Filter jobs by bucket and time range
            jobs = [
                job for job in self.replication_jobs.values()
                if job.source_bucket == bucket_name and
                job.created_at >= start_time
            ]
            
            total_objects = len(jobs)
            successful = len([job for job in jobs if job.status == "completed"])
            failed = len([job for job in jobs if job.status == "failed"])
            total_bytes = sum(job.bytes_replicated for job in jobs if job.status == "completed")
            
            # Calculate average replication time
            completed_jobs = [job for job in jobs if job.status == "completed" and job.started_at and job.completed_at]
            avg_time = 0.0
            if completed_jobs:
                total_time = sum(
                    (job.completed_at - job.started_at).total_seconds() * 1000
                    for job in completed_jobs
                )
                avg_time = total_time / len(completed_jobs)
            
            # Group by rule
            replication_by_rule = {}
            for job in jobs:
                if job.status == "completed":
                    replication_by_rule[job.rule_id] = replication_by_rule.get(job.rule_id, 0) + 1
            
            # Get destinations
            destinations = list(set(job.destination_bucket for job in jobs))
            
            import uuid
            return ReplicationReport(
                report_id=str(uuid.uuid4()),
                bucket_name=bucket_name,
                total_objects_replicated=total_objects,
                total_bytes_replicated=total_bytes,
                successful_replications=successful,
                failed_replications=failed,
                average_replication_time_ms=avg_time,
                replication_by_rule=replication_by_rule,
                destinations=destinations
            )
            
        except Exception as e:
            logger.error(f"Error generating replication report: {e}")
            raise


# Global replication service instance
replication_service = ReplicationService()

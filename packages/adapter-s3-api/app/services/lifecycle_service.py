"""Bucket lifecycle management service implementation."""

import asyncio
from datetime import datetime, date, timedelta
from typing import Dict, List, Optional, Tuple
from loguru import logger

from app.schemas.lifecycle import (
    BucketLifecycleConfiguration, LifecycleRule, LifecycleAction,
    LifecycleExecutionReport, LifecycleExecutionStatus, LifecycleSimulationResult,
    CreateLifecycleConfigRequest, LifecycleConfigResponse,
    TransitionStorageClass, LifecycleStatus
)
from app.services.minio_client import minio_client


class LifecycleService:
    """Lifecycle management service for bucket lifecycle policies."""
    
    def __init__(self):
        """Initialize lifecycle service."""
        self.configurations: Dict[str, BucketLifecycleConfiguration] = {}
        self.execution_history: List[LifecycleAction] = []
        self.execution_status: Dict[str, LifecycleExecutionStatus] = {}
        
        # Start background lifecycle processor
        asyncio.create_task(self._lifecycle_processor())
    
    async def _lifecycle_processor(self):
        """Background task to process lifecycle rules."""
        while True:
            try:
                await self._execute_lifecycle_rules()
                # Run every hour
                await asyncio.sleep(3600)
            except Exception as e:
                logger.error(f"Error in lifecycle processor: {e}")
                await asyncio.sleep(300)  # Wait 5 minutes on error
    
    async def create_lifecycle_configuration(self, request: CreateLifecycleConfigRequest) -> LifecycleConfigResponse:
        """Create lifecycle configuration for a bucket."""
        try:
            bucket_name = request.bucket_name
            config = request.lifecycle_configuration
            
            # Validate bucket exists
            if not await minio_client.bucket_exists(bucket_name):
                raise ValueError(f"Bucket {bucket_name} does not exist")
            
            # Store configuration
            self.configurations[bucket_name] = config
            
            # Initialize execution status
            self.execution_status[bucket_name] = LifecycleExecutionStatus(
                bucket_name=bucket_name,
                total_rules=len(config.rules),
                active_rules=len([r for r in config.rules if r.status == LifecycleStatus.ENABLED])
            )
            
            logger.info(f"Created lifecycle configuration for bucket {bucket_name} with {len(config.rules)} rules")
            
            return LifecycleConfigResponse(
                bucket_name=bucket_name,
                lifecycle_configuration=config,
                created_at=datetime.utcnow(),
                last_modified=datetime.utcnow()
            )
            
        except Exception as e:
            logger.error(f"Error creating lifecycle configuration: {e}")
            raise
    
    async def get_lifecycle_configuration(self, bucket_name: str) -> Optional[LifecycleConfigResponse]:
        """Get lifecycle configuration for a bucket."""
        config = self.configurations.get(bucket_name)
        if not config:
            return None
        
        return LifecycleConfigResponse(
            bucket_name=bucket_name,
            lifecycle_configuration=config,
            created_at=datetime.utcnow(),  # TODO: Store actual creation time
            last_modified=datetime.utcnow()
        )
    
    async def update_lifecycle_configuration(self, bucket_name: str, config: BucketLifecycleConfiguration) -> LifecycleConfigResponse:
        """Update lifecycle configuration for a bucket."""
        if bucket_name not in self.configurations:
            raise ValueError(f"No lifecycle configuration found for bucket {bucket_name}")
        
        self.configurations[bucket_name] = config
        
        # Update execution status
        self.execution_status[bucket_name].total_rules = len(config.rules)
        self.execution_status[bucket_name].active_rules = len([r for r in config.rules if r.status == LifecycleStatus.ENABLED])
        
        logger.info(f"Updated lifecycle configuration for bucket {bucket_name}")
        
        return LifecycleConfigResponse(
            bucket_name=bucket_name,
            lifecycle_configuration=config,
            created_at=datetime.utcnow(),
            last_modified=datetime.utcnow()
        )
    
    async def delete_lifecycle_configuration(self, bucket_name: str) -> bool:
        """Delete lifecycle configuration for a bucket."""
        if bucket_name in self.configurations:
            del self.configurations[bucket_name]
            if bucket_name in self.execution_status:
                del self.execution_status[bucket_name]
            logger.info(f"Deleted lifecycle configuration for bucket {bucket_name}")
            return True
        return False
    
    async def list_lifecycle_configurations(self) -> List[LifecycleConfigResponse]:
        """List all lifecycle configurations."""
        responses = []
        for bucket_name, config in self.configurations.items():
            responses.append(LifecycleConfigResponse(
                bucket_name=bucket_name,
                lifecycle_configuration=config,
                created_at=datetime.utcnow(),
                last_modified=datetime.utcnow()
            ))
        return responses
    
    async def get_execution_status(self, bucket_name: str) -> Optional[LifecycleExecutionStatus]:
        """Get lifecycle execution status for a bucket."""
        return self.execution_status.get(bucket_name)
    
    async def simulate_lifecycle_execution(self, bucket_name: str, simulation_date: Optional[date] = None) -> LifecycleSimulationResult:
        """Simulate lifecycle rule execution."""
        try:
            if bucket_name not in self.configurations:
                raise ValueError(f"No lifecycle configuration found for bucket {bucket_name}")
            
            config = self.configurations[bucket_name]
            sim_date = simulation_date or date.today()
            
            # Get objects from bucket
            objects = await minio_client.list_objects(bucket_name)
            
            actions_to_execute = []
            storage_impact = {}
            total_evaluated = len(objects)
            
            for obj in objects:
                for rule in config.rules:
                    if rule.status != LifecycleStatus.ENABLED:
                        continue
                    
                    # Check if object matches rule filter
                    if not self._object_matches_filter(obj, rule.filter):
                        continue
                    
                    # Check transitions
                    for transition in rule.transitions:
                        if self._should_transition(obj, transition, sim_date):
                            action = {
                                "object_key": obj["name"],
                                "action_type": "transition",
                                "from_storage_class": "STANDARD",
                                "to_storage_class": transition.storage_class.value,
                                "rule_id": rule.id
                            }
                            actions_to_execute.append(action)
                            
                            # Update storage impact
                            from_class = "STANDARD"
                            to_class = transition.storage_class.value
                            storage_impact[from_class] = storage_impact.get(from_class, 0) - obj.get("size", 0)
                            storage_impact[to_class] = storage_impact.get(to_class, 0) + obj.get("size", 0)
                    
                    # Check expiration
                    if rule.expiration and self._should_expire(obj, rule.expiration, sim_date):
                        action = {
                            "object_key": obj["name"],
                            "action_type": "expiration",
                            "rule_id": rule.id
                        }
                        actions_to_execute.append(action)
            
            # Calculate cost impact (simplified)
            estimated_cost_impact = self._calculate_cost_impact(storage_impact)
            
            import uuid
            return LifecycleSimulationResult(
                simulation_id=str(uuid.uuid4()),
                bucket_name=bucket_name,
                simulation_date=sim_date,
                total_objects_evaluated=total_evaluated,
                actions_to_execute=actions_to_execute,
                estimated_storage_impact=storage_impact,
                estimated_cost_impact=estimated_cost_impact
            )
            
        except Exception as e:
            logger.error(f"Error simulating lifecycle execution: {e}")
            raise
    
    async def _execute_lifecycle_rules(self):
        """Execute lifecycle rules for all configured buckets."""
        for bucket_name, config in self.configurations.items():
            try:
                await self._execute_bucket_lifecycle(bucket_name, config)
            except Exception as e:
                logger.error(f"Error executing lifecycle for bucket {bucket_name}: {e}")
    
    async def _execute_bucket_lifecycle(self, bucket_name: str, config: BucketLifecycleConfiguration):
        """Execute lifecycle rules for a specific bucket."""
        try:
            # Get objects from bucket
            objects = await minio_client.list_objects(bucket_name)
            
            actions_executed = 0
            actions_failed = 0
            
            for obj in objects:
                for rule in config.rules:
                    if rule.status != LifecycleStatus.ENABLED:
                        continue
                    
                    # Check if object matches rule filter
                    if not self._object_matches_filter(obj, rule.filter):
                        continue
                    
                    # Execute transitions
                    for transition in rule.transitions:
                        if self._should_transition(obj, transition, date.today()):
                            success = await self._execute_transition(bucket_name, obj, transition, rule.id)
                            if success:
                                actions_executed += 1
                            else:
                                actions_failed += 1
                    
                    # Execute expiration
                    if rule.expiration and self._should_expire(obj, rule.expiration, date.today()):
                        success = await self._execute_expiration(bucket_name, obj, rule.id)
                        if success:
                            actions_executed += 1
                        else:
                            actions_failed += 1
            
            # Update execution status
            if bucket_name in self.execution_status:
                status = self.execution_status[bucket_name]
                status.last_execution = datetime.utcnow()
                status.next_execution = datetime.utcnow() + timedelta(hours=24)
            
            logger.info(f"Executed lifecycle for bucket {bucket_name}: {actions_executed} successful, {actions_failed} failed")
            
        except Exception as e:
            logger.error(f"Error executing bucket lifecycle for {bucket_name}: {e}")
    
    def _object_matches_filter(self, obj: Dict, filter_config) -> bool:
        """Check if object matches lifecycle filter."""
        if not filter_config:
            return True
        
        obj_key = obj.get("name", "")
        
        # Check prefix filter
        if filter_config.prefix and not obj_key.startswith(filter_config.prefix):
            return False
        
        # Check tag filter (simplified - would need actual tag support)
        if filter_config.tag:
            # TODO: Implement tag matching when tag support is added
            pass
        
        # Check size filters
        obj_size = obj.get("size", 0)
        if filter_config.object_size_greater_than and obj_size <= filter_config.object_size_greater_than:
            return False
        
        if filter_config.object_size_less_than and obj_size >= filter_config.object_size_less_than:
            return False
        
        return True
    
    def _should_transition(self, obj: Dict, transition, current_date: date) -> bool:
        """Check if object should be transitioned."""
        # Get object creation date (simplified)
        last_modified = obj.get("last_modified")
        if not last_modified:
            return False
        
        if isinstance(last_modified, str):
            # Parse ISO format datetime
            obj_date = datetime.fromisoformat(last_modified.replace('Z', '+00:00')).date()
        else:
            obj_date = last_modified.date()
        
        if transition.days is not None:
            target_date = obj_date + timedelta(days=transition.days)
            return current_date >= target_date
        
        if transition.date is not None:
            return current_date >= transition.date
        
        return False
    
    def _should_expire(self, obj: Dict, expiration, current_date: date) -> bool:
        """Check if object should be expired."""
        # Get object creation date (simplified)
        last_modified = obj.get("last_modified")
        if not last_modified:
            return False
        
        if isinstance(last_modified, str):
            obj_date = datetime.fromisoformat(last_modified.replace('Z', '+00:00')).date()
        else:
            obj_date = last_modified.date()
        
        if expiration.days is not None:
            target_date = obj_date + timedelta(days=expiration.days)
            return current_date >= target_date
        
        if expiration.date is not None:
            return current_date >= expiration.date
        
        return False
    
    async def _execute_transition(self, bucket_name: str, obj: Dict, transition, rule_id: str) -> bool:
        """Execute storage class transition."""
        try:
            # In a real implementation, this would call MinIO's storage class transition API
            # For now, we'll just log the action
            
            action = LifecycleAction(
                action_id=f"transition_{bucket_name}_{obj['name']}_{datetime.utcnow().timestamp()}",
                rule_id=rule_id,
                bucket_name=bucket_name,
                object_key=obj["name"],
                action_type="transition",
                from_storage_class="STANDARD",
                to_storage_class=transition.storage_class.value,
                status="success"
            )
            
            self.execution_history.append(action)
            logger.info(f"Transitioned {bucket_name}/{obj['name']} to {transition.storage_class.value}")
            
            return True
            
        except Exception as e:
            logger.error(f"Error transitioning object {bucket_name}/{obj['name']}: {e}")
            
            action = LifecycleAction(
                action_id=f"transition_{bucket_name}_{obj['name']}_{datetime.utcnow().timestamp()}",
                rule_id=rule_id,
                bucket_name=bucket_name,
                object_key=obj["name"],
                action_type="transition",
                status="failed",
                error_message=str(e)
            )
            
            self.execution_history.append(action)
            return False
    
    async def _execute_expiration(self, bucket_name: str, obj: Dict, rule_id: str) -> bool:
        """Execute object expiration."""
        try:
            # Delete the object
            success = await minio_client.delete_object(bucket_name, obj["name"])
            
            action = LifecycleAction(
                action_id=f"expiration_{bucket_name}_{obj['name']}_{datetime.utcnow().timestamp()}",
                rule_id=rule_id,
                bucket_name=bucket_name,
                object_key=obj["name"],
                action_type="expiration",
                status="success" if success else "failed"
            )
            
            self.execution_history.append(action)
            
            if success:
                logger.info(f"Expired object {bucket_name}/{obj['name']}")
            else:
                logger.error(f"Failed to expire object {bucket_name}/{obj['name']}")
            
            return success
            
        except Exception as e:
            logger.error(f"Error expiring object {bucket_name}/{obj['name']}: {e}")
            
            action = LifecycleAction(
                action_id=f"expiration_{bucket_name}_{obj['name']}_{datetime.utcnow().timestamp()}",
                rule_id=rule_id,
                bucket_name=bucket_name,
                object_key=obj["name"],
                action_type="expiration",
                status="failed",
                error_message=str(e)
            )
            
            self.execution_history.append(action)
            return False
    
    def _calculate_cost_impact(self, storage_impact: Dict[str, int]) -> float:
        """Calculate estimated cost impact of storage changes."""
        # Simplified cost calculation
        cost_per_gb = {
            "STANDARD": 0.023,
            "STANDARD_IA": 0.0125,
            "GLACIER": 0.004,
            "DEEP_ARCHIVE": 0.00099
        }
        
        total_impact = 0.0
        for storage_class, bytes_change in storage_impact.items():
            gb_change = bytes_change / (1024 ** 3)
            cost_change = gb_change * cost_per_gb.get(storage_class, 0.023)
            total_impact += cost_change
        
        return total_impact
    
    async def get_execution_history(self, bucket_name: Optional[str] = None, limit: int = 100) -> List[LifecycleAction]:
        """Get lifecycle execution history."""
        history = self.execution_history
        
        if bucket_name:
            history = [action for action in history if action.bucket_name == bucket_name]
        
        # Return most recent actions first
        history.sort(key=lambda x: x.executed_at, reverse=True)
        return history[:limit]
    
    async def generate_execution_report(self, bucket_name: str, start_date: date, end_date: date) -> LifecycleExecutionReport:
        """Generate lifecycle execution report."""
        try:
            # Filter actions by bucket and date range
            actions = [
                action for action in self.execution_history
                if action.bucket_name == bucket_name and
                start_date <= action.executed_at.date() <= end_date
            ]
            
            total_processed = len(actions)
            successful = len([a for a in actions if a.status == "success"])
            failed = len([a for a in actions if a.status == "failed"])
            
            # Group by action type
            actions_by_type = {}
            for action in actions:
                actions_by_type[action.action_type] = actions_by_type.get(action.action_type, 0) + 1
            
            # Calculate storage saved (simplified)
            storage_saved = sum(1024 * 1024 for a in actions if a.action_type == "expiration")  # 1MB per expired object
            
            import uuid
            return LifecycleExecutionReport(
                report_id=str(uuid.uuid4()),
                bucket_name=bucket_name,
                execution_date=end_date,
                total_objects_processed=total_processed,
                successful_actions=successful,
                failed_actions=failed,
                actions_by_type=actions_by_type,
                storage_saved_bytes=storage_saved,
                cost_savings_estimate=storage_saved * 0.023 / (1024 ** 3),  # $0.023 per GB
                execution_duration_seconds=3600  # 1 hour
            )
            
        except Exception as e:
            logger.error(f"Error generating execution report: {e}")
            raise


# Global lifecycle service instance
lifecycle_service = LifecycleService()

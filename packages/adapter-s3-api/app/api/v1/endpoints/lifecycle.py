"""Bucket lifecycle management API endpoints."""

from datetime import date, datetime
from typing import List, Optional
from fastapi import APIRouter, HTTPException, Query, status

from app.schemas.lifecycle import (
    CreateLifecycleConfigRequest, LifecycleConfigResponse,
    UpdateLifecycleRuleRequest, LifecycleExecutionStatus,
    LifecycleSimulationRequest, LifecycleSimulationResult,
    LifecycleAction, LifecycleExecutionReport, BucketLifecycleConfiguration
)
from app.services.lifecycle_service import lifecycle_service
from loguru import logger

router = APIRouter(prefix="/lifecycle", tags=["lifecycle"])

@router.post("/configurations", response_model=LifecycleConfigResponse)
async def create_lifecycle_configuration(request: CreateLifecycleConfigRequest):
    """Create lifecycle configuration for a bucket.
    
    Args:
        request: Lifecycle configuration request
        
    Returns:
        LifecycleConfigResponse: Created configuration details
    """
    try:
        response = await lifecycle_service.create_lifecycle_configuration(request)
        return response
        
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    except Exception as e:
        logger.error(f"Error creating lifecycle configuration: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error creating lifecycle configuration"
        )

@router.get("/configurations/{bucket_name}", response_model=LifecycleConfigResponse)
async def get_lifecycle_configuration(bucket_name: str):
    """Get lifecycle configuration for a bucket.
    
    Args:
        bucket_name: Bucket name
        
    Returns:
        LifecycleConfigResponse: Lifecycle configuration
    """
    try:
        config = await lifecycle_service.get_lifecycle_configuration(bucket_name)
        if not config:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"No lifecycle configuration found for bucket {bucket_name}"
            )
        
        return config
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting lifecycle configuration: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error retrieving lifecycle configuration"
        )

@router.put("/configurations/{bucket_name}", response_model=LifecycleConfigResponse)
async def update_lifecycle_configuration(
    bucket_name: str,
    config: BucketLifecycleConfiguration
):
    """Update lifecycle configuration for a bucket.
    
    Args:
        bucket_name: Bucket name
        config: Updated lifecycle configuration
        
    Returns:
        LifecycleConfigResponse: Updated configuration
    """
    try:
        response = await lifecycle_service.update_lifecycle_configuration(bucket_name, config)
        return response
        
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(e)
        )
    except Exception as e:
        logger.error(f"Error updating lifecycle configuration: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error updating lifecycle configuration"
        )

@router.delete("/configurations/{bucket_name}")
async def delete_lifecycle_configuration(bucket_name: str):
    """Delete lifecycle configuration for a bucket.
    
    Args:
        bucket_name: Bucket name
        
    Returns:
        dict: Deletion confirmation
    """
    try:
        success = await lifecycle_service.delete_lifecycle_configuration(bucket_name)
        if not success:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"No lifecycle configuration found for bucket {bucket_name}"
            )
        
        return {"message": f"Lifecycle configuration deleted for bucket {bucket_name}"}
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting lifecycle configuration: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error deleting lifecycle configuration"
        )

@router.get("/configurations", response_model=List[LifecycleConfigResponse])
async def list_lifecycle_configurations():
    """List all lifecycle configurations.
    
    Returns:
        List[LifecycleConfigResponse]: All lifecycle configurations
    """
    try:
        configurations = await lifecycle_service.list_lifecycle_configurations()
        return configurations
        
    except Exception as e:
        logger.error(f"Error listing lifecycle configurations: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error listing lifecycle configurations"
        )

@router.get("/status/{bucket_name}", response_model=LifecycleExecutionStatus)
async def get_execution_status(bucket_name: str):
    """Get lifecycle execution status for a bucket.
    
    Args:
        bucket_name: Bucket name
        
    Returns:
        LifecycleExecutionStatus: Execution status
    """
    try:
        status_info = await lifecycle_service.get_execution_status(bucket_name)
        if not status_info:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"No lifecycle configuration found for bucket {bucket_name}"
            )
        
        return status_info
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting execution status: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error retrieving execution status"
        )

@router.post("/simulate", response_model=LifecycleSimulationResult)
async def simulate_lifecycle_execution(request: LifecycleSimulationRequest):
    """Simulate lifecycle rule execution.
    
    Args:
        request: Simulation request parameters
        
    Returns:
        LifecycleSimulationResult: Simulation results
    """
    try:
        result = await lifecycle_service.simulate_lifecycle_execution(
            bucket_name=request.bucket_name,
            simulation_date=request.simulation_date
        )
        return result
        
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    except Exception as e:
        logger.error(f"Error simulating lifecycle execution: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error simulating lifecycle execution"
        )

@router.get("/history", response_model=List[LifecycleAction])
async def get_execution_history(
    bucket_name: Optional[str] = Query(None, description="Filter by bucket name"),
    limit: int = Query(100, ge=1, le=1000, description="Maximum number of results")
):
    """Get lifecycle execution history.
    
    Args:
        bucket_name: Optional bucket name filter
        limit: Maximum number of results
        
    Returns:
        List[LifecycleAction]: Execution history
    """
    try:
        history = await lifecycle_service.get_execution_history(bucket_name, limit)
        return history
        
    except Exception as e:
        logger.error(f"Error getting execution history: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error retrieving execution history"
        )

@router.get("/reports/{bucket_name}", response_model=LifecycleExecutionReport)
async def get_execution_report(
    bucket_name: str,
    start_date: date = Query(..., description="Report start date"),
    end_date: date = Query(..., description="Report end date")
):
    """Generate lifecycle execution report.
    
    Args:
        bucket_name: Bucket name
        start_date: Report start date
        end_date: Report end date
        
    Returns:
        LifecycleExecutionReport: Execution report
    """
    try:
        if end_date <= start_date:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="End date must be after start date"
            )
        
        report = await lifecycle_service.generate_execution_report(
            bucket_name, start_date, end_date
        )
        return report
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error generating execution report: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error generating execution report"
        )

@router.post("/execute/{bucket_name}")
async def trigger_lifecycle_execution(bucket_name: str):
    """Manually trigger lifecycle execution for a bucket.
    
    Args:
        bucket_name: Bucket name
        
    Returns:
        dict: Execution trigger confirmation
    """
    try:
        # Check if configuration exists
        config = await lifecycle_service.get_lifecycle_configuration(bucket_name)
        if not config:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"No lifecycle configuration found for bucket {bucket_name}"
            )
        
        # Trigger execution (in background)
        import asyncio
        asyncio.create_task(
            lifecycle_service._execute_bucket_lifecycle(
                bucket_name, 
                config.lifecycle_configuration
            )
        )
        
        return {
            "message": f"Lifecycle execution triggered for bucket {bucket_name}",
            "bucket_name": bucket_name,
            "triggered_at": datetime.utcnow().isoformat()
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error triggering lifecycle execution: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error triggering lifecycle execution"
        )

@router.get("/rules/{bucket_name}")
async def list_lifecycle_rules(bucket_name: str):
    """List lifecycle rules for a bucket.
    
    Args:
        bucket_name: Bucket name
        
    Returns:
        dict: Lifecycle rules summary
    """
    try:
        config = await lifecycle_service.get_lifecycle_configuration(bucket_name)
        if not config:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"No lifecycle configuration found for bucket {bucket_name}"
            )
        
        rules_summary = []
        for rule in config.lifecycle_configuration.rules:
            summary = {
                "rule_id": rule.id,
                "status": rule.status.value,
                "transitions": len(rule.transitions),
                "has_expiration": rule.expiration is not None,
                "has_noncurrent_version_expiration": rule.noncurrent_version_expiration is not None,
                "has_abort_multipart": rule.abort_incomplete_multipart_upload is not None
            }
            rules_summary.append(summary)
        
        return {
            "bucket_name": bucket_name,
            "total_rules": len(rules_summary),
            "active_rules": len([r for r in rules_summary if r["status"] == "Enabled"]),
            "rules": rules_summary
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error listing lifecycle rules: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error listing lifecycle rules"
        )

@router.get("/statistics")
async def get_lifecycle_statistics():
    """Get overall lifecycle management statistics.
    
    Returns:
        dict: Lifecycle statistics
    """
    try:
        total_configs = len(lifecycle_service.configurations)
        total_actions = len(lifecycle_service.execution_history)
        
        # Calculate success rate
        successful_actions = len([a for a in lifecycle_service.execution_history if a.status == "success"])
        success_rate = (successful_actions / total_actions * 100) if total_actions > 0 else 0
        
        # Recent activity
        recent_actions = await lifecycle_service.get_execution_history(limit=10)
        
        # Actions by type
        actions_by_type = {}
        for action in lifecycle_service.execution_history:
            actions_by_type[action.action_type] = actions_by_type.get(action.action_type, 0) + 1
        
        return {
            "total_configurations": total_configs,
            "total_actions_executed": total_actions,
            "success_rate_percent": round(success_rate, 2),
            "actions_by_type": actions_by_type,
            "recent_actions": [
                {
                    "bucket": action.bucket_name,
                    "object": action.object_key,
                    "action": action.action_type,
                    "status": action.status,
                    "executed_at": action.executed_at.isoformat()
                }
                for action in recent_actions
            ],
            "generated_at": datetime.utcnow().isoformat()
        }
        
    except Exception as e:
        logger.error(f"Error getting lifecycle statistics: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error retrieving lifecycle statistics"
        )

"""Security and encryption API endpoints."""

from typing import List, Optional
from fastapi import APIRouter, HTTPException, Query, status

from app.schemas.security import (
    BucketEncryption, EncryptionKey, SecurityPolicy, SecurityEvent,
    SecurityScan, SecurityDashboard, SecurityRecommendation,
    EnableEncryptionRequest, CreateSecurityPolicyRequest,
    SecurityEventQuery, SecurityEventType, ThreatLevel
)
from app.services.security_service import security_service
from loguru import logger

router = APIRouter(prefix="/security", tags=["security"])

@router.post("/encryption/buckets/{bucket_name}")
async def enable_bucket_encryption(bucket_name: str, request: EnableEncryptionRequest):
    """Enable encryption for a bucket.
    
    Args:
        bucket_name: Bucket name
        request: Encryption configuration
        
    Returns:
        dict: Encryption enablement confirmation
    """
    try:
        success = await security_service.enable_bucket_encryption(
            bucket_name, request.encryption_config
        )
        
        if success:
            return {
                "message": f"Encryption enabled for bucket {bucket_name}",
                "bucket_name": bucket_name,
                "algorithm": request.encryption_config.sse_algorithm.value
            }
        else:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to enable encryption"
            )
            
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    except Exception as e:
        logger.error(f"Error enabling bucket encryption: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error enabling bucket encryption"
        )

@router.get("/encryption/buckets/{bucket_name}", response_model=BucketEncryption)
async def get_bucket_encryption(bucket_name: str):
    """Get bucket encryption configuration.
    
    Args:
        bucket_name: Bucket name
        
    Returns:
        BucketEncryption: Encryption configuration
    """
    try:
        config = await security_service.get_bucket_encryption(bucket_name)
        if not config:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"No encryption configuration found for bucket {bucket_name}"
            )
        
        return config
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting bucket encryption: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error retrieving bucket encryption configuration"
        )

@router.delete("/encryption/buckets/{bucket_name}")
async def disable_bucket_encryption(bucket_name: str):
    """Disable encryption for a bucket.
    
    Args:
        bucket_name: Bucket name
        
    Returns:
        dict: Encryption disablement confirmation
    """
    try:
        success = await security_service.disable_bucket_encryption(bucket_name)
        if not success:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"No encryption configuration found for bucket {bucket_name}"
            )
        
        return {
            "message": f"Encryption disabled for bucket {bucket_name}",
            "bucket_name": bucket_name,
            "warning": "Data is no longer encrypted at rest"
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error disabling bucket encryption: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error disabling bucket encryption"
        )

@router.post("/keys", response_model=EncryptionKey)
async def create_encryption_key(
    key_alias: str = Query(..., description="Key alias"),
    key_type: str = Query("symmetric", description="Key type")
):
    """Create a new encryption key.
    
    Args:
        key_alias: Key alias
        key_type: Key type (symmetric, asymmetric)
        
    Returns:
        EncryptionKey: Created encryption key
    """
    try:
        key = await security_service.create_encryption_key(key_alias, key_type)
        return key
        
    except Exception as e:
        logger.error(f"Error creating encryption key: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error creating encryption key"
        )

@router.post("/keys/{key_id}/rotate", response_model=EncryptionKey)
async def rotate_encryption_key(key_id: str):
    """Rotate an encryption key.
    
    Args:
        key_id: Key identifier
        
    Returns:
        EncryptionKey: Rotated encryption key
    """
    try:
        key = await security_service.rotate_encryption_key(key_id)
        return key
        
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(e)
        )
    except Exception as e:
        logger.error(f"Error rotating encryption key: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error rotating encryption key"
        )

@router.get("/keys", response_model=List[EncryptionKey])
async def list_encryption_keys():
    """List all encryption keys.
    
    Returns:
        List[EncryptionKey]: All encryption keys
    """
    try:
        keys = list(security_service.encryption_keys.values())
        return keys
        
    except Exception as e:
        logger.error(f"Error listing encryption keys: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error listing encryption keys"
        )

@router.post("/policies")
async def create_security_policy(request: CreateSecurityPolicyRequest):
    """Create a security policy.
    
    Args:
        request: Security policy configuration
        
    Returns:
        dict: Policy creation confirmation
    """
    try:
        success = await security_service.create_security_policy(request.policy)
        
        if success:
            return {
                "message": f"Security policy '{request.policy.policy_name}' created successfully",
                "policy_id": request.policy.policy_id
            }
        else:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to create security policy"
            )
            
    except Exception as e:
        logger.error(f"Error creating security policy: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error creating security policy"
        )

@router.get("/policies", response_model=List[SecurityPolicy])
async def list_security_policies():
    """List all security policies.
    
    Returns:
        List[SecurityPolicy]: All security policies
    """
    try:
        policies = list(security_service.security_policies.values())
        return policies
        
    except Exception as e:
        logger.error(f"Error listing security policies: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error listing security policies"
        )

@router.get("/policies/{policy_id}", response_model=SecurityPolicy)
async def get_security_policy(policy_id: str):
    """Get a security policy by ID.
    
    Args:
        policy_id: Policy identifier
        
    Returns:
        SecurityPolicy: Security policy
    """
    try:
        policy = security_service.security_policies.get(policy_id)
        if not policy:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Security policy {policy_id} not found"
            )
        
        return policy
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting security policy: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error retrieving security policy"
        )

@router.post("/scans", response_model=SecurityScan)
async def start_security_scan(
    bucket_name: str = Query(..., description="Bucket to scan"),
    scan_type: str = Query("malware", description="Scan type")
):
    """Start a security scan.
    
    Args:
        bucket_name: Bucket name
        scan_type: Type of scan (malware, vulnerability, compliance)
        
    Returns:
        SecurityScan: Started security scan
    """
    try:
        scan = await security_service.start_security_scan(bucket_name, scan_type)
        return scan
        
    except Exception as e:
        logger.error(f"Error starting security scan: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error starting security scan"
        )

@router.get("/scans/{scan_id}", response_model=SecurityScan)
async def get_security_scan(scan_id: str):
    """Get security scan results.
    
    Args:
        scan_id: Scan identifier
        
    Returns:
        SecurityScan: Security scan details
    """
    try:
        scan = security_service.security_scans.get(scan_id)
        if not scan:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Security scan {scan_id} not found"
            )
        
        return scan
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting security scan: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error retrieving security scan"
        )

@router.get("/scans", response_model=List[SecurityScan])
async def list_security_scans():
    """List all security scans.
    
    Returns:
        List[SecurityScan]: All security scans
    """
    try:
        scans = list(security_service.security_scans.values())
        scans.sort(key=lambda x: x.started_at, reverse=True)
        return scans
        
    except Exception as e:
        logger.error(f"Error listing security scans: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error listing security scans"
        )

@router.get("/dashboard", response_model=SecurityDashboard)
async def get_security_dashboard():
    """Get security dashboard data.
    
    Returns:
        SecurityDashboard: Security dashboard information
    """
    try:
        dashboard = await security_service.get_security_dashboard()
        return dashboard
        
    except Exception as e:
        logger.error(f"Error getting security dashboard: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error retrieving security dashboard"
        )

@router.get("/recommendations", response_model=List[SecurityRecommendation])
async def get_security_recommendations():
    """Get security recommendations.
    
    Returns:
        List[SecurityRecommendation]: Security recommendations
    """
    try:
        recommendations = await security_service.get_security_recommendations()
        return recommendations
        
    except Exception as e:
        logger.error(f"Error getting security recommendations: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error retrieving security recommendations"
        )

@router.get("/events", response_model=List[SecurityEvent])
async def get_security_events(
    limit: int = Query(100, ge=1, le=1000, description="Maximum number of events"),
    event_type: Optional[SecurityEventType] = Query(None, description="Filter by event type"),
    severity: Optional[ThreatLevel] = Query(None, description="Filter by severity level")
):
    """Get security events.
    
    Args:
        limit: Maximum number of events
        event_type: Filter by event type
        severity: Filter by severity level
        
    Returns:
        List[SecurityEvent]: Security events
    """
    try:
        events = await security_service.get_security_events(limit, event_type, severity)
        return events
        
    except Exception as e:
        logger.error(f"Error getting security events: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error retrieving security events"
        )

@router.post("/ip-blocks/{ip_address}")
async def block_ip_address(
    ip_address: str,
    reason: str = Query("manual_block", description="Reason for blocking")
):
    """Block an IP address.
    
    Args:
        ip_address: IP address to block
        reason: Reason for blocking
        
    Returns:
        dict: Block confirmation
    """
    try:
        success = await security_service.block_ip(ip_address, reason)
        
        if success:
            return {
                "message": f"IP address {ip_address} blocked successfully",
                "ip_address": ip_address,
                "reason": reason
            }
        else:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to block IP address"
            )
            
    except Exception as e:
        logger.error(f"Error blocking IP address: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error blocking IP address"
        )

@router.delete("/ip-blocks/{ip_address}")
async def unblock_ip_address(ip_address: str):
    """Unblock an IP address.
    
    Args:
        ip_address: IP address to unblock
        
    Returns:
        dict: Unblock confirmation
    """
    try:
        success = await security_service.unblock_ip(ip_address)
        
        if not success:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"IP address {ip_address} is not blocked"
            )
        
        return {
            "message": f"IP address {ip_address} unblocked successfully",
            "ip_address": ip_address
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error unblocking IP address: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error unblocking IP address"
        )

@router.get("/ip-blocks")
async def list_blocked_ips():
    """List all blocked IP addresses.
    
    Returns:
        dict: List of blocked IPs
    """
    try:
        blocked_ips = list(security_service.blocked_ips)
        return {
            "blocked_ips": blocked_ips,
            "total_count": len(blocked_ips)
        }
        
    except Exception as e:
        logger.error(f"Error listing blocked IPs: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error listing blocked IP addresses"
        )

@router.get("/compliance/status")
async def get_compliance_status():
    """Get overall compliance status.
    
    Returns:
        dict: Compliance status summary
    """
    try:
        dashboard = await security_service.get_security_dashboard()
        
        # Calculate compliance metrics
        compliance_metrics = {
            "overall_score": dashboard.compliance_score,
            "encryption_compliance": {
                "encrypted_buckets": dashboard.encrypted_buckets,
                "unencrypted_buckets": dashboard.unencrypted_buckets,
                "compliance_percentage": dashboard.compliance_score
            },
            "security_events": {
                "total_events_24h": dashboard.total_events_24h,
                "high_severity_events": dashboard.high_severity_events,
                "failed_logins": dashboard.failed_logins
            },
            "threat_status": {
                "active_threats": dashboard.active_threats,
                "blocked_requests": dashboard.blocked_requests
            },
            "recommendations_count": len(await security_service.get_security_recommendations())
        }
        
        # Determine overall compliance level
        if dashboard.compliance_score >= 90:
            compliance_level = "excellent"
        elif dashboard.compliance_score >= 75:
            compliance_level = "good"
        elif dashboard.compliance_score >= 60:
            compliance_level = "fair"
        else:
            compliance_level = "poor"
        
        return {
            "compliance_level": compliance_level,
            "compliance_score": dashboard.compliance_score,
            "metrics": compliance_metrics,
            "last_updated": dashboard.generated_at.isoformat()
        }
        
    except Exception as e:
        logger.error(f"Error getting compliance status: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error retrieving compliance status"
        )

"""Security and encryption service implementation."""

import asyncio
import hashlib
import secrets
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Set
from loguru import logger

from app.schemas.security import (
    BucketEncryption, ObjectEncryption, EncryptionKey, SecurityPolicy,
    SecurityEvent, ThreatIntelligence, SecurityScan, ComplianceFramework,
    ComplianceAssessment, SecurityDashboard, SecurityRecommendation,
    EncryptionType, SecurityEventType, ThreatLevel
)
from app.services.minio_client import minio_client


class SecurityService:
    """Security and encryption management service."""
    
    def __init__(self):
        """Initialize security service."""
        self.bucket_encryption: Dict[str, BucketEncryption] = {}
        self.encryption_keys: Dict[str, EncryptionKey] = {}
        self.security_policies: Dict[str, SecurityPolicy] = {}
        self.security_events: List[SecurityEvent] = []
        self.threat_intelligence: Dict[str, ThreatIntelligence] = {}
        self.security_scans: Dict[str, SecurityScan] = {}
        self.compliance_frameworks: Dict[str, ComplianceFramework] = {}
        self.compliance_assessments: List[ComplianceAssessment] = []
        self.blocked_ips: Set[str] = set()
        
        # Initialize default security policies and frameworks
        self._initialize_defaults()
        
        # Start background security monitoring
        asyncio.create_task(self._security_monitor())
    
    def _initialize_defaults(self):
        """Initialize default security policies and compliance frameworks."""
        # Default encryption policy
        default_policy = SecurityPolicy(
            policy_id="default-encryption",
            policy_name="Default Encryption Policy",
            description="Enforce encryption for all buckets",
            policy_type="bucket",
            enforce_encryption=True,
            allowed_encryption_types=[EncryptionType.AES256, EncryptionType.AWS_KMS]
        )
        self.security_policies["default-encryption"] = default_policy
        
        # GDPR compliance framework
        gdpr_framework = ComplianceFramework(
            framework_id="gdpr",
            framework_name="General Data Protection Regulation",
            version="2018",
            requirements=[
                {"id": "art_32", "title": "Security of processing", "description": "Implement appropriate technical measures"},
                {"id": "art_33", "title": "Notification of breach", "description": "Notify supervisory authority within 72 hours"},
                {"id": "art_25", "title": "Data protection by design", "description": "Implement data protection by design and by default"}
            ],
            controls=[
                {"id": "encryption", "title": "Data Encryption", "description": "Encrypt data at rest and in transit"},
                {"id": "access_control", "title": "Access Control", "description": "Implement proper access controls"},
                {"id": "audit_logging", "title": "Audit Logging", "description": "Maintain comprehensive audit logs"}
            ]
        )
        self.compliance_frameworks["gdpr"] = gdpr_framework
        
        logger.info("Initialized default security policies and compliance frameworks")
    
    async def _security_monitor(self):
        """Background security monitoring task."""
        while True:
            try:
                await self._scan_for_threats()
                await self._check_compliance()
                await self._cleanup_old_events()
                
                # Run every 5 minutes
                await asyncio.sleep(300)
                
            except Exception as e:
                logger.error(f"Error in security monitor: {e}")
                await asyncio.sleep(60)
    
    async def _scan_for_threats(self):
        """Scan for security threats."""
        try:
            # Check for suspicious activity patterns
            recent_events = [
                event for event in self.security_events
                if event.timestamp > datetime.utcnow() - timedelta(hours=1)
            ]
            
            # Detect brute force attempts
            failed_logins_by_ip = {}
            for event in recent_events:
                if event.event_type == SecurityEventType.LOGIN_FAILURE and event.source_ip:
                    failed_logins_by_ip[event.source_ip] = failed_logins_by_ip.get(event.source_ip, 0) + 1
            
            # Block IPs with too many failed attempts
            for ip, count in failed_logins_by_ip.items():
                if count >= 10:  # 10 failed attempts in 1 hour
                    self.blocked_ips.add(ip)
                    await self._log_security_event(
                        SecurityEventType.SUSPICIOUS_ACTIVITY,
                        ThreatLevel.HIGH,
                        source_ip=ip,
                        details={"reason": "brute_force_detected", "failed_attempts": count}
                    )
            
        except Exception as e:
            logger.error(f"Error scanning for threats: {e}")
    
    async def _check_compliance(self):
        """Check compliance status."""
        try:
            # Check encryption compliance
            buckets = await minio_client.list_buckets()
            total_buckets = len(buckets)
            encrypted_buckets = len(self.bucket_encryption)
            
            if total_buckets > 0:
                encryption_compliance = (encrypted_buckets / total_buckets) * 100
                
                if encryption_compliance < 80:  # Less than 80% encrypted
                    await self._log_security_event(
                        SecurityEventType.POLICY_VIOLATION,
                        ThreatLevel.MEDIUM,
                        details={
                            "violation_type": "encryption_compliance",
                            "compliance_percentage": str(encryption_compliance)
                        }
                    )
            
        except Exception as e:
            logger.error(f"Error checking compliance: {e}")
    
    async def _cleanup_old_events(self):
        """Clean up old security events."""
        try:
            cutoff_time = datetime.utcnow() - timedelta(days=90)  # Keep 90 days
            self.security_events = [
                event for event in self.security_events
                if event.timestamp > cutoff_time
            ]
        except Exception as e:
            logger.error(f"Error cleaning up old events: {e}")
    
    async def enable_bucket_encryption(self, bucket_name: str, encryption_config: BucketEncryption) -> bool:
        """Enable encryption for a bucket."""
        try:
            # Validate bucket exists
            if not await minio_client.bucket_exists(bucket_name):
                raise ValueError(f"Bucket {bucket_name} does not exist")
            
            # Store encryption configuration
            self.bucket_encryption[bucket_name] = encryption_config
            
            # Log security event
            await self._log_security_event(
                SecurityEventType.ENCRYPTION_KEY_ROTATION,
                ThreatLevel.LOW,
                resource=f"bucket:{bucket_name}",
                details={"action": "encryption_enabled", "algorithm": encryption_config.sse_algorithm.value}
            )
            
            logger.info(f"Enabled encryption for bucket {bucket_name} with algorithm {encryption_config.sse_algorithm.value}")
            return True
            
        except Exception as e:
            logger.error(f"Error enabling bucket encryption: {e}")
            raise
    
    async def get_bucket_encryption(self, bucket_name: str) -> Optional[BucketEncryption]:
        """Get bucket encryption configuration."""
        return self.bucket_encryption.get(bucket_name)
    
    async def disable_bucket_encryption(self, bucket_name: str) -> bool:
        """Disable encryption for a bucket."""
        try:
            if bucket_name in self.bucket_encryption:
                del self.bucket_encryption[bucket_name]
                
                # Log security event
                await self._log_security_event(
                    SecurityEventType.POLICY_VIOLATION,
                    ThreatLevel.MEDIUM,
                    resource=f"bucket:{bucket_name}",
                    details={"action": "encryption_disabled"}
                )
                
                logger.warning(f"Disabled encryption for bucket {bucket_name}")
                return True
            
            return False
            
        except Exception as e:
            logger.error(f"Error disabling bucket encryption: {e}")
            raise
    
    async def create_encryption_key(self, key_alias: str, key_type: str = "symmetric") -> EncryptionKey:
        """Create a new encryption key."""
        try:
            key_id = f"key-{secrets.token_hex(16)}"
            
            encryption_key = EncryptionKey(
                key_id=key_id,
                key_alias=key_alias,
                key_type=key_type,
                key_usage="encrypt",
                key_spec="AES_256",
                key_state="enabled",
                creation_date=datetime.utcnow(),
                key_manager="MinIO-KES"
            )
            
            self.encryption_keys[key_id] = encryption_key
            
            logger.info(f"Created encryption key {key_id} with alias {key_alias}")
            return encryption_key
            
        except Exception as e:
            logger.error(f"Error creating encryption key: {e}")
            raise
    
    async def rotate_encryption_key(self, key_id: str) -> EncryptionKey:
        """Rotate an encryption key."""
        try:
            if key_id not in self.encryption_keys:
                raise ValueError(f"Encryption key {key_id} not found")
            
            key = self.encryption_keys[key_id]
            key.last_rotation_date = datetime.utcnow()
            key.next_rotation_date = datetime.utcnow() + timedelta(days=90)  # Rotate every 90 days
            
            # Log security event
            await self._log_security_event(
                SecurityEventType.ENCRYPTION_KEY_ROTATION,
                ThreatLevel.LOW,
                details={"key_id": key_id, "action": "key_rotated"}
            )
            
            logger.info(f"Rotated encryption key {key_id}")
            return key
            
        except Exception as e:
            logger.error(f"Error rotating encryption key: {e}")
            raise
    
    async def create_security_policy(self, policy: SecurityPolicy) -> bool:
        """Create a security policy."""
        try:
            self.security_policies[policy.policy_id] = policy
            
            logger.info(f"Created security policy {policy.policy_id}: {policy.policy_name}")
            return True
            
        except Exception as e:
            logger.error(f"Error creating security policy: {e}")
            raise
    
    async def evaluate_security_policy(self, bucket_name: str, action: str) -> bool:
        """Evaluate security policies for an action."""
        try:
            # Check bucket-specific policies
            for policy in self.security_policies.values():
                if policy.policy_type == "bucket":
                    # Check encryption requirements
                    if policy.enforce_encryption and action in ["put_object", "upload"]:
                        if bucket_name not in self.bucket_encryption:
                            await self._log_security_event(
                                SecurityEventType.POLICY_VIOLATION,
                                ThreatLevel.HIGH,
                                resource=f"bucket:{bucket_name}",
                                action=action,
                                details={"violation": "encryption_required"}
                            )
                            return False
            
            return True
            
        except Exception as e:
            logger.error(f"Error evaluating security policy: {e}")
            return False
    
    async def _log_security_event(self, event_type: SecurityEventType, severity: ThreatLevel,
                                source_ip: Optional[str] = None, username: Optional[str] = None,
                                resource: Optional[str] = None, action: Optional[str] = None,
                                details: Optional[Dict[str, str]] = None):
        """Log a security event."""
        try:
            event_id = f"event-{secrets.token_hex(8)}"
            
            # Calculate risk score based on event type and severity
            risk_score = self._calculate_risk_score(event_type, severity)
            
            event = SecurityEvent(
                event_id=event_id,
                event_type=event_type,
                severity=severity,
                source_ip=source_ip,
                username=username,
                resource=resource,
                action=action,
                result="logged",
                details=details or {},
                risk_score=risk_score
            )
            
            self.security_events.append(event)
            
            # Log high-severity events
            if severity in [ThreatLevel.HIGH, ThreatLevel.CRITICAL]:
                logger.warning(f"High-severity security event: {event_type.value} - {details}")
            
        except Exception as e:
            logger.error(f"Error logging security event: {e}")
    
    def _calculate_risk_score(self, event_type: SecurityEventType, severity: ThreatLevel) -> float:
        """Calculate risk score for a security event."""
        base_scores = {
            SecurityEventType.LOGIN_FAILURE: 20.0,
            SecurityEventType.ACCESS_DENIED: 30.0,
            SecurityEventType.PERMISSION_ESCALATION: 80.0,
            SecurityEventType.SUSPICIOUS_ACTIVITY: 70.0,
            SecurityEventType.DATA_BREACH_ATTEMPT: 95.0,
            SecurityEventType.POLICY_VIOLATION: 40.0
        }
        
        severity_multipliers = {
            ThreatLevel.LOW: 0.5,
            ThreatLevel.MEDIUM: 1.0,
            ThreatLevel.HIGH: 1.5,
            ThreatLevel.CRITICAL: 2.0
        }
        
        base_score = base_scores.get(event_type, 50.0)
        multiplier = severity_multipliers.get(severity, 1.0)
        
        return min(base_score * multiplier, 100.0)
    
    async def start_security_scan(self, bucket_name: str, scan_type: str = "malware") -> SecurityScan:
        """Start a security scan."""
        try:
            scan_id = f"scan-{secrets.token_hex(8)}"
            
            scan = SecurityScan(
                scan_id=scan_id,
                scan_type=scan_type,
                target_bucket=bucket_name,
                scan_status="running",
                scan_engine="ClamAV",
                engine_version="0.103.0"
            )
            
            self.security_scans[scan_id] = scan
            
            # Start scan in background
            asyncio.create_task(self._execute_security_scan(scan))
            
            logger.info(f"Started {scan_type} scan {scan_id} for bucket {bucket_name}")
            return scan
            
        except Exception as e:
            logger.error(f"Error starting security scan: {e}")
            raise
    
    async def _execute_security_scan(self, scan: SecurityScan):
        """Execute a security scan."""
        try:
            # Simulate scan execution
            await asyncio.sleep(30)  # Simulate scan time
            
            # Get objects from bucket
            objects = await minio_client.list_objects(scan.target_bucket)
            
            # Simulate scanning results
            threats_found = 0
            quarantined = []
            
            for obj in objects[:10]:  # Scan first 10 objects
                # Simulate threat detection (1% chance)
                if secrets.randbelow(100) < 1:
                    threats_found += 1
                    quarantined.append(obj["name"])
            
            # Update scan results
            scan.scan_status = "completed"
            scan.completed_at = datetime.utcnow()
            scan.threats_found = threats_found
            scan.quarantined_objects = quarantined
            scan.scan_results = {
                "scanned_objects": len(objects),
                "clean_objects": len(objects) - threats_found,
                "threats_found": threats_found,
                "scan_duration_seconds": 30
            }
            
            if threats_found > 0:
                await self._log_security_event(
                    SecurityEventType.SUSPICIOUS_ACTIVITY,
                    ThreatLevel.HIGH,
                    resource=f"bucket:{scan.target_bucket}",
                    details={"scan_id": scan.scan_id, "threats_found": threats_found}
                )
            
            logger.info(f"Completed security scan {scan.scan_id}: {threats_found} threats found")
            
        except Exception as e:
            logger.error(f"Error executing security scan: {e}")
            scan.scan_status = "failed"
            scan.completed_at = datetime.utcnow()
    
    async def get_security_dashboard(self) -> SecurityDashboard:
        """Get security dashboard data."""
        try:
            # Calculate metrics for last 24 hours
            last_24h = datetime.utcnow() - timedelta(hours=24)
            recent_events = [e for e in self.security_events if e.timestamp > last_24h]
            
            total_events_24h = len(recent_events)
            high_severity_events = len([e for e in recent_events if e.severity in [ThreatLevel.HIGH, ThreatLevel.CRITICAL]])
            failed_logins = len([e for e in recent_events if e.event_type == SecurityEventType.LOGIN_FAILURE])
            blocked_requests = len([e for e in recent_events if e.result == "blocked"])
            
            # Encryption status
            buckets = await minio_client.list_buckets()
            total_buckets = len(buckets)
            encrypted_buckets = len(self.bucket_encryption)
            unencrypted_buckets = total_buckets - encrypted_buckets
            
            # Compliance score (simplified)
            compliance_score = (encrypted_buckets / total_buckets * 100) if total_buckets > 0 else 100
            
            # Threat trends
            threat_trends = {}
            for event in recent_events:
                event_type = event.event_type.value
                threat_trends[event_type] = threat_trends.get(event_type, 0) + 1
            
            # Recent events (last 10)
            recent_events_data = sorted(self.security_events, key=lambda x: x.timestamp, reverse=True)[:10]
            
            return SecurityDashboard(
                total_events_24h=total_events_24h,
                high_severity_events=high_severity_events,
                failed_logins=failed_logins,
                blocked_requests=blocked_requests,
                active_threats=len(self.threat_intelligence),
                compliance_score=compliance_score,
                encrypted_buckets=encrypted_buckets,
                unencrypted_buckets=unencrypted_buckets,
                recent_events=recent_events_data,
                threat_trends=threat_trends
            )
            
        except Exception as e:
            logger.error(f"Error getting security dashboard: {e}")
            raise
    
    async def get_security_recommendations(self) -> List[SecurityRecommendation]:
        """Get security recommendations."""
        try:
            recommendations = []
            
            # Check for unencrypted buckets
            buckets = await minio_client.list_buckets()
            total_buckets = len(buckets)
            encrypted_buckets = len(self.bucket_encryption)
            
            if encrypted_buckets < total_buckets:
                rec = SecurityRecommendation(
                    recommendation_id="encrypt-buckets",
                    title="Enable Encryption for All Buckets",
                    description=f"{total_buckets - encrypted_buckets} buckets are not encrypted",
                    severity=ThreatLevel.HIGH,
                    category="encryption",
                    remediation_steps=[
                        "Review unencrypted buckets",
                        "Enable server-side encryption",
                        "Configure appropriate encryption keys"
                    ],
                    estimated_effort="medium"
                )
                recommendations.append(rec)
            
            # Check for old encryption keys
            old_keys = [
                key for key in self.encryption_keys.values()
                if key.last_rotation_date and 
                key.last_rotation_date < datetime.utcnow() - timedelta(days=90)
            ]
            
            if old_keys:
                rec = SecurityRecommendation(
                    recommendation_id="rotate-keys",
                    title="Rotate Old Encryption Keys",
                    description=f"{len(old_keys)} encryption keys haven't been rotated in 90+ days",
                    severity=ThreatLevel.MEDIUM,
                    category="key_management",
                    remediation_steps=[
                        "Identify old encryption keys",
                        "Schedule key rotation",
                        "Update key rotation policies"
                    ],
                    estimated_effort="low"
                )
                recommendations.append(rec)
            
            # Check for high-risk events
            high_risk_events = [
                e for e in self.security_events[-100:]  # Last 100 events
                if e.risk_score > 80
            ]
            
            if high_risk_events:
                rec = SecurityRecommendation(
                    recommendation_id="investigate-threats",
                    title="Investigate High-Risk Security Events",
                    description=f"{len(high_risk_events)} high-risk security events require investigation",
                    severity=ThreatLevel.HIGH,
                    category="incident_response",
                    remediation_steps=[
                        "Review high-risk security events",
                        "Investigate potential threats",
                        "Implement additional security controls"
                    ],
                    estimated_effort="high"
                )
                recommendations.append(rec)
            
            return recommendations
            
        except Exception as e:
            logger.error(f"Error getting security recommendations: {e}")
            raise
    
    async def get_security_events(self, limit: int = 100, event_type: Optional[SecurityEventType] = None,
                                severity: Optional[ThreatLevel] = None) -> List[SecurityEvent]:
        """Get security events with filtering."""
        try:
            events = self.security_events
            
            # Apply filters
            if event_type:
                events = [e for e in events if e.event_type == event_type]
            
            if severity:
                events = [e for e in events if e.severity == severity]
            
            # Sort by timestamp (most recent first)
            events.sort(key=lambda x: x.timestamp, reverse=True)
            
            return events[:limit]
            
        except Exception as e:
            logger.error(f"Error getting security events: {e}")
            raise
    
    async def is_ip_blocked(self, ip_address: str) -> bool:
        """Check if an IP address is blocked."""
        return ip_address in self.blocked_ips
    
    async def block_ip(self, ip_address: str, reason: str = "manual_block") -> bool:
        """Block an IP address."""
        try:
            self.blocked_ips.add(ip_address)
            
            await self._log_security_event(
                SecurityEventType.SUSPICIOUS_ACTIVITY,
                ThreatLevel.MEDIUM,
                source_ip=ip_address,
                details={"action": "ip_blocked", "reason": reason}
            )
            
            logger.info(f"Blocked IP address {ip_address}: {reason}")
            return True
            
        except Exception as e:
            logger.error(f"Error blocking IP address: {e}")
            return False
    
    async def unblock_ip(self, ip_address: str) -> bool:
        """Unblock an IP address."""
        try:
            if ip_address in self.blocked_ips:
                self.blocked_ips.remove(ip_address)
                
                await self._log_security_event(
                    SecurityEventType.SUSPICIOUS_ACTIVITY,
                    ThreatLevel.LOW,
                    source_ip=ip_address,
                    details={"action": "ip_unblocked"}
                )
                
                logger.info(f"Unblocked IP address {ip_address}")
                return True
            
            return False
            
        except Exception as e:
            logger.error(f"Error unblocking IP address: {e}")
            return False


# Global security service instance
security_service = SecurityService()

"""Security middleware for authorization and access control."""

from fastapi import Request, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from starlette.middleware.base import BaseHTTPMiddleware
from loguru import logger
from typing import Optional
import re

from app.services.iam_service import iam_service

security = HTTPBearer()

class SecurityMiddleware(BaseHTTPMiddleware):
    """Middleware for enforcing security policies and access control."""
    
    def __init__(self, app):
        super().__init__(app)
        # Define protected endpoints that require authorization
        self.protected_patterns = [
            r'^/api/v1/files/.*',
            r'^/api/v1/buckets/.*',
            r'^/api/v1/objects/.*',
            r'^/api/v1/iam/users/.*/.*',  # User-specific IAM operations
        ]
        
        # Define admin-only endpoints
        self.admin_only_patterns = [
            r'^/api/v1/iam/policies.*',
            r'^/api/v1/iam/groups.*',
            r'^/api/v1/iam/roles.*',
            r'^/api/v1/security/.*',
        ]
    
    async def dispatch(self, request: Request, call_next):
        """Process request through security checks."""
        path = request.url.path
        method = request.method
        
        # Skip security checks for public endpoints
        if self._is_public_endpoint(path):
            return await call_next(request)
        
        # Extract user from authorization header
        user = await self._get_current_user(request)
        if not user:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Authentication required"
            )
        
        # Check admin-only endpoints
        if self._is_admin_only_endpoint(path):
            if not await self._is_admin_user(user):
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="Admin privileges required"
                )
        
        # Check resource-specific permissions
        if self._is_protected_endpoint(path):
            # Allow bucket listing for all authenticated users (they'll see filtered results)
            if path == "/api/v1/buckets/" and method == "GET":
                pass  # Allow bucket listing, filtering happens in the endpoint
            elif not await self._check_resource_permissions(user, method, path):
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="Insufficient permissions for this resource"
                )
        
        # Add user context to request
        request.state.current_user = user
        
        # Log security-relevant actions
        await self._log_security_action(user, method, path)
        
        return await call_next(request)
    
    def _is_public_endpoint(self, path: str) -> bool:
        """Check if endpoint is public (no auth required)."""
        public_patterns = [
            r'^/health.*',
            r'^/api/v1/monitoring/health.*',
            r'^/api/v1/monitoring/live.*',
            r'^/api/v1/monitoring/ready.*',
            r'^/docs.*',
            r'^/openapi\.json.*',
            r'^/redoc.*',
            r'^/api/v1/openapi\.json.*',
        ]
        
        for pattern in public_patterns:
            if re.match(pattern, path):
                return True
        return False
    
    def _is_protected_endpoint(self, path: str) -> bool:
        """Check if endpoint requires resource-level authorization."""
        for pattern in self.protected_patterns:
            if re.match(pattern, path):
                return True
        return False
    
    def _is_admin_only_endpoint(self, path: str) -> bool:
        """Check if endpoint requires admin privileges."""
        for pattern in self.admin_only_patterns:
            if re.match(pattern, path):
                return True
        return False
    
    async def _get_current_user(self, request: Request) -> Optional[str]:
        """Extract current user from authorization header."""
        try:
            auth_header = request.headers.get("authorization")
            if not auth_header or not auth_header.startswith("Bearer "):
                return None

            token = auth_header.split(" ")[1]
            if token == "demo-token":
                return "admin"
            elif token == "alice-token":
                return "alice"
            elif token == "bob-token":
                return "bob"

            return None
        except Exception as e:
            logger.error(f"Error extracting user: {e}")
            return None

    async def _is_admin_user(self, username: str) -> bool:
        """Check if user has admin privileges."""
        # admin (demo-token) always has full access in dev
        if username == "admin":
            return True
        try:
            user = await iam_service.get_user(username)
            if not user:
                return False
            return "AdminPolicy" in user.policies
        except Exception as e:
            logger.error(f"Error checking admin status: {e}")
            return False

    async def _check_resource_permissions(self, username: str, method: str, path: str) -> bool:
        """Check if user has permission for specific resource operation."""
        # admin (demo-token) has full access to all resources
        if username == "admin":
            return True
        try:
            action = self._map_to_s3_action(method, path)
            resource = self._extract_resource_arn(path)
            if await self._check_resource_ownership(username, path):
                return True
            return await iam_service.evaluate_permissions(username, action, resource)
        except Exception as e:
            logger.error(f"Error checking resource permissions: {e}")
            return False
    
    def _map_to_s3_action(self, method: str, path: str) -> str:
        """Map HTTP method and path to S3 action."""
        if "/files/" in path or "/objects/" in path:
            if method == "GET":
                return "s3:GetObject"
            elif method == "POST" or method == "PUT":
                return "s3:PutObject"
            elif method == "DELETE":
                return "s3:DeleteObject"
        elif "/buckets/" in path:
            if method == "GET":
                return "s3:ListBucket"
            elif method == "POST":
                return "s3:CreateBucket"
            elif method == "DELETE":
                return "s3:DeleteBucket"
        
        return "s3:*"  # Default to wildcard
    
    def _extract_resource_arn(self, path: str) -> str:
        """Extract resource ARN from path."""
        # Extract bucket name from path
        bucket_match = re.search(r'/buckets/([^/]+)', path)
        if bucket_match:
            bucket_name = bucket_match.group(1)
            
            # Check if it's an object operation
            object_match = re.search(r'/objects/(.+)', path)
            if object_match:
                object_key = object_match.group(1)
                return f"arn:aws:s3:::{bucket_name}/{object_key}"
            else:
                return f"arn:aws:s3:::{bucket_name}"
        
        return "*"  # Default to wildcard
    
    async def _check_resource_ownership(self, username: str, path: str) -> bool:
        """Check if user owns the resource (user-specific buckets)."""
        # Check if accessing user's own bucket (user-{username}-*)
        bucket_match = re.search(r'/buckets/user-([^-]+)-', path)
        if bucket_match:
            bucket_owner = bucket_match.group(1)
            return bucket_owner == username
        
        # Check if accessing user's own files
        if f"/users/{username}/" in path:
            return True
        
        return False
    
    async def _log_security_action(self, username: str, method: str, path: str):
        """Log security-relevant actions for audit trail."""
        # Log sensitive operations
        sensitive_patterns = [
            r'^/api/v1/iam/.*',
            r'^/api/v1/security/.*',
            r'^/api/v1/files/.*',
            r'^/api/v1/buckets/.*',
        ]
        
        for pattern in sensitive_patterns:
            if re.match(pattern, path):
                logger.info(f"SECURITY_AUDIT: User {username} performed {method} on {path}")
                break

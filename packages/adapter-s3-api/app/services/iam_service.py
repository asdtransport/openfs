"""IAM (Identity and Access Management) service implementation."""

import json
import secrets
import string
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Tuple
from loguru import logger

from app.schemas.iam import (
    User, Group, Role, IAMPolicy, AccessKey, PolicyAttachment,
    CreateUserRequest, CreateUserResponse, CreatePolicyRequest,
    AttachPolicyRequest, UserListResponse, PolicyListResponse,
    PolicyStatement, PolicyEffect
)


class IAMService:
    """IAM service for managing users, groups, roles, and policies."""
    
    def __init__(self):
        """Initialize IAM service with in-memory storage."""
        # In production, these would be backed by a database
        self.users: Dict[str, User] = {}
        self.groups: Dict[str, Group] = {}
        self.roles: Dict[str, Role] = {}
        self.policies: Dict[str, IAMPolicy] = {}
        self.access_keys: Dict[str, AccessKey] = {}
        self.policy_attachments: List[PolicyAttachment] = []
        
        # Initialize with default policies and users
        self._create_default_policies()
        self._create_default_users()
    
    def _create_default_policies(self):
        """Create default IAM policies."""
        # Admin policy - full access
        admin_policy = IAMPolicy(
            statements=[
                PolicyStatement(
                    effect=PolicyEffect.ALLOW,
                    actions=["*"],
                    resources=["*"]
                )
            ]
        )
        self.policies["AdminPolicy"] = admin_policy
        
        # Read-only policy
        readonly_policy = IAMPolicy(
            statements=[
                PolicyStatement(
                    effect=PolicyEffect.ALLOW,
                    actions=[
                        "s3:GetObject",
                        "s3:ListBucket",
                        "s3:GetBucketLocation",
                        "s3:ListAllMyBuckets"
                    ],
                    resources=["*"]
                )
            ]
        )
        self.policies["ReadOnlyPolicy"] = readonly_policy
        
        # User self-management policy
        user_policy = IAMPolicy(
            statements=[
                PolicyStatement(
                    effect=PolicyEffect.ALLOW,
                    actions=[
                        "s3:GetObject",
                        "s3:PutObject",
                        "s3:DeleteObject",
                        "s3:ListBucket"
                    ],
                    resources=["arn:aws:s3:::user-${aws:username}/*"]
                )
            ]
        )
        self.policies["UserPolicy"] = user_policy
        
        logger.info(f"Default IAM policies created: {list(self.policies.keys())}")
    
    def _create_default_users(self):
        """Create default admin user."""
        # Create admin user
        admin_user = User(
            username="admin",
            email="admin@example.com",
            full_name="System Administrator",
            is_active=True,
            policies=["AdminPolicy"],  # Attach admin policy
            groups=[],
            created_at=datetime.utcnow(),
            last_login=None
        )
        self.users["admin"] = admin_user
        
        # Create demo user for testing
        demo_user = User(
            username="demo-user",
            email="demo@example.com", 
            full_name="Demo User",
            is_active=True,
            policies=["AdminPolicy"],  # Give demo user admin permissions for testing
            groups=[],
            created_at=datetime.utcnow(),
            last_login=None
        )
        self.users["demo-user"] = demo_user
        
        # Create Alice user for testing
        alice_user = User(
            username="alice",
            email="alice@example.com",
            full_name="Alice Smith",
            is_active=True,
            policies=["UserPolicy"],  # Give Alice user permissions
            groups=[],
            created_at=datetime.utcnow(),
            last_login=None
        )
        self.users["alice"] = alice_user
        
        # Create Bob user for testing
        bob_user = User(
            username="bob",
            email="bob@example.com",
            full_name="Bob Johnson", 
            is_active=True,
            policies=["UserPolicy"],  # Give Bob user permissions
            groups=[],
            created_at=datetime.utcnow(),
            last_login=None
        )
        self.users["bob"] = bob_user
        
        logger.info(f"Default IAM users created: {list(self.users.keys())}")
    
    def _generate_access_key_pair(self) -> Tuple[str, str]:
        """Generate access key and secret key pair."""
        # Generate access key (20 characters, alphanumeric)
        access_key = ''.join(secrets.choice(string.ascii_uppercase + string.digits) 
                           for _ in range(20))
        
        # Generate secret key (40 characters, alphanumeric + symbols)
        secret_key = ''.join(secrets.choice(string.ascii_letters + string.digits + '+/=') 
                           for _ in range(40))
        
        return access_key, secret_key
    
    async def create_user(self, request: CreateUserRequest) -> CreateUserResponse:
        """Create a new IAM user."""
        if request.username in self.users:
            raise ValueError(f"User {request.username} already exists")
        
        # Create user
        user = User(
            username=request.username,
            email=request.email,
            full_name=request.full_name,
            policies=request.policies,
            groups=request.groups,
            tags=request.tags
        )
        
        access_key = None
        if request.generate_access_key:
            # Generate access key pair
            access_key_id, secret_key = self._generate_access_key_pair()
            
            access_key = AccessKey(
                access_key_id=access_key_id,
                secret_access_key=secret_key,
                username=request.username
            )
            
            user.access_key = access_key_id
            self.access_keys[access_key_id] = access_key
        
        self.users[request.username] = user
        
        # Attach policies
        for policy_name in request.policies:
            await self.attach_policy_to_user(request.username, policy_name)
        
        # Add to groups
        for group_name in request.groups:
            await self.add_user_to_group(request.username, group_name)
        
        logger.info(f"Created user: {request.username}")
        
        return CreateUserResponse(user=user, access_key=access_key)
    
    async def get_user(self, username: str) -> Optional[User]:
        """Get user by username."""
        return self.users.get(username)
    
    async def list_users(self, page: int = 1, page_size: int = 50) -> UserListResponse:
        """List all users with pagination."""
        users_list = list(self.users.values())
        total_count = len(users_list)
        
        start_idx = (page - 1) * page_size
        end_idx = start_idx + page_size
        paginated_users = users_list[start_idx:end_idx]
        
        return UserListResponse(
            users=paginated_users,
            total_count=total_count,
            page=page,
            page_size=page_size
        )
    
    async def update_user(self, username: str, updates: Dict) -> User:
        """Update user information."""
        if username not in self.users:
            raise ValueError(f"User {username} not found")
        
        user = self.users[username]
        for key, value in updates.items():
            if hasattr(user, key):
                setattr(user, key, value)
        
        logger.info(f"Updated user: {username}")
        return user
    
    async def delete_user(self, username: str) -> bool:
        """Delete a user."""
        if username not in self.users:
            raise ValueError(f"User {username} not found")
        
        user = self.users[username]
        
        # Delete associated access keys
        if user.access_key:
            self.access_keys.pop(user.access_key, None)
        
        # Remove from groups
        for group_name in user.groups:
            if group_name in self.groups:
                self.groups[group_name].users.remove(username)
        
        # Remove policy attachments
        self.policy_attachments = [
            pa for pa in self.policy_attachments 
            if not (pa.entity_type == "user" and pa.entity_name == username)
        ]
        
        del self.users[username]
        logger.info(f"Deleted user: {username}")
        return True
    
    async def create_group(self, name: str, description: Optional[str] = None) -> Group:
        """Create a new group."""
        if name in self.groups:
            raise ValueError(f"Group {name} already exists")
        
        group = Group(name=name, description=description)
        self.groups[name] = group
        
        logger.info(f"Created group: {name}")
        return group
    
    async def add_user_to_group(self, username: str, group_name: str) -> bool:
        """Add user to group."""
        if username not in self.users:
            raise ValueError(f"User {username} not found")
        
        if group_name not in self.groups:
            raise ValueError(f"Group {group_name} not found")
        
        # Add user to group
        if username not in self.groups[group_name].users:
            self.groups[group_name].users.append(username)
        
        # Add group to user
        if group_name not in self.users[username].groups:
            self.users[username].groups.append(group_name)
        
        logger.info(f"Added user {username} to group {group_name}")
        return True
    
    async def create_policy(self, request: CreatePolicyRequest) -> bool:
        """Create a new IAM policy."""
        if request.name in self.policies:
            raise ValueError(f"Policy {request.name} already exists")
        
        self.policies[request.name] = request.policy_document
        logger.info(f"Created policy: {request.name}")
        return True
    
    async def get_policy(self, policy_name: str) -> Optional[IAMPolicy]:
        """Get policy by name."""
        return self.policies.get(policy_name)
    
    async def list_policies(self, page: int = 1, page_size: int = 50) -> PolicyListResponse:
        """List all policies with pagination."""
        try:
            policies_list = [
                {
                    "name": name,
                    "description": f"Policy {name}",
                    "created_at": datetime.utcnow().isoformat()
                }
                for name in self.policies.keys()
            ]
            
            total_count = len(policies_list)
            start_idx = (page - 1) * page_size
            end_idx = start_idx + page_size
            paginated_policies = policies_list[start_idx:end_idx]
            
            logger.info(f"Returning {len(paginated_policies)} policies out of {total_count}")
            
            return PolicyListResponse(
                policies=paginated_policies,
                total_count=total_count,
                page=page,
                page_size=page_size
            )
        except Exception as e:
            logger.error(f"Error in list_policies: {e}")
            raise
    
    async def attach_policy_to_user(self, username: str, policy_name: str) -> bool:
        """Attach policy to user."""
        if username not in self.users:
            raise ValueError(f"User {username} not found")
        
        if policy_name not in self.policies:
            raise ValueError(f"Policy {policy_name} not found")
        
        # Add to user's policies
        if policy_name not in self.users[username].policies:
            self.users[username].policies.append(policy_name)
        
        # Record attachment
        attachment = PolicyAttachment(
            policy_name=policy_name,
            entity_type="user",
            entity_name=username
        )
        self.policy_attachments.append(attachment)
        
        logger.info(f"Attached policy {policy_name} to user {username}")
        return True
    
    async def detach_policy_from_user(self, username: str, policy_name: str) -> bool:
        """Detach policy from user."""
        if username not in self.users:
            raise ValueError(f"User {username} not found")
        
        # Remove from user's policies
        if policy_name in self.users[username].policies:
            self.users[username].policies.remove(policy_name)
        
        # Remove attachment record
        self.policy_attachments = [
            pa for pa in self.policy_attachments
            if not (pa.entity_type == "user" and pa.entity_name == username and pa.policy_name == policy_name)
        ]
        
        logger.info(f"Detached policy {policy_name} from user {username}")
        return True
    
    async def evaluate_permissions(self, username: str, action: str, resource: str) -> bool:
        """Evaluate if user has permission for action on resource."""
        if username not in self.users:
            return False
        
        user = self.users[username]
        
        # Check user's direct policies
        for policy_name in user.policies:
            if policy_name in self.policies:
                if self._evaluate_policy(self.policies[policy_name], action, resource):
                    return True
        
        # Check group policies
        for group_name in user.groups:
            if group_name in self.groups:
                group = self.groups[group_name]
                for policy_name in group.policies:
                    if policy_name in self.policies:
                        if self._evaluate_policy(self.policies[policy_name], action, resource):
                            return True
        
        return False
    
    def _evaluate_policy(self, policy: IAMPolicy, action: str, resource: str) -> bool:
        """Evaluate a single policy against action and resource."""
        for statement in policy.statements:
            # Check if action matches
            action_match = False
            for policy_action in statement.actions:
                if policy_action == "*" or policy_action == action:
                    action_match = True
                    break
            
            if not action_match:
                continue
            
            # Check if resource matches
            resource_match = False
            for policy_resource in statement.resources:
                if policy_resource == "*" or self._resource_matches(policy_resource, resource):
                    resource_match = True
                    break
            
            if not resource_match:
                continue
            
            # If both match, return based on effect
            if statement.effect.value == "Allow":
                return True
            elif statement.effect.value == "Deny":
                return False
        
        return False
    
    def _resource_matches(self, policy_resource: str, actual_resource: str) -> bool:
        """Check if actual resource matches policy resource pattern."""
        # Simple wildcard matching - in production, use more sophisticated matching
        if policy_resource == "*":
            return True
        
        if policy_resource.endswith("*"):
            prefix = policy_resource[:-1]
            return actual_resource.startswith(prefix)
        
        return policy_resource == actual_resource
    
    async def rotate_access_key(self, username: str) -> AccessKey:
        """Rotate user's access key."""
        if username not in self.users:
            raise ValueError(f"User {username} not found")
        
        user = self.users[username]
        
        # Delete old access key
        if user.access_key:
            self.access_keys.pop(user.access_key, None)
        
        # Generate new access key
        access_key_id, secret_key = self._generate_access_key_pair()
        
        new_access_key = AccessKey(
            access_key_id=access_key_id,
            secret_access_key=secret_key,
            username=username
        )
        
        user.access_key = access_key_id
        self.access_keys[access_key_id] = new_access_key
        
        logger.info(f"Rotated access key for user: {username}")
        return new_access_key
    
    async def get_user_permissions_summary(self, username: str) -> Dict:
        """Get comprehensive permissions summary for user."""
        if username not in self.users:
            raise ValueError(f"User {username} not found")
        
        user = self.users[username]
        
        summary = {
            "username": username,
            "direct_policies": user.policies,
            "groups": user.groups,
            "group_policies": [],
            "effective_permissions": [],
            "last_login": user.last_login,
            "mfa_enabled": user.mfa_enabled
        }
        
        # Get group policies
        for group_name in user.groups:
            if group_name in self.groups:
                summary["group_policies"].extend(self.groups[group_name].policies)
        
        # Get effective permissions (simplified)
        all_policies = set(user.policies + summary["group_policies"])
        for policy_name in all_policies:
            if policy_name in self.policies:
                policy = self.policies[policy_name]
                for statement in policy.statements:
                    summary["effective_permissions"].append({
                        "effect": statement.effect.value,
                        "actions": statement.actions,
                        "resources": statement.resources,
                        "policy": policy_name
                    })
        
        return summary


# Global IAM service instance
iam_service = IAMService()

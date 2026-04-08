"""IAM (Identity and Access Management) API endpoints."""

from typing import Dict, List, Optional
from fastapi import APIRouter, HTTPException, Query, status, Depends
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

from app.schemas.iam import (
    CreateUserRequest, CreateUserResponse, CreatePolicyRequest,
    AttachPolicyRequest, UserListResponse, PolicyListResponse,
    User, IAMPolicy
)
from app.services.iam_service import iam_service
from loguru import logger

router = APIRouter(prefix="/iam", tags=["iam"])
security = HTTPBearer()

# Authentication dependency (simplified for demo)
async def get_current_user(credentials: HTTPAuthorizationCredentials = Depends(security)) -> str:
    """Get current authenticated user."""
    # In production, validate JWT token and extract user info
    # For demo, return a mock admin user
    return "admin"

@router.post("/users", response_model=CreateUserResponse)
async def create_user(
    request: CreateUserRequest,
    current_user: str = Depends(get_current_user)
):
    """Create a new IAM user.
    
    Args:
        request: User creation request
        current_user: Current authenticated user
        
    Returns:
        CreateUserResponse: Created user and access key information
    """
    try:
        # Check if current user has permission to create users
        has_permission = await iam_service.evaluate_permissions(
            current_user, "iam:CreateUser", "*"
        )
        
        if not has_permission:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Insufficient permissions to create users"
            )
        
        response = await iam_service.create_user(request)
        logger.info(f"User {request.username} created by {current_user}")
        
        return response
        
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    except Exception as e:
        logger.error(f"Error creating user: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Internal server error"
        )

@router.get("/users", response_model=UserListResponse)
async def list_users(
    page: int = Query(1, ge=1, description="Page number"),
    page_size: int = Query(50, ge=1, le=100, description="Page size"),
    current_user: str = Depends(get_current_user)
):
    """List all IAM users with pagination.
    
    Args:
        page: Page number
        page_size: Number of users per page
        current_user: Current authenticated user
        
    Returns:
        UserListResponse: Paginated list of users
    """
    try:
        # Check permissions
        has_permission = await iam_service.evaluate_permissions(
            current_user, "iam:ListUsers", "*"
        )
        
        if not has_permission:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Insufficient permissions to list users"
            )
        
        return await iam_service.list_users(page, page_size)
        
    except Exception as e:
        logger.error(f"Error listing users: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Internal server error"
        )

@router.get("/users/{username}", response_model=User)
async def get_user(
    username: str,
    current_user: str = Depends(get_current_user)
):
    """Get user by username.
    
    Args:
        username: Username to retrieve
        current_user: Current authenticated user
        
    Returns:
        User: User information
    """
    try:
        # Check permissions (users can view their own info)
        has_permission = (
            current_user == username or
            await iam_service.evaluate_permissions(current_user, "iam:GetUser", "*")
        )
        
        if not has_permission:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Insufficient permissions to view user"
            )
        
        user = await iam_service.get_user(username)
        if not user:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"User {username} not found"
            )
        
        return user
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting user: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Internal server error"
        )

@router.put("/users/{username}")
async def update_user(
    username: str,
    updates: Dict,
    current_user: str = Depends(get_current_user)
):
    """Update user information.
    
    Args:
        username: Username to update
        updates: Fields to update
        current_user: Current authenticated user
        
    Returns:
        User: Updated user information
    """
    try:
        # Check permissions
        has_permission = (
            current_user == username or
            await iam_service.evaluate_permissions(current_user, "iam:UpdateUser", "*")
        )
        
        if not has_permission:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Insufficient permissions to update user"
            )
        
        user = await iam_service.update_user(username, updates)
        logger.info(f"User {username} updated by {current_user}")
        
        return user
        
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(e)
        )
    except Exception as e:
        logger.error(f"Error updating user: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Internal server error"
        )

@router.delete("/users/{username}")
async def delete_user(
    username: str,
    current_user: str = Depends(get_current_user)
):
    """Delete a user.
    
    Args:
        username: Username to delete
        current_user: Current authenticated user
        
    Returns:
        dict: Deletion confirmation
    """
    try:
        # Check permissions
        has_permission = await iam_service.evaluate_permissions(
            current_user, "iam:DeleteUser", "*"
        )
        
        if not has_permission:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Insufficient permissions to delete user"
            )
        
        # Prevent self-deletion
        if current_user == username:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Cannot delete your own user account"
            )
        
        success = await iam_service.delete_user(username)
        if success:
            logger.info(f"User {username} deleted by {current_user}")
            return {"message": f"User {username} deleted successfully"}
        
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(e)
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting user: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Internal server error"
        )

@router.post("/policies")
async def create_policy(
    request: CreatePolicyRequest,
    current_user: str = Depends(get_current_user)
):
    """Create a new IAM policy.
    
    Args:
        request: Policy creation request
        current_user: Current authenticated user
        
    Returns:
        dict: Creation confirmation
    """
    try:
        # Check permissions
        has_permission = await iam_service.evaluate_permissions(
            current_user, "iam:CreatePolicy", "*"
        )
        
        if not has_permission:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Insufficient permissions to create policies"
            )
        
        success = await iam_service.create_policy(request)
        if success:
            logger.info(f"Policy {request.name} created by {current_user}")
            return {"message": f"Policy {request.name} created successfully"}
        
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    except Exception as e:
        logger.error(f"Error creating policy: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Internal server error"
        )

@router.get("/policies", response_model=PolicyListResponse)
async def list_policies(
    page: int = Query(1, ge=1, description="Page number"),
    page_size: int = Query(50, ge=1, le=100, description="Page size"),
    current_user: str = Depends(get_current_user)
):
    """List all IAM policies.
    
    Args:
        page: Page number
        page_size: Number of policies per page
        current_user: Current authenticated user
        
    Returns:
        PolicyListResponse: Paginated list of policies
    """
    try:
        # Check permissions
        has_permission = await iam_service.evaluate_permissions(
            current_user, "iam:ListPolicies", "*"
        )
        
        if not has_permission:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Insufficient permissions to list policies"
            )
        
        return await iam_service.list_policies(page, page_size)
        
    except HTTPException:
        # Re-raise HTTP exceptions (like permission errors)
        raise
    except Exception as e:
        import traceback
        logger.error(f"Error listing policies: {e}")
        logger.error(f"Full traceback: {traceback.format_exc()}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Internal server error: {str(e)}"
        )

@router.get("/policies/{policy_name}", response_model=IAMPolicy)
async def get_policy(
    policy_name: str,
    current_user: str = Depends(get_current_user)
):
    """Get policy by name.
    
    Args:
        policy_name: Policy name
        current_user: Current authenticated user
        
    Returns:
        IAMPolicy: Policy document
    """
    try:
        # Check permissions
        has_permission = await iam_service.evaluate_permissions(
            current_user, "iam:GetPolicy", "*"
        )
        
        if not has_permission:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Insufficient permissions to view policy"
            )
        
        policy = await iam_service.get_policy(policy_name)
        if not policy:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Policy {policy_name} not found"
            )
        
        return policy
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting policy: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Internal server error"
        )

@router.post("/attach-policy")
async def attach_policy(
    request: AttachPolicyRequest,
    current_user: str = Depends(get_current_user)
):
    """Attach policy to user, group, or role.
    
    Args:
        request: Policy attachment request
        current_user: Current authenticated user
        
    Returns:
        dict: Attachment confirmation
    """
    try:
        # Check permissions
        has_permission = await iam_service.evaluate_permissions(
            current_user, "iam:AttachPolicy", "*"
        )
        
        if not has_permission:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Insufficient permissions to attach policies"
            )
        
        if request.entity_type == "user":
            success = await iam_service.attach_policy_to_user(
                request.entity_name, request.policy_name
            )
        else:
            # TODO: Implement group and role policy attachment
            raise HTTPException(
                status_code=status.HTTP_501_NOT_IMPLEMENTED,
                detail=f"Policy attachment to {request.entity_type} not yet implemented"
            )
        
        if success:
            logger.info(f"Policy {request.policy_name} attached to {request.entity_type} {request.entity_name} by {current_user}")
            return {"message": f"Policy attached successfully"}
        
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error attaching policy: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Internal server error"
        )

@router.post("/detach-policy")
async def detach_policy(
    request: AttachPolicyRequest,
    current_user: str = Depends(get_current_user)
):
    """Detach policy from user, group, or role.
    
    Args:
        request: Policy detachment request
        current_user: Current authenticated user
        
    Returns:
        dict: Detachment confirmation
    """
    try:
        # Check permissions
        has_permission = await iam_service.evaluate_permissions(
            current_user, "iam:DetachPolicy", "*"
        )
        
        if not has_permission:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Insufficient permissions to detach policies"
            )
        
        if request.entity_type == "user":
            success = await iam_service.detach_policy_from_user(
                request.entity_name, request.policy_name
            )
        else:
            # TODO: Implement group and role policy detachment
            raise HTTPException(
                status_code=status.HTTP_501_NOT_IMPLEMENTED,
                detail=f"Policy detachment from {request.entity_type} not yet implemented"
            )
        
        if success:
            logger.info(f"Policy {request.policy_name} detached from {request.entity_type} {request.entity_name} by {current_user}")
            return {"message": f"Policy detached successfully"}
        
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error detaching policy: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Internal server error"
        )

@router.post("/users/{username}/rotate-key")
async def rotate_access_key(
    username: str,
    current_user: str = Depends(get_current_user)
):
    """Rotate user's access key.
    
    Args:
        username: Username to rotate key for
        current_user: Current authenticated user
        
    Returns:
        dict: New access key information
    """
    try:
        # Check permissions (users can rotate their own keys)
        has_permission = (
            current_user == username or
            await iam_service.evaluate_permissions(current_user, "iam:RotateAccessKey", "*")
        )
        
        if not has_permission:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Insufficient permissions to rotate access key"
            )
        
        new_key = await iam_service.rotate_access_key(username)
        logger.info(f"Access key rotated for user {username} by {current_user}")
        
        return {
            "message": "Access key rotated successfully",
            "access_key_id": new_key.access_key_id,
            "secret_access_key": new_key.secret_access_key
        }
        
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(e)
        )
    except Exception as e:
        logger.error(f"Error rotating access key: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Internal server error"
        )

@router.get("/users/{username}/permissions")
async def get_user_permissions(
    username: str,
    current_user: str = Depends(get_current_user)
):
    """Get comprehensive permissions summary for user.
    
    Args:
        username: Username to get permissions for
        current_user: Current authenticated user
        
    Returns:
        dict: User permissions summary
    """
    try:
        # Check permissions (users can view their own permissions)
        has_permission = (
            current_user == username or
            await iam_service.evaluate_permissions(current_user, "iam:GetUserPermissions", "*")
        )
        
        if not has_permission:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Insufficient permissions to view user permissions"
            )
        
        summary = await iam_service.get_user_permissions_summary(username)
        return summary
        
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(e)
        )
    except Exception as e:
        logger.error(f"Error getting user permissions: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Internal server error"
        )

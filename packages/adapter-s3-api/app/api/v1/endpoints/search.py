"""Search and indexing API endpoints."""

from typing import List, Optional
from fastapi import APIRouter, HTTPException, Query, status

from app.schemas.search import (
    SearchQuery, SearchResponse, SearchAnalytics, SavedSearch,
    SearchAlert, CreateIndexRequest, SearchIndex, AutocompleteRequest,
    AutocompleteResponse, SearchSuggestion
)
from app.services.search_service import search_service
from loguru import logger

router = APIRouter(prefix="/search", tags=["search"])

@router.post("/query", response_model=SearchResponse)
async def search_objects(query: SearchQuery):
    """Search for objects across indexes.
    
    Args:
        query: Search query parameters
        
    Returns:
        SearchResponse: Search results
    """
    try:
        response = await search_service.search(query)
        return response
        
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    except Exception as e:
        logger.error(f"Error performing search: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error performing search"
        )

@router.post("/indexes", response_model=SearchIndex)
async def create_search_index(request: CreateIndexRequest):
    """Create a new search index.
    
    Args:
        request: Index creation request
        
    Returns:
        SearchIndex: Created search index
    """
    try:
        index = await search_service.create_index(request)
        return index
        
    except Exception as e:
        logger.error(f"Error creating search index: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error creating search index"
        )

@router.get("/indexes", response_model=List[SearchIndex])
async def list_search_indexes():
    """List all search indexes.
    
    Returns:
        List[SearchIndex]: All search indexes
    """
    try:
        indexes = list(search_service.indexes.values())
        return indexes
        
    except Exception as e:
        logger.error(f"Error listing search indexes: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error listing search indexes"
        )

@router.get("/indexes/{index_name}", response_model=SearchIndex)
async def get_search_index(index_name: str):
    """Get search index by name.
    
    Args:
        index_name: Index name
        
    Returns:
        SearchIndex: Search index details
    """
    try:
        if index_name not in search_service.indexes:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Search index {index_name} not found"
            )
        
        return search_service.indexes[index_name]
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting search index: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error retrieving search index"
        )

@router.delete("/indexes/{index_name}")
async def delete_search_index(index_name: str):
    """Delete a search index.
    
    Args:
        index_name: Index name
        
    Returns:
        dict: Deletion confirmation
    """
    try:
        if index_name not in search_service.indexes:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Search index {index_name} not found"
            )
        
        if index_name == "default":
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Cannot delete default index"
            )
        
        del search_service.indexes[index_name]
        if index_name in search_service.documents:
            del search_service.documents[index_name]
        
        return {"message": f"Search index {index_name} deleted successfully"}
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting search index: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error deleting search index"
        )

@router.get("/analytics", response_model=SearchAnalytics)
async def get_search_analytics():
    """Get search analytics and statistics.
    
    Returns:
        SearchAnalytics: Search analytics data
    """
    try:
        analytics = await search_service.get_search_analytics()
        return analytics
        
    except Exception as e:
        logger.error(f"Error getting search analytics: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error retrieving search analytics"
        )

@router.post("/saved-searches")
async def save_search(saved_search: SavedSearch):
    """Save a search query for later use.
    
    Args:
        saved_search: Saved search configuration
        
    Returns:
        dict: Save confirmation
    """
    try:
        success = await search_service.save_search(saved_search)
        
        if success:
            return {
                "message": f"Search '{saved_search.name}' saved successfully",
                "search_id": saved_search.search_id
            }
        else:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to save search"
            )
            
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error saving search: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error saving search"
        )

@router.get("/saved-searches", response_model=List[SavedSearch])
async def list_saved_searches(
    user_id: str = Query(..., description="User ID to filter searches")
):
    """List saved searches for a user.
    
    Args:
        user_id: User ID
        
    Returns:
        List[SavedSearch]: User's saved searches
    """
    try:
        searches = await search_service.get_saved_searches(user_id)
        return searches
        
    except Exception as e:
        logger.error(f"Error listing saved searches: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error retrieving saved searches"
        )

@router.get("/indexes/{index_id}/health")
async def get_index_health(index_id: str):
    """Get health status of a specific search index."""
    try:
        health = await search_service.get_index_health(index_id)
        return health
    except Exception as e:
        logger.error(f"Error getting index health: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error retrieving index health"
        )

@router.get("/debug/documents/{index_id}")
async def debug_documents(index_id: str):
    """Debug endpoint to check actual documents in index."""
    try:
        documents = search_service.documents.get(index_id, [])
        return {
            "index_id": index_id,
            "document_count": len(documents),
            "documents": [
                {
                    "document_id": doc.document_id,
                    "content_keys": list(doc.content.keys()) if isinstance(doc.content, dict) else "not_dict",
                    "indexed_at": doc.indexed_at.isoformat() if doc.indexed_at else None
                }
                for doc in documents[:5]  # Show first 5 documents
            ]
        }
    except Exception as e:
        logger.error(f"Error getting debug documents: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error getting debug documents: {str(e)}"
        )

@router.post("/index-bucket/{bucket_name}")
async def index_bucket(bucket_name: str):
    """Index all objects in a bucket for search."""
    try:
        from app.services.minio_client import minio_client
        
        # Check if bucket exists
        if not minio_client.client.bucket_exists(bucket_name):
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Bucket '{bucket_name}' not found"
            )
        
        # Get all objects in bucket
        objects = minio_client.client.list_objects(bucket_name, recursive=True)
        indexed_count = 0
        
        for obj in objects:
            # Create search document for each object
            document = {
                "object_key": obj.object_name,
                "bucket_name": bucket_name,
                "content_type": getattr(obj, 'content_type', 'application/octet-stream'),
                "size": obj.size,
                "last_modified": obj.last_modified.isoformat() if obj.last_modified else None,
                "etag": getattr(obj, 'etag', ''),
                "is_dir": obj.is_dir,
                "metadata": {}
            }
            
            # Add to search index
            await search_service.index_document("default", obj.object_name, document)
            indexed_count += 1
        
        return {
            "message": f"Successfully indexed {indexed_count} objects from bucket '{bucket_name}'",
            "bucket_name": bucket_name,
            "objects_indexed": indexed_count,
            "index_id": "default"
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error indexing bucket: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error indexing bucket: {str(e)}"
        )

@router.post("/alerts")
async def create_search_alert(alert: SearchAlert):
    """Create a search-based alert.
    
    Args:
        alert: Search alert configuration
        
    Returns:
        dict: Alert creation confirmation
    """
    try:
        success = await search_service.create_search_alert(alert)
        
        if success:
            return {
                "message": f"Search alert '{alert.name}' created successfully",
                "alert_id": alert.alert_id
            }
        else:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to create search alert"
            )
            
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating search alert: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error creating search alert"
        )

@router.get("/alerts", response_model=List[SearchAlert])
async def list_search_alerts():
    """List all search alerts.
    
    Returns:
        List[SearchAlert]: All search alerts
    """
    try:
        alerts = list(search_service.search_alerts.values())
        return alerts
        
    except Exception as e:
        logger.error(f"Error listing search alerts: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error retrieving search alerts"
        )

@router.get("/autocomplete")
async def get_autocomplete_suggestions(
    prefix: str = Query(..., description="Search prefix"),
    index_name: Optional[str] = Query(None, description="Target index name"),
    limit: int = Query(10, ge=1, le=50, description="Maximum suggestions")
):
    """Get autocomplete suggestions.
    
    Args:
        prefix: Search prefix
        index_name: Target index name
        limit: Maximum number of suggestions
        
    Returns:
        dict: Autocomplete suggestions
    """
    try:
        suggestions = await search_service.get_autocomplete_suggestions(
            prefix, index_name, limit
        )
        
        return {
            "suggestions": [
                {"suggestion": s, "score": 1.0, "type": "completion"}
                for s in suggestions
            ],
            "took_ms": 5  # Simplified
        }
        
    except Exception as e:
        logger.error(f"Error getting autocomplete suggestions: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error retrieving autocomplete suggestions"
        )

@router.get("/indexes/{index_name}/health")
async def get_index_health(index_name: str):
    """Get search index health status.
    
    Args:
        index_name: Index name
        
    Returns:
        dict: Index health information
    """
    try:
        health = await search_service.get_index_health(index_name)
        return health
        
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(e)
        )
    except Exception as e:
        logger.error(f"Error getting index health: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error retrieving index health"
        )

@router.get("/history")
async def get_search_history(
    limit: int = Query(100, ge=1, le=1000, description="Maximum number of results")
):
    """Get search history.
    
    Args:
        limit: Maximum number of results
        
    Returns:
        dict: Search history
    """
    try:
        history = search_service.search_history[-limit:]
        return {
            "history": history,
            "total_count": len(search_service.search_history)
        }
        
    except Exception as e:
        logger.error(f"Error getting search history: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error retrieving search history"
        )

@router.post("/reindex/{index_name}")
async def reindex_objects(index_name: str):
    """Trigger reindexing for an index.
    
    Args:
        index_name: Index name
        
    Returns:
        dict: Reindexing confirmation
    """
    try:
        if index_name not in search_service.indexes:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Search index {index_name} not found"
            )
        
        index = search_service.indexes[index_name]
        
        # Clear existing documents
        search_service.documents[index_name] = []
        
        # Start reindexing
        await search_service._start_initial_indexing(index)
        
        return {
            "message": f"Reindexing started for index {index_name}",
            "document_count": index.document_count
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error reindexing: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error starting reindexing"
        )

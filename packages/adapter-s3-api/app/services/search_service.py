"""Search and indexing service implementation."""

import asyncio
import json
import secrets
from datetime import datetime
from typing import Dict, List, Optional
from loguru import logger

from app.schemas.search import (
    SearchIndex, SearchQuery, SearchResponse, SearchResult,
    IndexDocument, IndexingJob, SearchAnalytics, SavedSearch,
    SearchAlert, CreateIndexRequest, IndexStatus, SearchIndexType
)
from app.services.minio_client import minio_client


class SearchService:
    """Search and indexing service for MinIO objects."""
    
    def __init__(self):
        """Initialize search service."""
        self.indexes: Dict[str, SearchIndex] = {}
        self.documents: Dict[str, List[IndexDocument]] = {}  # index_name -> documents
        self.indexing_jobs: Dict[str, IndexingJob] = {}
        self.saved_searches: Dict[str, SavedSearch] = {}
        self.search_alerts: Dict[str, SearchAlert] = {}
        self.search_history: List[Dict] = []
        
        # Create default index
        self._create_default_index()
    
    def _create_default_index(self):
        """Create default search index."""
        default_index = SearchIndex(
            index_id="default",
            index_name="default",
            description="Default search index for all objects",
            index_type=SearchIndexType.METADATA,
            bucket_name="*",
            fields=[
                {"name": "object_key", "type": "string", "indexed": True, "stored": True},
                {"name": "content_type", "type": "string", "indexed": True, "stored": True},
                {"name": "size", "type": "number", "indexed": True, "stored": True},
                {"name": "last_modified", "type": "date", "indexed": True, "stored": True}
            ],
            status=IndexStatus.ACTIVE
        )
        self.indexes["default"] = default_index
        self.documents["default"] = []
        
        logger.info("Created default search index")
    
    async def index_document(self, index_id: str, document_id: str, document: Dict) -> bool:
        """Add or update a document in the search index."""
        try:
            if index_id not in self.indexes:
                logger.error(f"Index {index_id} not found")
                return False
            
            # Create IndexDocument from the provided document
            index_doc = IndexDocument(
                document_id=document_id,
                content=document,
                metadata=document.get("metadata", {}),
                indexed_at=datetime.utcnow()
            )
            
            # Add to documents list for this index
            if index_id not in self.documents:
                self.documents[index_id] = []
            
            # Remove existing document with same ID if it exists
            self.documents[index_id] = [
                doc for doc in self.documents[index_id] 
                if doc.document_id != document_id
            ]
            
            # Add new document
            self.documents[index_id].append(index_doc)
            
            # Update index stats
            index = self.indexes[index_id]
            index.document_count = len(self.documents[index_id])
            index.last_indexed = datetime.utcnow()
            
            logger.info(f"Indexed document {document_id} in index {index_id}. Total documents: {index.document_count}")
            logger.info(f"Document content: {document}")
            return True
            
        except Exception as e:
            logger.error(f"Error indexing document: {e}")
            return False
    
    async def create_index(self, request: CreateIndexRequest) -> SearchIndex:
        """Create a new search index."""
        try:
            index = request.index
            index.status = IndexStatus.CREATING
            
            self.indexes[index.index_name] = index
            self.documents[index.index_name] = []
            
            # Start indexing job
            await self._start_initial_indexing(index)
            
            logger.info(f"Created search index {index.index_name}")
            return index
            
        except Exception as e:
            logger.error(f"Error creating search index: {e}")
            raise
    
    async def _start_initial_indexing(self, index: SearchIndex):
        """Start initial indexing for a new index."""
        try:
            # Get objects from bucket(s)
            if index.bucket_name == "*":
                buckets = await minio_client.list_buckets()
                objects = []
                for bucket in buckets:
                    bucket_objects = await minio_client.list_objects(bucket["name"])
                    objects.extend([(bucket["name"], obj) for obj in bucket_objects])
            else:
                bucket_objects = await minio_client.list_objects(index.bucket_name)
                objects = [(index.bucket_name, obj) for obj in bucket_objects]
            
            # Index objects
            for bucket_name, obj in objects:
                if index.object_prefix and not obj["name"].startswith(index.object_prefix):
                    continue
                
                doc = IndexDocument(
                    document_id=f"{bucket_name}:{obj['name']}",
                    bucket_name=bucket_name,
                    object_key=obj["name"],
                    content_type=obj.get("content_type", "application/octet-stream"),
                    metadata={
                        "size": obj.get("size", 0),
                        "last_modified": obj.get("last_modified", datetime.utcnow()).isoformat(),
                        "etag": obj.get("etag", "")
                    }
                )
                
                self.documents[index.index_name].append(doc)
            
            # Update index status
            index.status = IndexStatus.ACTIVE
            index.document_count = len(self.documents[index.index_name])
            index.last_indexed = datetime.utcnow()
            
            logger.info(f"Indexed {index.document_count} documents for index {index.index_name}")
            
        except Exception as e:
            logger.error(f"Error in initial indexing: {e}")
            index.status = IndexStatus.FAILED
    
    async def search(self, query: SearchQuery) -> SearchResponse:
        """Perform search query."""
        try:
            start_time = datetime.utcnow()
            
            # Use default index if none specified
            index_name = query.index_name or "default"
            
            if index_name not in self.indexes:
                raise ValueError(f"Index {index_name} not found")
            
            documents = self.documents.get(index_name, [])
            results = []
            
            # Simple search implementation
            for doc in documents:
                score = 0.0
                
                # Query string search
                if query.query_string:
                    query_lower = query.query_string.lower()
                    
                    # Search in document ID (object key)
                    if query_lower in doc.document_id.lower():
                        score += 10.0
                    
                    # Search in document content (convert to string and search)
                    content_str = json.dumps(doc.content).lower()
                    if query_lower in content_str:
                        score += 8.0
                    
                    # Search in specific content fields
                    if isinstance(doc.content, dict):
                        for key, value in doc.content.items():
                            if isinstance(value, str) and query_lower in value.lower():
                                score += 5.0
                            elif query_lower in str(key).lower():
                                score += 3.0
                
                # Condition-based search
                for condition in query.conditions:
                    if condition.field == "object_key" and condition.operator.value == "CONTAINS":
                        if str(condition.value).lower() in doc.document_id.lower():
                            score += condition.boost or 1.0
                    elif condition.field == "content_type" and condition.operator.value == "=":
                        content_type = doc.content.get("content_type", "")
                        if content_type == condition.value:
                            score += condition.boost or 1.0
                    elif condition.field == "size" and condition.operator.value == ">":
                        size = doc.content.get("size", 0)
                        if size > condition.value:
                            score += condition.boost or 1.0
                
                # Bucket filter
                bucket_name = doc.content.get("bucket_name", "")
                if query.bucket_name and bucket_name != query.bucket_name:
                    continue
                
                if score > 0:
                    result = SearchResult(
                        document_id=doc.document_id,
                        bucket_name=bucket_name,
                        object_key=doc.content.get("object_key", doc.document_id),
                        score=score,
                        fields={
                            "content_type": doc.content.get("content_type", ""),
                            "size": doc.content.get("size", 0),
                            "last_modified": doc.content.get("last_modified")
                        },
                        metadata=doc.metadata
                    )
                    results.append(result)
            
            # Sort by score
            results.sort(key=lambda x: x.score, reverse=True)
            
            # Apply pagination
            total_hits = len(results)
            results = results[query.offset:query.offset + query.limit]
            
            # Calculate response time
            end_time = datetime.utcnow()
            took_ms = int((end_time - start_time).total_seconds() * 1000)
            
            # Log search
            self.search_history.append({
                "query": query.query_string or str(query.conditions),
                "index_name": index_name,
                "results_count": len(results),
                "took_ms": took_ms,
                "timestamp": datetime.utcnow().isoformat()
            })
            
            response = SearchResponse(
                query_id=query.query_id,
                results=results,
                total_hits=total_hits,
                max_score=max([r.score for r in results]) if results else 0.0,
                took_ms=took_ms,
                timed_out=False
            )
            
            return response
            
        except Exception as e:
            logger.error(f"Error performing search: {e}")
            raise
    
    async def get_search_analytics(self) -> SearchAnalytics:
        """Get search analytics."""
        try:
            total_queries = len(self.search_history)
            
            # Calculate average response time
            avg_response_time = 0.0
            if self.search_history:
                avg_response_time = sum(h["took_ms"] for h in self.search_history) / len(self.search_history)
            
            # Top queries
            query_counts = {}
            for history in self.search_history[-1000:]:  # Last 1000 queries
                query = history["query"]
                query_counts[query] = query_counts.get(query, 0) + 1
            
            top_queries = [
                {"query": query, "count": count}
                for query, count in sorted(query_counts.items(), key=lambda x: x[1], reverse=True)[:10]
            ]
            
            # Index usage
            index_usage = {}
            for history in self.search_history[-1000:]:
                index_name = history["index_name"]
                index_usage[index_name] = index_usage.get(index_name, 0) + 1
            
            return SearchAnalytics(
                total_queries=total_queries,
                unique_users=1,  # Simplified
                average_response_time_ms=avg_response_time,
                top_queries=top_queries,
                top_results=[],  # TODO: Implement
                query_trends={},  # TODO: Implement
                zero_result_queries=[],  # TODO: Implement
                slow_queries=[],  # TODO: Implement
                index_usage=index_usage
            )
            
        except Exception as e:
            logger.error(f"Error getting search analytics: {e}")
            raise
    
    async def save_search(self, saved_search: SavedSearch) -> bool:
        """Save a search query."""
        try:
            self.saved_searches[saved_search.search_id] = saved_search
            logger.info(f"Saved search {saved_search.search_id}: {saved_search.name}")
            return True
            
        except Exception as e:
            logger.error(f"Error saving search: {e}")
            return False
    
    async def get_saved_searches(self, user_id: str) -> List[SavedSearch]:
        """Get saved searches for a user."""
        return [
            search for search in self.saved_searches.values()
            if search.user_id == user_id or search.is_public
        ]
    
    async def create_search_alert(self, alert: SearchAlert) -> bool:
        """Create a search alert."""
        try:
            self.search_alerts[alert.alert_id] = alert
            logger.info(f"Created search alert {alert.alert_id}: {alert.name}")
            return True
            
        except Exception as e:
            logger.error(f"Error creating search alert: {e}")
            return False
    
    async def get_autocomplete_suggestions(self, prefix: str, index_name: Optional[str] = None, limit: int = 10) -> List[str]:
        """Get autocomplete suggestions."""
        try:
            suggestions = set()
            
            # Use default index if none specified
            target_index = index_name or "default"
            documents = self.documents.get(target_index, [])
            
            for doc in documents:
                # Suggest object keys
                if doc.object_key.lower().startswith(prefix.lower()):
                    suggestions.add(doc.object_key)
                
                # Suggest content types
                if doc.content_type.lower().startswith(prefix.lower()):
                    suggestions.add(doc.content_type)
            
            return sorted(list(suggestions))[:limit]
            
        except Exception as e:
            logger.error(f"Error getting autocomplete suggestions: {e}")
            return []
    
    async def get_index_health(self, index_name: str) -> Dict:
        """Get index health status."""
        try:
            if index_name not in self.indexes:
                raise ValueError(f"Index {index_name} not found")
            
            index = self.indexes[index_name]
            documents = self.documents.get(index_name, [])
            
            # Calculate health score
            health_score = 100.0
            issues = []
            recommendations = []
            
            if index.status != IndexStatus.ACTIVE:
                health_score -= 50.0
                issues.append(f"Index status is {index.status.value}")
            
            if len(documents) == 0:
                health_score -= 30.0
                issues.append("No documents in index")
                recommendations.append("Run indexing job to populate index")
            
            return {
                "index_name": index_name,
                "status": index.status.value,
                "document_count": len(documents),
                "index_size_bytes": index.index_size_bytes,
                "last_updated": index.last_indexed.isoformat() if index.last_indexed else None,
                "health_score": health_score,
                "issues": issues,
                "recommendations": recommendations
            }
            
        except Exception as e:
            logger.error(f"Error getting index health: {e}")
            raise


# Global search service instance
search_service = SearchService()

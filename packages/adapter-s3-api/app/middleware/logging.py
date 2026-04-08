"""Logging middleware for FastAPI."""

import time
from typing import Callable

from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.types import ASGIApp

from app.core.logging import logger


class LoggingMiddleware(BaseHTTPMiddleware):
    """Middleware for logging HTTP requests and responses."""

    async def dispatch(
        self, request: Request, call_next: RequestResponseEndpoint
    ) -> Response:
        """Process the request and log the details.

        Args:
            request: The incoming request.
            call_next: The next middleware or route handler.

        Returns:
            Response: The response from the next middleware or route handler.
        """
        # Skip logging for health checks
        if request.url.path == "/health":
            return await call_next(request)

        # Log request
        start_time = time.time()
        
        # Log request details
        logger.info(
            "Request started",
            method=request.method,
            path=request.url.path,
            query_params=dict(request.query_params),
            client_host=request.client.host if request.client else None,
        )

        try:
            # Process the request
            response = await call_next(request)
            process_time = (time.time() - start_time) * 1000
            
            # Log response details
            logger.info(
                "Request completed",
                method=request.method,
                path=request.url.path,
                status_code=response.status_code,
                process_time=f"{process_time:.2f}ms",
            )
            
            return response
            
        except Exception as e:
            # Log any exceptions that occur during request processing
            process_time = (time.time() - start_time) * 1000
            logger.error(
                "Request failed",
                method=request.method,
                path=request.url.path,
                error=str(e),
                process_time=f"{process_time:.2f}ms",
                exc_info=True,
            )
            raise

"""Logging configuration and utilities."""

import logging
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

from loguru import logger
from loguru._defaults import LOGURU_FORMAT

from app.core.config import settings


class InterceptHandler(logging.Handler):
    """Intercept standard logging messages toward Loguru."""

    def emit(self, record: logging.LogRecord) -> None:
        """Emit a log record.

        Args:
            record: The log record to emit.
        """
        try:
            level = logger.level(record.levelname).name
        except ValueError:
            level = record.levelno

        # Find caller from where the logged message originated
        frame, depth = logging.currentframe(), 2
        while frame and frame.f_code.co_filename == logging.__file__:
            frame = frame.f_back
            depth += 1

        logger.opt(depth=depth, exception=record.exc_info).log(level, record.getMessage())


def setup_logging() -> None:
    """Configure logging with Loguru."""
    log_level = settings.LOG_LEVEL.upper()
    log_format = (
        "<green>{time:YYYY-MM-DD HH:mm:ss.SSS}</green> | "
        "<level>{level: <8}</level> | "
        "<cyan>{name}</cyan>:<cyan>{function}</cyan>:<cyan>{line}</cyan> - "
        "<level>{message}</level>"
    )
    
    # Remove all existing handlers
    logger.remove()
    
    # Add stdout handler
    logger.add(
        sys.stdout,
        level=log_level,
        format=log_format,
        colorize=True,
    )
    
    # Configure file logging in production
    if settings.ENVIRONMENT == "production":
        log_path = Path("logs")
        log_path.mkdir(exist_ok=True)
        
        logger.add(
            log_path / "app.log",
            rotation="100 MB",
            retention="30 days",
            level=log_level,
            format=log_format,
            enqueue=True,
            backtrace=True,
            diagnose=True,
            compression="zip",
        )
    
    # Intercept standard logging
    logging.basicConfig(handlers=[InterceptHandler()], level=0, force=True)
    
    # Disable noisy loggers
    for logger_name in ["uvicorn", "uvicorn.error", "fastapi"]:
        logging_logger = logging.getLogger(logger_name)
        logging_logger.handlers = [InterceptHandler(level=log_level)]
    
    # Set log levels
    logging.getLogger("uvicorn").setLevel(log_level)
    logging.getLogger("uvicorn.access").disabled = True
    logging.getLogger("uvicorn.error").propagate = False
    logging.getLogger("fastapi").propagate = False
    
    logger.info("Logging configured successfully")

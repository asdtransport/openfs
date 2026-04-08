"""API endpoints for monitoring dashboard and status page."""

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse
from datetime import datetime, timezone

from app.api.v1.endpoints.monitoring import (
    comprehensive_health_check, 
    service_metrics,
    request_counter,
    service_start_time
)
from app.core.config import settings

router = APIRouter(prefix="/dashboard", tags=["dashboard"])

@router.get("/", response_class=HTMLResponse)
async def monitoring_dashboard(request: Request):
    """HTML monitoring dashboard for visual system status.
    
    Returns:
        HTMLResponse: Interactive monitoring dashboard
    """
    try:
        # Get current system status
        health_data = await comprehensive_health_check()
        metrics_data = await service_metrics()
        
        # Generate HTML dashboard
        html_content = f"""
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>MinIO Sync API - Monitoring Dashboard</title>
            <style>
                body {{
                    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                    margin: 0;
                    padding: 20px;
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    color: #333;
                    min-height: 100vh;
                }}
                .container {{
                    max-width: 1200px;
                    margin: 0 auto;
                    background: white;
                    border-radius: 15px;
                    box-shadow: 0 20px 40px rgba(0,0,0,0.1);
                    overflow: hidden;
                }}
                .header {{
                    background: linear-gradient(135deg, #2c3e50, #34495e);
                    color: white;
                    padding: 30px;
                    text-align: center;
                }}
                .header h1 {{
                    margin: 0;
                    font-size: 2.5em;
                    font-weight: 300;
                }}
                .header p {{
                    margin: 10px 0 0 0;
                    opacity: 0.8;
                    font-size: 1.1em;
                }}
                .status-grid {{
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
                    gap: 20px;
                    padding: 30px;
                }}
                .status-card {{
                    background: #f8f9fa;
                    border-radius: 10px;
                    padding: 25px;
                    border-left: 5px solid #28a745;
                    transition: transform 0.2s;
                }}
                .status-card:hover {{
                    transform: translateY(-2px);
                    box-shadow: 0 5px 15px rgba(0,0,0,0.1);
                }}
                .status-card.unhealthy {{
                    border-left-color: #dc3545;
                    background: #fff5f5;
                }}
                .status-card.degraded {{
                    border-left-color: #ffc107;
                    background: #fffbf0;
                }}
                .status-title {{
                    font-size: 1.2em;
                    font-weight: 600;
                    margin-bottom: 10px;
                    color: #2c3e50;
                }}
                .status-value {{
                    font-size: 2em;
                    font-weight: 300;
                    margin-bottom: 5px;
                }}
                .status-healthy {{
                    color: #28a745;
                }}
                .status-unhealthy {{
                    color: #dc3545;
                }}
                .status-degraded {{
                    color: #ffc107;
                }}
                .status-details {{
                    font-size: 0.9em;
                    color: #666;
                    margin-top: 10px;
                }}
                .metrics-section {{
                    background: #f8f9fa;
                    padding: 30px;
                    border-top: 1px solid #e9ecef;
                }}
                .metrics-grid {{
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
                    gap: 20px;
                }}
                .metric-item {{
                    text-align: center;
                    padding: 20px;
                    background: white;
                    border-radius: 8px;
                    box-shadow: 0 2px 4px rgba(0,0,0,0.1);
                }}
                .metric-value {{
                    font-size: 2em;
                    font-weight: bold;
                    color: #2c3e50;
                }}
                .metric-label {{
                    color: #666;
                    font-size: 0.9em;
                    margin-top: 5px;
                }}
                .refresh-info {{
                    text-align: center;
                    padding: 20px;
                    color: #666;
                    border-top: 1px solid #e9ecef;
                }}
                .endpoint-list {{
                    background: white;
                    padding: 30px;
                    border-top: 1px solid #e9ecef;
                }}
                .endpoint-item {{
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 15px;
                    margin: 10px 0;
                    background: #f8f9fa;
                    border-radius: 8px;
                    border-left: 4px solid #007bff;
                }}
                .endpoint-url {{
                    font-family: 'Courier New', monospace;
                    font-weight: bold;
                    color: #007bff;
                }}
                .endpoint-desc {{
                    color: #666;
                    font-size: 0.9em;
                }}
                @media (max-width: 768px) {{
                    .status-grid, .metrics-grid {{
                        grid-template-columns: 1fr;
                    }}
                    .header h1 {{
                        font-size: 2em;
                    }}
                }}
            </style>
            <script>
                // Auto-refresh every 30 seconds
                setTimeout(function() {{
                    location.reload();
                }}, 30000);
            </script>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>🌊 MinIO Sync API</h1>
                    <p>Enterprise-Grade S3 Storage & Streaming Platform</p>
                    <p>Status: <strong>{'🟢 ' + health_data.overall_status.upper()}</strong> | Last Updated: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}</p>
                </div>
                
                <div class="status-grid">
                    <div class="status-card {'unhealthy' if health_data.api_health.status != 'healthy' else ''}">
                        <div class="status-title">🚀 API Service</div>
                        <div class="status-value status-{health_data.api_health.status}">{health_data.api_health.status.upper()}</div>
                        <div class="status-details">Response Time: {health_data.api_health.response_time_ms}ms</div>
                    </div>
                    
                    <div class="status-card {'unhealthy' if health_data.minio_liveness.status != 'healthy' else ''}">
                        <div class="status-title">💾 MinIO Liveness</div>
                        <div class="status-value status-{health_data.minio_liveness.status}">{health_data.minio_liveness.status.upper()}</div>
                        <div class="status-details">Response Time: {health_data.minio_liveness.response_time_ms}ms</div>
                    </div>
                    
                    <div class="status-card {'unhealthy' if health_data.minio_cluster_write.status != 'healthy' else ''}">
                        <div class="status-title">✏️ Write Quorum</div>
                        <div class="status-value status-{health_data.minio_cluster_write.status}">{health_data.minio_cluster_write.status.upper()}</div>
                        <div class="status-details">Cluster Write Capability</div>
                    </div>
                    
                    <div class="status-card {'unhealthy' if health_data.minio_cluster_read.status != 'healthy' else ''}">
                        <div class="status-title">📖 Read Quorum</div>
                        <div class="status-value status-{health_data.minio_cluster_read.status}">{health_data.minio_cluster_read.status.upper()}</div>
                        <div class="status-details">Cluster Read Capability</div>
                    </div>
                </div>
                
                <div class="metrics-section">
                    <h2 style="text-align: center; color: #2c3e50; margin-bottom: 30px;">📊 Service Metrics</h2>
                    <div class="metrics-grid">
                        <div class="metric-item">
                            <div class="metric-value">{int(metrics_data.uptime_seconds // 3600)}h {int((metrics_data.uptime_seconds % 3600) // 60)}m</div>
                            <div class="metric-label">Uptime</div>
                        </div>
                        <div class="metric-item">
                            <div class="metric-value">{metrics_data.total_requests:,}</div>
                            <div class="metric-label">Total Requests</div>
                        </div>
                        <div class="metric-item">
                            <div class="metric-value">{metrics_data.active_streaming_sessions}</div>
                            <div class="metric-label">Active Streams</div>
                        </div>
                        <div class="metric-item">
                            <div class="metric-value">{metrics_data.bucket_count}</div>
                            <div class="metric-label">Buckets</div>
                        </div>
                        <div class="metric-item">
                            <div class="metric-value">{metrics_data.total_objects:,}</div>
                            <div class="metric-label">Total Objects</div>
                        </div>
                        <div class="metric-item">
                            <div class="metric-value">{metrics_data.total_size_bytes / (1024*1024):.1f} MB</div>
                            <div class="metric-label">Storage Used</div>
                        </div>
                    </div>
                </div>
                
                <div class="endpoint-list">
                    <h2 style="text-align: center; color: #2c3e50; margin-bottom: 30px;">🔗 Health Check Endpoints</h2>
                    
                    <div class="endpoint-item">
                        <div>
                            <div class="endpoint-url">GET /api/v1/monitoring/health</div>
                            <div class="endpoint-desc">Basic API health check</div>
                        </div>
                    </div>
                    
                    <div class="endpoint-item">
                        <div>
                            <div class="endpoint-url">GET /api/v1/monitoring/health/minio/live</div>
                            <div class="endpoint-desc">MinIO liveness probe</div>
                        </div>
                    </div>
                    
                    <div class="endpoint-item">
                        <div>
                            <div class="endpoint-url">GET /api/v1/monitoring/health/minio/cluster</div>
                            <div class="endpoint-desc">MinIO cluster write quorum</div>
                        </div>
                    </div>
                    
                    <div class="endpoint-item">
                        <div>
                            <div class="endpoint-url">GET /api/v1/monitoring/health/minio/cluster/read</div>
                            <div class="endpoint-desc">MinIO cluster read quorum</div>
                        </div>
                    </div>
                    
                    <div class="endpoint-item">
                        <div>
                            <div class="endpoint-url">GET /api/v1/monitoring/health/comprehensive</div>
                            <div class="endpoint-desc">Complete system health status</div>
                        </div>
                    </div>
                    
                    <div class="endpoint-item">
                        <div>
                            <div class="endpoint-url">GET /api/v1/monitoring/metrics</div>
                            <div class="endpoint-desc">Service metrics and statistics</div>
                        </div>
                    </div>
                    
                    <div class="endpoint-item">
                        <div>
                            <div class="endpoint-url">GET /api/v1/monitoring/ready</div>
                            <div class="endpoint-desc">Kubernetes readiness probe</div>
                        </div>
                    </div>
                    
                    <div class="endpoint-item">
                        <div>
                            <div class="endpoint-url">GET /api/v1/monitoring/live</div>
                            <div class="endpoint-desc">Kubernetes liveness probe</div>
                        </div>
                    </div>
                </div>
                
                <div class="refresh-info">
                    <p>🔄 This dashboard auto-refreshes every 30 seconds</p>
                    <p>🌐 Endpoint: {settings.MINIO_ENDPOINT} | Environment: {settings.ENVIRONMENT}</p>
                </div>
            </div>
        </body>
        </html>
        """
        
        return HTMLResponse(content=html_content)
        
    except Exception as e:
        # Fallback error page
        error_html = f"""
        <!DOCTYPE html>
        <html>
        <head>
            <title>MinIO Sync API - Error</title>
            <style>
                body {{ font-family: Arial, sans-serif; padding: 50px; text-align: center; }}
                .error {{ color: #dc3545; }}
            </style>
        </head>
        <body>
            <h1>🚨 Monitoring Dashboard Error</h1>
            <p class="error">Error loading dashboard: {str(e)}</p>
            <p><a href="/api/v1/monitoring/health">Try Basic Health Check</a></p>
        </body>
        </html>
        """
        return HTMLResponse(content=error_html, status_code=500)

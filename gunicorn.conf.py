# Defaults for small instances (Render free tier: 512 MB). Command-line flags override these.
import os

bind = f"0.0.0.0:{os.getenv('PORT', '5000')}"
workers = int(os.getenv("WEB_CONCURRENCY", "1"))
threads = 4
worker_class = "gthread"
timeout = 300            # a brand-new mission can take a while on a fractional CPU
graceful_timeout = 30
max_requests = 200       # recycle the worker now and then to return fragmented memory
max_requests_jitter = 20

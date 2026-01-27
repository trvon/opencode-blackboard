FROM ubuntu:22.04

# Install dependencies
RUN apt-get update && apt-get install -y \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# YAMS version - defaults to latest
ARG YAMS_VERSION=latest

# Download YAMS binary
RUN if [ "$YAMS_VERSION" = "latest" ]; then \
      DOWNLOAD_URL=$(curl -s https://api.github.com/repos/trvon/yams/releases/latest | \
        grep "browser_download_url.*linux-amd64" | cut -d '"' -f 4); \
    else \
      DOWNLOAD_URL="https://github.com/trvon/yams/releases/download/${YAMS_VERSION}/yams-linux-amd64"; \
    fi && \
    curl -L "$DOWNLOAD_URL" -o /usr/local/bin/yams && \
    chmod +x /usr/local/bin/yams

# Create data directory
RUN mkdir -p /var/lib/yams

# Expose default YAMS port
EXPOSE 9933

# Health check
HEALTHCHECK --interval=2s --timeout=5s --retries=10 \
    CMD yams status || exit 1

# Run YAMS daemon in foreground
CMD ["yams", "daemon", "start", "--foreground"]

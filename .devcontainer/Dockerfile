# Dockerfile for DevContainer
FROM oven/bun:1.3.10

# Install essential packages
RUN apt-get update && apt-get install -y \
    curl \
    bash \
    git \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Create workspace directory
WORKDIR /workspaces/nearzero

# Set up user permissions
USER bun
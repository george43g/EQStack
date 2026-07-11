FROM node:20-slim

WORKDIR /app

# Copy package files
COPY package.json package-lock.json* ./

# Copy source files and config first
COPY tsconfig.json ./
COPY src ./src

# Install dependencies and build the CLI
RUN npm ci --ignore-scripts
RUN npm run build

# Create directory for credentials and config
RUN mkdir -p /gmail-server /root/.gmail-mcp

# Set environment variables
ENV NODE_ENV=production
ENV GMAIL_CREDENTIALS_PATH=/gmail-server/credentials.json
ENV GMAIL_OAUTH_PATH=/root/.gmail-mcp/gcp-oauth.keys.json

# Expose port for OAuth flow
EXPOSE 3000

# Set entrypoint command. The default mode is MCP stdio; pass other `gmail`
# subcommands after the image name for auth, CLI, console, or TUI usage.
ENTRYPOINT ["node", "dist/cli/index.js"]
CMD ["mcp"]

FROM node:20-alpine

# Install FFmpeg, fonts (required for subtitles), Python (for yt-dlp), and dependencies
RUN apk add --no-cache \
    ffmpeg \
    ffmpeg-libs \
    fontconfig \
    ttf-freefont \
    font-noto \
    font-noto-emoji \
    curl \
    unzip \
    python3 \
    py3-pip \
    && rm -rf /var/cache/apk/*

# Install yt-dlp for YouTube download functionality
RUN pip3 install --no-cache-dir --break-system-packages yt-dlp

# Download and install Montserrat font from Google Fonts
RUN mkdir -p /usr/share/fonts/montserrat \
    && curl -L "https://fonts.google.com/download?family=Montserrat" -o /tmp/montserrat.zip \
    && unzip /tmp/montserrat.zip -d /usr/share/fonts/montserrat \
    && rm /tmp/montserrat.zip \
    && fc-cache -f

# Create app directory
WORKDIR /app

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs \
    && adduser -S nodejs -u 1001

# Copy package files
COPY package*.json ./

# Install dependencies (production only)
RUN npm ci --only=production && npm cache clean --force

# Copy source code
COPY --chown=nodejs:nodejs . .

# Create temp directory for video processing
RUN mkdir -p /tmp && chown -R nodejs:nodejs /tmp

# Switch to non-root user
USER nodejs

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/health || exit 1

# Start server
CMD ["node", "server.js"]

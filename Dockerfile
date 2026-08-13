# 1. Base Node.js image
FROM node:18-slim

# 2. Install FFmpeg, Python3, pip, and curl
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    curl \
    && rm -rf /var/lib/apt-lists/*

# 3. Install latest yt-dlp via pip
RUN pip3 install --break-system-packages yt-dlp || pip3 install yt-dlp

# 4. Create working directory
WORKDIR /app

# 5. Copy package files and install npm dependencies
COPY package*.json ./
RUN npm install

# 6. Copy all project files
COPY . .

# 7. Expose Port
EXPOSE 5001

# 8. Start application
CMD ["node", "server.js"]
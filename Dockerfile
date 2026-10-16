FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 ffmpeg git curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# yt-dlp (latest)
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
    -o /usr/local/bin/yt-dlp && chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .

EXPOSE 8000
CMD ["node", "index.js"]

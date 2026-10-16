# WhatsApp YouTube Downloader Bot

Send a YouTube link → bot asks **1 (MP4)** or **2 (MP3)** → reply with the number → get the file.

Stack: Node.js, [Baileys](https://github.com/WhiskeySockets/Baileys), [yt-dlp](https://github.com/yt-dlp/yt-dlp), ffmpeg.

## Deploy on Koyeb
1. Push this repo to GitHub.
2. Koyeb -> Create Service -> GitHub -> select repo.
3. Builder: **Dockerfile**. Service type: **Web**, port **8000** (HTTP).
4. Env variable: `PAIR_PASSWORD=your-secret-password`
5. Deploy, then open the service's public URL (`https://xxxx.koyeb.app`).
6. Enter your WhatsApp number (with country code, no +) and the password -> you get a pairing code.
7. WhatsApp -> Linked devices -> Link a device -> Link with phone number instead -> enter the code.
8. After connect, the logs print `SESSION_B64`. Copy it into an env variable named `SESSION_B64` and redeploy.
   (Koyeb storage is not persistent, so without this you must pair again after every restart.)

## Local run
```
cp .env.example .env
npm install
node --env-file=.env index.js
```
Requires `yt-dlp` and `ffmpeg` installed locally.

## Notes
- If YouTube blocks the server IP ("Sign in to confirm you're not a bot"), export cookies from a browser to `cookies.txt` (add it to the image or mount it) – never commit it.
- If yt-dlp complains about a JS runtime, set `YTDLP_EXTRA_ARGS=--js-runtimes node`.
- Videos above `MAX_VIDEO_MB` are sent as documents.
- Keep `SESSION_B64` secret – it gives full access to the linked WhatsApp session.

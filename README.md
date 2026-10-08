# Web Minecraft Client

Custom web Minecraft client (Three.js + mineflayer) with built-in shaders,
no branding. Connects to Java servers (e.g. DonutSMP) and wss:// servers.

## Deploy (Render.com free tier)

1. Connect this repo on Render.com
2. New Web Service — build settings are in `render.yaml` (auto-detected)
3. Open the URL Render gives you, pick a username, play.

The frontend is downloaded from a file host at build time (see `render.yaml`).

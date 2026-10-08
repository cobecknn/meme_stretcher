# meme_stretcher
make your photo "stretchy"

**Author:** Phoenix Dong (Houde Dong) · [@cobecknn](https://github.com/cobecknn)

Drop in an image and it loops through stretching and squashing, then export the result as a GIF or video meme.

## Features

- **Import:** drag and drop, click to pick a file, or paste with Ctrl+V.
- **Axes:** add or delete stretch/compress directions (any angle), each with its own:
  - **max multiplier**: how far it stretches at the top of the graph (and compresses at the bottom)
  - **cycle duration**: how long one loop takes
  - **movement graph**: time left to right, tensity up and down. Click to add a point, drag to move it, double-click or right-click to delete it. Comes with presets (wave, pulse, bounce, ramp, snap, …).
  - **keep area**: squash the other direction while stretching
- **Lasso cut:** hold the left mouse button and draw around part of the image, then release on the green start point to close the shape. Choose whether to keep or remove the inside. Includes undo and reset.
- **Empty background:** transparent background, so GIFs look clean on Discord and similar apps.
- **Export:** GIF, MP4 or WebM, with size, FPS, and a "one full loop only" option for seamless loops.

## Setup

The app is plain HTML, CSS and JavaScript, with no build step and no dependencies to install.

### 1. Get the code

With [Git](https://git-scm.com/downloads) installed:

```
git clone https://github.com/cobecknn/meme_stretcher.git
cd meme_stretcher
```

Or, on GitHub, click **Code → Download ZIP** and unzip it.

### 2. Run it

**Option A, quickest:** double-click `index.html` to open it in your browser.

**Option B, local server** (closer to a real website). This needs [Python 3](https://www.python.org/downloads/):

```
python -m http.server 8000
```

Then open http://localhost:8000. Press **Ctrl+C** in the terminal to stop the server.

### 3. Open it on your phone (optional)

With your phone on the same Wi-Fi as your computer:

```
python -m http.server 8000 --bind 0.0.0.0
```

Find your computer's local IP address (`ipconfig` on Windows, `ifconfig` or `ip addr` on macOS/Linux) and open `http://<that-ip>:8000` on your phone. On Windows, allow Python through the firewall on **Private networks** if asked.

### Browser support

Use a recent Chrome, Edge or Firefox. GIF export works everywhere. Which video formats (MP4 / WebM) appear in the export menu depends on what your browser can record.

## License

Copyright © 2026 Phoenix Dong (Houde Dong).

This project is **source-available**, licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE.md).

- ✅ Free for personal use, learning, hobby projects, research, and non-profit organizations: use it, change it, and share it.
- ❌ **Commercial use is not allowed** without my permission.

For a commercial license, contact me via [GitHub](https://github.com/cobecknn).

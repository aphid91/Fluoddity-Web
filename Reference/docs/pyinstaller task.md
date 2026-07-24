# Packaging Instructions

## Goal
Package this Python application as a standalone Windows executable using PyInstaller, bundling FFmpeg so end users don't need Python or FFmpeg installed.

## Setup

1. Install PyInstaller: `pip install pyinstaller`
2. Download static FFmpeg build from https://www.gyan.dev/ffmpeg/builds/ (get "essentials" build)
3. Place `ffmpeg.exe` in a `bin/` folder in the project

## Code Changes

Any code that calls `ffmpeg` via subprocess needs to use a helper function to locate the bundled executable:
```python
import sys
import os

def get_ffmpeg_path():
    if getattr(sys, 'frozen', False):
        base_path = sys._MEIPASS
    else:
        base_path = os.path.dirname(os.path.abspath(__file__))
    
    ffmpeg_name = 'ffmpeg.exe' if sys.platform == 'win32' else 'ffmpeg'
    return os.path.join(base_path, 'bin', ffmpeg_name)
```

Replace any hardcoded `'ffmpeg'` string in subprocess calls with `get_ffmpeg_path()`.

## PyInstaller Configuration

Create a `.spec` file with:
- `--onedir` mode (folder output, faster startup)
- `--noconsole` (no terminal window)
- `binaries=[('bin/ffmpeg.exe', 'bin')]` to bundle ffmpeg

Build command after spec is created:
```bash
pyinstaller your_app.spec
```

## Output
The `dist/` folder will contain the distributable application folder.
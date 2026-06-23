# Free Video to GIF Converter

For a long time I was using a pretty old tool called "Free Video to GIF Converter" which happens to be just a GUI wrapper for an old version of FFmpeg. The application has no working website, no contact information, nothing. Since the tool was outdated, I decided to build a new one with some additional features. But the main goal remains the same — make GIFs.

![Rust](https://img.shields.io/badge/Rust-000?logo=rust&logoColor=white) ![Tauri](https://img.shields.io/badge/Tauri_v2-24C8D8?logo=tauri&logoColor=white) ![JavaScript](https://img.shields.io/badge/JS-F7DF1E?logo=javascript&logoColor=000) ![FFmpeg](https://img.shields.io/badge/FFmpeg-007808?logo=ffmpeg&logoColor=white)
![Windows](https://img.shields.io/badge/Windows_10+-0078D4?logo=windows&logoColor=white)

## Usage

1. Download the latest `.zip` from [Releases](https://github.com/gkalian/video-to-gif-converter/releases)
2. Extract the archive
3. Download [FFmpeg](https://www.gyan.dev/ffmpeg/builds/) (any recent build)
4. Place `ffmpeg.exe` in the same folder as the application `.exe`
5. Run the application

No installer required. Windows 10+ (WebView2 is preinstalled).

## Features

- Trim video by start/end time
- Set output resolution and frame rate
- Frame editor with preview, select/deselect, remove
- Multi-select: Ctrl+Click toggle, Shift+Click range
- GIF quality: low / medium / high (per-frame color palette)
- Fast mode: global palette for smaller file size and faster encoding

## Supported Formats

AVI, MP4, MKV, MOV, WMV, FLV, WebM, MPEG, 3GP, VOB, RMVB, TS, M4V

## Developing and building

<details>
  <summary>Click to expand</summary>
  
Prerequisites: [Rust](https://rustup.rs/), WebView2 (preinstalled on Win10+)

```powershell
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
cd src-tauri
cargo tauri dev
```

Requires `ffmpeg.exe` next to the built binary or in PATH.

## Build

```powershell
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
cd src-tauri
cargo tauri build --no-bundle
```

Output: `src-tauri\target\release\video-to-gif.exe` (~3.5 MB)

## Release

Automated via GitHub Actions — push a `v*` tag to create a release:

```bash
git tag v1.0.0
git push origin v1.0.0
```
  
</details>


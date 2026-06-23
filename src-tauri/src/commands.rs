use std::fs;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::io::Read;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

static TEMP_DIR: Mutex<Option<PathBuf>> = Mutex::new(None);
static CANCEL_FLAG: Mutex<bool> = Mutex::new(false);
static GIF_CANCEL_FLAG: Mutex<bool> = Mutex::new(false);
static EXTRACT_PID: Mutex<Option<u32>> = Mutex::new(None);

fn get_ffmpeg_path(app: &AppHandle) -> PathBuf {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_default();

    let candidate = exe_dir.join("ffmpeg.exe");
    if candidate.exists() {
        return candidate;
    }

    // Dev mode: check next to the project
    let resource_path = app
        .path()
        .resource_dir()
        .ok()
        .map(|p| p.join("ffmpeg.exe"))
        .unwrap_or_default();

    if resource_path.exists() {
        return resource_path;
    }

    PathBuf::from("ffmpeg.exe")
}

fn get_temp_dir() -> PathBuf {
    let mut lock = TEMP_DIR.lock().unwrap();
    if let Some(ref dir) = *lock {
        if dir.exists() {
            return dir.clone();
        }
    }
    let dir = std::env::temp_dir().join(format!("vtg-{}", std::process::id()));
    fs::create_dir_all(&dir).ok();
    *lock = Some(dir.clone());
    dir
}

#[derive(Serialize)]
pub struct VideoInfo {
    duration: f64,
    width: u32,
    height: u32,
    fps: f64,
    codec: String,
    file_size: u64,
}

#[derive(Deserialize)]
pub struct ExtractOptions {
    input_path: String,
    start_time: f64,
    end_time: f64,
    fps: u32,
    width: u32,
    height: u32,
}

#[derive(Deserialize)]
pub struct GifOptions {
    frames: Vec<String>,
    fps: u32,
    quality: String,
    looping: bool,
    fast_mode: bool,
    output_path: String,
}

#[tauri::command]
pub fn get_ffmpeg_status(app: AppHandle) -> bool {
    let path = get_ffmpeg_path(&app);
    path.exists()
}

#[tauri::command]
pub fn get_video_info(app: AppHandle, file_path: String) -> Result<VideoInfo, String> {
    let ffmpeg = get_ffmpeg_path(&app);
    let output = new_hidden_command(&ffmpeg)
        .args(["-i", &file_path])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("Failed to start ffmpeg: {}", e))?;

    let stderr = String::from_utf8_lossy(&output.stderr);
    parse_video_info(&stderr, &file_path)
}

fn parse_video_info(output: &str, file_path: &str) -> Result<VideoInfo, String> {
    let mut duration = 0.0f64;
    if let Some(caps) = output.find("Duration:") {
        let slice = &output[caps + 9..];
        if let Some(comma) = slice.find(',') {
            let time_str = slice[..comma].trim();
            let parts: Vec<&str> = time_str.split(':').collect();
            if parts.len() == 3 {
                let h: f64 = parts[0].parse().unwrap_or(0.0);
                let m: f64 = parts[1].parse().unwrap_or(0.0);
                let s: f64 = parts[2].parse().unwrap_or(0.0);
                duration = h * 3600.0 + m * 60.0 + s;
            }
        }
    }

    let mut width = 0u32;
    let mut height = 0u32;
    let mut codec = String::from("unknown");

    // Parse "Stream ... Video: codec ..., WxH"
    if let Some(video_pos) = output.find("Video:") {
        let video_slice = &output[video_pos..];

        // Codec
        if let Some(space) = video_slice[7..].find(|c: char| c == ',' || c == ' ') {
            codec = video_slice[7..7 + space].to_string();
        }

        // Resolution: find NNNNxNNNN pattern
        let re_like = find_resolution(video_slice);
        if let Some((w, h)) = re_like {
            width = w;
            height = h;
        }
    }

    let mut fps = 24.0f64;
    // Find "NN fps" or "NN tbr"
    for pat in ["fps", "tbr"] {
        if let Some(pos) = output.find(pat) {
            let before = &output[..pos].trim_end();
            if let Some(space_pos) = before.rfind(|c: char| c == ' ' || c == ',') {
                if let Ok(f) = before[space_pos + 1..].trim().parse::<f64>() {
                    fps = f;
                    break;
                }
            }
        }
    }

    let file_size = fs::metadata(file_path).map(|m| m.len()).unwrap_or(0);

    if width == 0 || height == 0 {
        return Err("No video stream found in file".to_string());
    }

    Ok(VideoInfo {
        duration,
        width,
        height,
        fps,
        codec,
        file_size,
    })
}

fn find_resolution(s: &str) -> Option<(u32, u32)> {
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() {
            let start = i;
            while i < bytes.len() && bytes[i].is_ascii_digit() {
                i += 1;
            }
            if i < bytes.len() && bytes[i] == b'x' {
                let w_str = &s[start..i];
                i += 1;
                let h_start = i;
                while i < bytes.len() && bytes[i].is_ascii_digit() {
                    i += 1;
                }
                if i > h_start {
                    let h_str = &s[h_start..i];
                    if let (Ok(w), Ok(h)) = (w_str.parse::<u32>(), h_str.parse::<u32>()) {
                        if w >= 16 && h >= 16 && w <= 7680 && h <= 4320 {
                            return Some((w, h));
                        }
                    }
                }
            }
        }
        i += 1;
    }
    None
}

#[tauri::command]
pub async fn extract_frames(
    app: AppHandle,
    options: ExtractOptions,
) -> Result<Vec<String>, String> {
    *CANCEL_FLAG.lock().unwrap() = false;

    let temp_dir = get_temp_dir();
    // Clear old frames
    if temp_dir.exists() {
        for entry in fs::read_dir(&temp_dir).map_err(|e| e.to_string())? {
            if let Ok(entry) = entry {
                fs::remove_file(entry.path()).ok();
            }
        }
    }

    let ffmpeg = get_ffmpeg_path(&app);
    let duration = options.end_time - options.start_time;
    let output_pattern = temp_dir.join("%04d.png");

    let mut child = new_hidden_command(&ffmpeg)
        .args([
            "-ss", &options.start_time.to_string(),
            "-i", &options.input_path,
            "-t", &duration.to_string(),
            "-r", &options.fps.to_string(),
            "-s", &format!("{}x{}", options.width, options.height),
            "-y",
            output_pattern.to_str().unwrap(),
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start ffmpeg: {}", e))?;

    *EXTRACT_PID.lock().unwrap() = Some(child.id());
    let expected_frames = (duration * options.fps as f64).ceil() as u32;

    // Read stderr for progress
    let stderr = child.stderr.take().unwrap();
    let app_clone = app.clone();
    let handle = std::thread::spawn(move || {
        let mut reader = std::io::BufReader::new(stderr);
        let mut buf = [0u8; 256];
        let mut accumulated = String::new();

        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    accumulated.push_str(&String::from_utf8_lossy(&buf[..n]));
                    // Parse "frame= NNN"
                    if let Some(pos) = accumulated.rfind("frame=") {
                        let slice = &accumulated[pos + 6..];
                        let num_str: String = slice.chars()
                            .skip_while(|c| c.is_whitespace())
                            .take_while(|c| c.is_ascii_digit())
                            .collect();
                        if let Ok(frame) = num_str.parse::<u32>() {
                            let percent = ((frame as f64 / expected_frames as f64) * 100.0)
                                .min(99.0) as u32;
                            app_clone.emit("extract-progress", percent).ok();
                        }
                    }
                }
                Err(_) => break,
            }
        }
    });

    let status = child.wait().map_err(|e| e.to_string())?;
    *EXTRACT_PID.lock().unwrap() = None;
    handle.join().ok();

    if *CANCEL_FLAG.lock().unwrap() {
        return Err("Cancelled".to_string());
    }

    if !status.success() {
        return Err("FFmpeg frame extraction failed".to_string());
    }

    app.emit("extract-progress", 100u32).ok();

    // Collect frame paths
    let mut frames: Vec<String> = fs::read_dir(&temp_dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().map(|ext| ext == "png").unwrap_or(false))
        .map(|p| p.to_string_lossy().to_string())
        .collect();

    frames.sort();
    Ok(frames)
}

#[tauri::command]
pub fn cancel_extraction() {
    *CANCEL_FLAG.lock().unwrap() = true;
    if let Some(pid) = *EXTRACT_PID.lock().unwrap() {
        kill_process(pid);
    }
}

#[tauri::command]
pub fn cancel_gif_creation() {
    *GIF_CANCEL_FLAG.lock().unwrap() = true;
}

#[tauri::command]
pub async fn make_gif(app: AppHandle, options: GifOptions) -> Result<(), String> {
    *GIF_CANCEL_FLAG.lock().unwrap() = false;

    let delay = (100.0 / options.fps as f64).round() as u16;

    let frames = &options.frames;
    if frames.is_empty() {
        return Err("No frames".to_string());
    }

    let (width, height, _) = read_png_rgba(&frames[0])?;

    let output_file = fs::File::create(&options.output_path).map_err(|e| e.to_string())?;
    let mut encoder = gif::Encoder::new(output_file, width as u16, height as u16, &[])
        .map_err(|e| e.to_string())?;

    if options.looping {
        encoder.set_repeat(gif::Repeat::Infinite).map_err(|e| e.to_string())?;
    }

    let total = frames.len();

    let sample_factor = match options.quality.as_str() {
        "low" => 10,
        "medium" => 3,
        _ => 1,
    };

    if options.fast_mode {
        // Phase 1: read frames and build global palette (0-40%)
        let mut all_pixels = Vec::new();
        let mut frame_data: Vec<Vec<u8>> = Vec::with_capacity(total);
        for (i, frame_path) in frames.iter().enumerate() {
            if *GIF_CANCEL_FLAG.lock().unwrap() {
                return Err("GIF creation cancelled".to_string());
            }
            let (_, _, rgba) = read_png_rgba(frame_path)?;
            all_pixels.extend_from_slice(&rgba);
            frame_data.push(rgba);
            let percent = (((i + 1) as f64 / total as f64) * 20.0) as u32;
            app.emit("gif-progress", percent).ok();
        }

        // Phase 2: quantize (20-40%)
        app.emit("gif-progress", 25u32).ok();
        let nq = color_quant::NeuQuant::new(sample_factor, 256, &all_pixels);
        let global_palette: Vec<u8> = nq.color_map_rgb();
        drop(all_pixels);
        app.emit("gif-progress", 40u32).ok();

        // Phase 3: encode frames (40-100%)
        for (i, rgba) in frame_data.iter().enumerate() {
            if *GIF_CANCEL_FLAG.lock().unwrap() {
                return Err("GIF creation cancelled".to_string());
            }

            let mut indexed_pixels: Vec<u8> = Vec::with_capacity((width * height) as usize);
            for pixel in rgba.chunks(4) {
                indexed_pixels.push(nq.index_of(pixel) as u8);
            }

            let mut frame = gif::Frame::default();
            frame.width = width as u16;
            frame.height = height as u16;
            frame.delay = delay;
            frame.palette = Some(global_palette.clone());
            frame.buffer = std::borrow::Cow::Owned(indexed_pixels);

            encoder.write_frame(&frame).map_err(|e| e.to_string())?;

            let percent = 40 + (((i + 1) as f64 / total as f64) * 60.0) as u32;
            app.emit("gif-progress", percent).ok();
        }
    } else {
        for (i, frame_path) in frames.iter().enumerate() {
            if *GIF_CANCEL_FLAG.lock().unwrap() {
                return Err("GIF creation cancelled".to_string());
            }

            let (_, _, rgba) = read_png_rgba(frame_path)?;

            let nq = color_quant::NeuQuant::new(sample_factor, 256, &rgba);
            let mut indexed_pixels: Vec<u8> = Vec::with_capacity((width * height) as usize);
            for pixel in rgba.chunks(4) {
                indexed_pixels.push(nq.index_of(pixel) as u8);
            }

            let palette: Vec<u8> = nq.color_map_rgb();

            let mut frame = gif::Frame::default();
            frame.width = width as u16;
            frame.height = height as u16;
            frame.delay = delay;
            frame.palette = Some(palette);
            frame.buffer = std::borrow::Cow::Owned(indexed_pixels);

            encoder.write_frame(&frame).map_err(|e| e.to_string())?;

            let percent = (((i + 1) as f64 / total as f64) * 100.0) as u32;
            app.emit("gif-progress", percent).ok();
        }
    }

    Ok(())
}

fn read_png_rgba(path: &str) -> Result<(u32, u32, Vec<u8>), String> {
    let file = fs::File::open(path).map_err(|e| format!("Failed to open {}: {}", path, e))?;
    let decoder = png::Decoder::new(file);
    let mut reader = decoder.read_info().map_err(|e| e.to_string())?;

    let mut buf = vec![0u8; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).map_err(|e| e.to_string())?;
    buf.truncate(info.buffer_size());

    let width = info.width;
    let height = info.height;

    let rgba = match info.color_type {
        png::ColorType::Rgba => buf,
        png::ColorType::Rgb => {
            let mut rgba = Vec::with_capacity((width * height * 4) as usize);
            for chunk in buf.chunks(3) {
                rgba.extend_from_slice(chunk);
                rgba.push(255);
            }
            rgba
        }
        png::ColorType::Grayscale => {
            let mut rgba = Vec::with_capacity((width * height * 4) as usize);
            for &g in &buf {
                rgba.extend_from_slice(&[g, g, g, 255]);
            }
            rgba
        }
        png::ColorType::GrayscaleAlpha => {
            let mut rgba = Vec::with_capacity((width * height * 4) as usize);
            for chunk in buf.chunks(2) {
                rgba.extend_from_slice(&[chunk[0], chunk[0], chunk[0], chunk[1]]);
            }
            rgba
        }
        _ => return Err(format!("Unsupported PNG color type: {:?}", info.color_type)),
    };

    Ok((width, height, rgba))
}

#[tauri::command]
pub fn read_frame_base64(path: String) -> Result<String, String> {
    let data = fs::read(&path).map_err(|e| format!("Failed to read {}: {}", path, e))?;
    use base64::{Engine, engine::general_purpose::STANDARD};
    let b64 = STANDARD.encode(&data);
    Ok(format!("data:image/png;base64,{}", b64))
}

#[tauri::command]
pub fn cleanup_temp() {
    let mut lock = TEMP_DIR.lock().unwrap();
    if let Some(ref dir) = *lock {
        fs::remove_dir_all(dir).ok();
    }
    *lock = None;
}

#[tauri::command]
pub fn open_path(path: String) -> Result<(), String> {
    opener::open(&path).map_err(|e| e.to_string())
}

const CREATE_NO_WINDOW: u32 = 0x08000000;

fn new_hidden_command(program: &PathBuf) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

fn kill_process(pid: u32) {
    #[cfg(windows)]
    {
        Command::new("taskkill")
            .args(["/F", "/PID", &pid.to_string()])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .ok();
    }
    #[cfg(not(windows))]
    {
        Command::new("kill")
            .args(["-9", &pid.to_string()])
            .output()
            .ok();
    }
}

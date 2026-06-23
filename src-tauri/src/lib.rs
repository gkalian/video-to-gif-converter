mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::get_video_info,
            commands::extract_frames,
            commands::cancel_extraction,
            commands::make_gif,
            commands::cleanup_temp,
            commands::open_path,
            commands::get_ffmpeg_status,
            commands::read_frame_base64,
            commands::cancel_gif_creation,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

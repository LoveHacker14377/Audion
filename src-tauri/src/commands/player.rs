use rodio::{Decoder, OutputStream, Sink};
use serde::Serialize;
use std::fs::File;
use std::io::BufReader;
use std::sync::{Arc, Mutex};
use tauri::State;

pub struct PlayerState {
    pub sink: Arc<Mutex<Option<Sink>>>,
    pub stream: Arc<Mutex<Option<OutputStream>>>,
}

// Safety: OutputStream is not Send on Android/Linux due to CPAL/Oboe implementation details.
// We protect access via Mutex and ensure it's held within Arcs.
unsafe impl Send for PlayerState {}
unsafe impl Sync for PlayerState {}

impl PlayerState {
    pub fn new() -> Self {
        Self {
            sink: Arc::new(Mutex::new(None)),
            stream: Arc::new(Mutex::new(None)),
        }
    }
}

#[tauri::command]
pub fn native_play(path: String, state: State<PlayerState>) -> Result<(), String> {
    let mut sink_lock = state.sink.lock().unwrap();
    let mut stream_lock = state.stream.lock().unwrap();

    // Stop and clear current playback
    if let Some(sink) = sink_lock.take() {
        sink.stop();
    }

    // Initialize output stream if needed
    // Note: We create a new one to ensure fresh state, but could also reuse
    let (stream, stream_handle) =
        OutputStream::try_default().map_err(|e| format!("Failed to get output stream: {}", e))?;
    let sink =
        Sink::try_new(&stream_handle).map_err(|e| format!("Failed to create sink: {}", e))?;

    // Load and decode file
    let file = File::open(&path).map_err(|e| format!("Failed to open file {}: {}", path, e))?;
    let source =
        Decoder::new(BufReader::new(file)).map_err(|e| format!("Failed to decode file: {}", e))?;

    sink.append(source);
    sink.play();

    *sink_lock = Some(sink);
    *stream_lock = Some(stream);

    Ok(())
}

#[tauri::command]
pub fn native_pause(state: State<PlayerState>) {
    if let Some(sink) = state.sink.lock().unwrap().as_ref() {
        sink.pause();
    }
}

#[tauri::command]
pub fn native_resume(state: State<PlayerState>) {
    if let Some(sink) = state.sink.lock().unwrap().as_ref() {
        sink.play();
    }
}

#[tauri::command]
pub fn native_stop(state: State<PlayerState>) {
    let mut sink_lock = state.sink.lock().unwrap();
    if let Some(sink) = sink_lock.take() {
        sink.stop();
    }
    *state.stream.lock().unwrap() = None;
}

#[tauri::command]
pub fn native_set_volume(volume: f32, state: State<PlayerState>) {
    if let Some(sink) = state.sink.lock().unwrap().as_ref() {
        sink.set_volume(volume);
    }
}

#[tauri::command]
pub fn native_seek(seconds: f32, state: State<PlayerState>) -> Result<(), String> {
    if let Some(sink) = state.sink.lock().unwrap().as_ref() {
        sink.try_seek(std::time::Duration::from_secs_f32(seconds))
            .map_err(|e| format!("Seek failed: {}", e))?;
        Ok(())
    } else {
        Err("No active playback".into())
    }
}

#[derive(Serialize)]
pub struct PlaybackPosition {
    pub position: f32,
    pub is_playing: bool,
    pub is_finished: bool,
}

#[tauri::command]
pub fn native_get_position(state: State<PlayerState>) -> PlaybackPosition {
    let sink_lock = state.sink.lock().unwrap();
    if let Some(sink) = sink_lock.as_ref() {
        PlaybackPosition {
            position: sink.get_pos().as_secs_f32(),
            is_playing: !sink.is_paused(),
            is_finished: sink.empty(),
        }
    } else {
        PlaybackPosition {
            position: 0.0,
            is_playing: false,
            is_finished: true,
        }
    }
}

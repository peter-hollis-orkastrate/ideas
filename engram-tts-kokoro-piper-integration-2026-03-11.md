# Engram — TTS Integration (Kokoro / Piper)

**Date:** 2026-03-11

---

## Summary

Engram has no text-to-speech capability today. Adding TTS enables audio digests, search result readback, voice chat responses, and accessibility — all use cases that arise naturally from the existing data pipeline. This document specifies an integration using **Kokoro** as the default English-first engine, with **Piper** as the alternative for multilingual breadth.

Both engines are ONNX-based, integrate through the `ort` crate already present in the workspace, run in real-time on CPU, and ship models small enough to bundle in the WiX installer. The integration lives in a new crate, `engram-tts`, behind a feature flag. Nothing else in the pipeline changes.

Kokoro is recommended as the default. Its quantised ONNX model (`model_quantized.onnx`, 92 MB) fits alongside Moonshine (57 MB) and the existing embedding model within installer budget. Its 50 voices across 9 languages cover Engram's current English-first use case with room to expand. CPU synthesis of a 20-word utterance takes under 200 ms on a mid-range laptop.

---

## Use Cases

**1. Audio Digests.** `engram-insight` already produces a daily digest as a `String`. TTS reads it aloud through the default output device — a morning briefing without requiring the user to look at a screen.

**2. Search Result Readback.** A voice query via `engram-dictation` triggers a search via `engram-api`. TTS closes the voice-in/voice-out loop by reading the top result back. The user never needs to switch to the dashboard.

**3. Confirmation Prompts.** The action engine (`engram-action`) already has safety-gated confirmation flows for destructive operations. Reading the prompt aloud — "Delete 4 screenshots from 2 weeks ago. Say yes to confirm." — before waiting for a hotkey acknowledgement reinforces the safety model.

**4. Accessibility.** The web dashboard at `localhost:3030` has no audio output path. A new API endpoint (`POST /api/speak`) lets the dashboard request synthesis of any text. Screen-reader-like interaction becomes possible without an external screen reader.

---

## Engine Comparison

| | **Kokoro (quantised)** | **Piper (medium)** |
|---|---|---|
| Architecture | StyleTTS 2 + ISTFTNet | VITS |
| Model size | 92 MB (int8 ONNX) + 2 MB voices | 63–130 MB per voice |
| Output sample rate | 24,000 Hz | 16,000–22,050 Hz (voice-dependent) |
| CPU real-time factor | ~0.1–0.15× (fast) | ~0.05× (very fast) |
| ONNX via `ort` | Yes | Yes |
| Phonemiser | espeak-ng (via `kokoroxide`) | espeak-ng |
| English quality | Near-commercial | Good |
| Languages | 9 (50 voices, v1.0) | 40+ (70+ voices) |
| New native DLL | `libespeak-ng.dll` | `libespeak-ng.dll` |
| Licence | Apache 2.0 (model), MIT (`kokoroxide`) | MIT (voices); upstream moving to GPL |
| Voices bundled | 2 (af_heart, bm_lewis) ~2 MB | 1 per install |
| HuggingFace | `onnx-community/Kokoro-82M-v1.0-ONNX` | `rhasspy/piper-voices` |

**Recommendation:** Kokoro as default. Piper as an optional alternative for users who need multilingual support beyond Kokoro's 9-language set, subject to the GPL note below.

**Piper licence note:** Development of Piper has moved to `OHF-Voice/piper1-gpl` under GPL. The original `rhasspy/piper` (MIT) and all existing voice files remain MIT-licensed. The `piper-rs` crate binds the original MIT codebase. Engram should pin to a specific release of `piper-rs` and the original rhasspy voice files rather than the new GPL branch.

---

## Kokoro ONNX Interface

The ONNX model takes three inputs and produces one output:

| Tensor | dtype | Shape | Description |
|---|---|---|---|
| `tokens` | int64 | `[1, seq_len]` | Phoneme token IDs, padded with `0` at both ends. Max 510 tokens (512 with padding). |
| `style` | float32 | `[1, 256]` | Style (voice) embedding vector. Sliced from the voice bank by token count. |
| `speed` | float32 | `[1]` | Synthesis speed multiplier. 1.0 = normal, 0.5–2.0 practical range. |
| **`waveform`** (output) | float32 | `[1, num_samples]` | Raw PCM audio at 24 kHz. |

**Voice bank (`voices-v1.0.bin`):** A NumPy NPZ archive containing one array per named voice. Each array has shape `511 × 1 × 256` (float32). To obtain the style vector for a given input, index by the number of tokens after phonemisation:

```
style = voice_bank["af_heart"][token_count]  // shape [1, 256]
```

Two voices cover the default installer bundle:

- `af_heart` — American English female (highest-quality English voice)
- `bm_lewis` — British English male

Voice blending is possible by averaging two style arrays element-wise before passing to the model.

---

## Piper ONNX Interface

Each Piper voice consists of two files: `{voice}.onnx` and `{voice}.onnx.json`. The JSON config carries the phoneme-to-ID map, sample rate, and synthesis hyperparameters. The ONNX model takes:

| Tensor | dtype | Shape | Description |
|---|---|---|---|
| `input` | int64 | `[1, phoneme_seq_len]` | espeak-ng phoneme IDs, remapped via the JSON phoneme map. |
| `input_lengths` | int64 | `[1]` | Length of the phoneme sequence. |
| `scales` | float32 | `[3]` | `[noise_scale, length_scale, noise_w]`. Defaults from JSON: `[0.667, 1.0, 0.8]`. |

Output: `output` float32 waveform at the sample rate specified in the JSON config (typically 22,050 Hz for medium-quality voices).

---

## What Changes, What Doesn't

**New:**
- `engram-tts` — new crate containing the `SynthesisService` trait, `KokoroService` struct, and the `cpal` playback stream
- `engram-core` — one new config field (`tts_backend: TtsBackend`), one `TtsConfig` struct, one `TtsBackend` enum

**Modified:**
- `engram-insight` — optional call to `SynthesisService::synthesise()` at digest generation time, gated by `config.tts_enabled`
- `engram-api` — new endpoint `POST /api/speak` that accepts `{ "text": "...", "voice": "af_heart" }` and returns streaming audio bytes
- `engram-app` — feature flag wiring, `KokoroService` instantiation

**Unchanged:**
- `engram-audio` — audio capture, ring buffer, VAD — no changes
- `engram-whisper` — all transcription paths — no changes
- `engram-dictation` — state machine, hotkey, `TextInjector` — no changes
- `engram-storage`, `engram-vector`, `engram-insight` (logic), `engram-action`, `engram-chat`, `engram-ocr`, `engram-capture` — no changes

---

## Architecture

```
[engram-insight]          [engram-chat]         [engram-api]
  DigestText               ChatResponse           POST /api/speak
       │                        │                     │
       └──────────────┬─────────┘                     │
                      ▼                               │
              [engram-tts]                            │
         SynthesisService trait                       │
         KokoroService / PiperService                 │
               │                                      │
    ONNX inference (ort)                              │
    espeak-ng phonemisation                           │
               │                                      │
    Vec<f32> PCM at 24 kHz                            │
               │                                      │
               ▼                                      │
        [cpal output]           ◄────────────────────┘
     default audio device          (SSE stream of
      (WASAPI on Windows)           raw PCM bytes)
```

`engram-audio` and `engram-tts` both use `cpal` but on separate streams. `engram-audio` opens a WASAPI input stream; `engram-tts` opens a WASAPI output stream. Windows handles these independently.

---

## Implementation Plan

### Step 1 — Add config in `engram-core`

```rust
// engram-core/src/config.rs

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub enum TtsBackend {
    #[default]
    Kokoro,
    Piper,
    Disabled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TtsConfig {
    pub backend: TtsBackend,
    pub model_dir: String,        // path to directory containing model files
    pub voice: String,            // default voice name, e.g. "af_heart"
    pub speed: f32,               // synthesis speed, default 1.0
    pub enabled: bool,            // master switch; false = TtsBackend::Disabled
}

impl Default for TtsConfig {
    fn default() -> Self {
        Self {
            backend: TtsBackend::Kokoro,
            model_dir: default_model_dir(),   // %APPDATA%\Engram\models\kokoro
            voice: "af_heart".to_string(),
            speed: 1.0,
            enabled: false,   // opt-in; user enables in engram.toml
        }
    }
}

// Add to EngramConfig:
pub tts: TtsConfig,
```

### Step 2 — Create `engram-tts` crate

```toml
# engram-tts/Cargo.toml

[package]
name    = "engram-tts"
version = "0.1.0"
edition = "2021"

[features]
default  = []
kokoro   = ["dep:kokoroxide"]
piper    = ["dep:ort", "dep:ndarray", "dep:serde_json"]

[dependencies]
engram-core  = { path = "../engram-core" }
tokio        = { workspace = true }
tracing      = { workspace = true }
thiserror    = { workspace = true }
cpal         = { workspace = true }

kokoroxide   = { version = "0.1", optional = true }

ort          = { version = "2.0.0-rc.11", features = ["std", "ndarray", "load-dynamic"], optional = true }
ndarray      = { version = "0.17", optional = true }
serde_json   = { workspace = true, optional = true }
```

`cpal` is already in the workspace (used by `engram-audio` for capture). `kokoroxide` brings `ort`, espeak-ng, and the phonemisation logic as its own dependencies under the `kokoro` feature.

### Step 3 — Define the `SynthesisService` trait

```rust
// engram-tts/src/lib.rs

pub trait SynthesisService: Send + Sync {
    fn synthesise(
        &self,
        text: &str,
        voice: &str,
        speed: f32,
    ) -> impl Future<Output = Result<SynthesisResult, EngramError>> + Send;
}

pub struct SynthesisResult {
    pub pcm: Vec<f32>,
    pub sample_rate: u32,
}
```

### Step 4 — Implement `KokoroService`

`kokoroxide` wraps the ONNX session and espeak-ng phonemisation. `KokoroService` loads both at startup and delegates synthesis:

```rust
// engram-tts/src/kokoro_service.rs

#[cfg(feature = "kokoro")]
pub mod kokoro_impl {
    use kokoroxide::{KokoroTTS, TTSConfig, VoiceStyle};
    use crate::{SynthesisResult, SynthesisService};
    use engram_core::{error::EngramError, config::TtsConfig};

    pub struct KokoroService {
        tts: KokoroTTS,
    }

    impl KokoroService {
        pub fn new(config: &TtsConfig) -> Result<Self, EngramError> {
            let tts_config = TTSConfig::builder()
                .model_path(format!("{}/model_quantized.onnx", config.model_dir))
                .voices_path(format!("{}/voices-v1.0.bin", config.model_dir))
                .optimization_level(ort::GraphOptimizationLevel::Level3)
                .build()
                .map_err(|e| EngramError::Config(e.to_string()))?;

            let tts = KokoroTTS::new(tts_config)
                .map_err(|e| EngramError::Processing(e.to_string()))?;

            Ok(Self { tts })
        }
    }

    impl SynthesisService for KokoroService {
        async fn synthesise(
            &self,
            text: &str,
            voice: &str,
            speed: f32,
        ) -> Result<SynthesisResult, EngramError> {
            let audio = self.tts
                .generate_speech(text, voice, speed)
                .map_err(|e| EngramError::Processing(e.to_string()))?;

            Ok(SynthesisResult {
                pcm: audio.samples,
                sample_rate: 24_000,
            })
        }
    }
}
```

### Step 5 — Implement `PiperService` (optional, behind `piper` feature)

Piper is invoked directly through `ort` using the ONNX model and the JSON config for the selected voice:

```rust
// engram-tts/src/piper_service.rs

#[cfg(feature = "piper")]
pub mod piper_impl {
    use ort::{Session, Value};
    use ndarray::{Array1, Array2, Array3, CowArray};
    use engram_core::{error::EngramError, config::TtsConfig};
    use crate::{SynthesisResult, SynthesisService};

    pub struct PiperService {
        session: Session,
        phoneme_map: std::collections::HashMap<String, i64>,
        sample_rate: u32,
        noise_scale: f32,
        length_scale: f32,
        noise_w: f32,
    }

    impl PiperService {
        pub fn new(config: &TtsConfig) -> Result<Self, EngramError> {
            let model_path = format!("{}/{}.onnx", config.model_dir, config.voice);
            let config_path = format!("{}/{}.onnx.json", config.model_dir, config.voice);

            let session = Session::builder()?
                .with_optimization_level(ort::GraphOptimizationLevel::Level3)?
                .with_model_from_file(&model_path)?;

            let cfg: serde_json::Value = serde_json::from_str(
                &std::fs::read_to_string(&config_path)?
            )?;

            let phoneme_map = parse_phoneme_map(&cfg)?;
            let sample_rate = cfg["audio"]["sample_rate"].as_u64().unwrap_or(22050) as u32;
            let inference = &cfg["inference"];
            let noise_scale  = inference["noise_scale"].as_f64().unwrap_or(0.667) as f32;
            let length_scale = inference["length_scale"].as_f64().unwrap_or(1.0) as f32;
            let noise_w      = inference["noise_w"].as_f64().unwrap_or(0.8) as f32;

            Ok(Self { session, phoneme_map, sample_rate, noise_scale, length_scale, noise_w })
        }
    }

    impl SynthesisService for PiperService {
        async fn synthesise(
            &self,
            text: &str,
            _voice: &str,    // voice is baked into the session at load time
            speed: f32,
        ) -> Result<SynthesisResult, EngramError> {
            let phoneme_ids = phonemise(text, &self.phoneme_map)?;
            let seq_len = phoneme_ids.len() as i64;

            let input = CowArray::from(
                Array2::from_shape_vec((1, phoneme_ids.len()), phoneme_ids)?
            ).into_dyn();
            let lengths = CowArray::from(Array1::from_vec(vec![seq_len])).into_dyn();
            let scales  = CowArray::from(Array1::from_vec(vec![
                self.noise_scale,
                self.length_scale / speed,   // length_scale controls duration; speed inverts it
                self.noise_w,
            ])).into_dyn();

            let outputs = self.session.run(ort::inputs![
                "input"         => input,
                "input_lengths" => lengths,
                "scales"        => scales,
            ]?)?;

            let waveform = outputs["output"].try_extract_tensor::<f32>()?;
            let pcm: Vec<f32> = waveform.iter().cloned().collect();

            Ok(SynthesisResult {
                pcm,
                sample_rate: self.sample_rate,
            })
        }
    }
}
```

`phonemise()` calls espeak-ng (via `espeakng` crate) to produce IPA for each word, then maps IPA characters to Piper's phoneme ID integers using the map from the JSON config. This is the same espeak-ng DLL already used by `kokoroxide` under the `kokoro` feature.

### Step 6 — Audio playback helper

```rust
// engram-tts/src/player.rs

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use engram_core::error::EngramError;

/// Blocks until all PCM samples have been played through the default output device.
pub fn play_blocking(pcm: &[f32], sample_rate: u32) -> Result<(), EngramError> {
    let host   = cpal::default_host();
    let device = host.default_output_device()
        .ok_or_else(|| EngramError::Config("No audio output device".into()))?;

    let config = cpal::StreamConfig {
        channels: 1,
        sample_rate: cpal::SampleRate(sample_rate),
        buffer_size: cpal::BufferSize::Default,
    };

    let samples: Vec<f32> = pcm.to_vec();
    let mut cursor = 0usize;
    let (done_tx, done_rx) = std::sync::mpsc::channel();

    let stream = device.build_output_stream(
        &config,
        move |buf: &mut [f32], _| {
            let remaining = samples.len().saturating_sub(cursor);
            let to_fill   = buf.len().min(remaining);
            buf[..to_fill].copy_from_slice(&samples[cursor..cursor + to_fill]);
            buf[to_fill..].fill(0.0);
            cursor += to_fill;
            if cursor >= samples.len() {
                let _ = done_tx.send(());
            }
        },
        |e| tracing::error!("cpal output error: {e}"),
        None,
    ).map_err(|e| EngramError::Processing(e.to_string()))?;

    stream.play().map_err(|e| EngramError::Processing(e.to_string()))?;
    let _ = done_rx.recv();
    Ok(())
}
```

`play_blocking` is called from a dedicated Tokio `spawn_blocking` task to avoid stalling the async runtime during playback.

### Step 7 — Wire into `engram-app`

```rust
// engram-app/src/main.rs

let tts_service: Arc<dyn SynthesisService> = match config.tts.backend {
    TtsBackend::Kokoro => {
        #[cfg(feature = "kokoro")]
        { Arc::new(KokoroService::new(&config.tts)?) }
        #[cfg(not(feature = "kokoro"))]
        { return Err(EngramError::Config("kokoro feature not compiled in".into())); }
    }
    TtsBackend::Piper => {
        #[cfg(feature = "piper")]
        { Arc::new(PiperService::new(&config.tts)?) }
        #[cfg(not(feature = "piper"))]
        { return Err(EngramError::Config("piper feature not compiled in".into())); }
    }
    TtsBackend::Disabled => Arc::new(NoopSynthesisService),
};
```

`engram-app`'s default Cargo features become `["moonshine", "kokoro"]`.

### Step 8 — Wire digest readback in `engram-insight`

```rust
// engram-insight/src/digest.rs (addition to existing generate_digest fn)

if config.tts.enabled {
    let text = digest.summary_text();
    let tts  = tts_service.clone();
    let cfg  = config.tts.clone();
    tokio::spawn(async move {
        match tts.synthesise(&text, &cfg.voice, cfg.speed).await {
            Ok(audio) => {
                tokio::task::spawn_blocking(move || {
                    if let Err(e) = play_blocking(&audio.pcm, audio.sample_rate) {
                        tracing::warn!("TTS playback failed: {e}");
                    }
                });
            }
            Err(e) => tracing::warn!("TTS synthesis failed: {e}"),
        }
    });
}
```

### Step 9 — Add `POST /api/speak` endpoint in `engram-api`

```rust
// engram-api/src/routes/speak.rs

#[derive(Deserialize)]
struct SpeakRequest {
    text: String,
    voice: Option<String>,
    speed: Option<f32>,
}

async fn speak(
    State(state): State<AppState>,
    Json(req): Json<SpeakRequest>,
) -> Result<impl IntoResponse, AppError> {
    let voice = req.voice.as_deref().unwrap_or(&state.config.tts.voice);
    let speed  = req.speed.unwrap_or(state.config.tts.speed);

    let audio = state.tts
        .synthesise(&req.text, voice, speed)
        .await?;

    // Return raw PCM as application/octet-stream with sample-rate header.
    // The dashboard JS plays it via AudioContext.decodeAudioData or a raw PCM player.
    Ok((
        [
            ("Content-Type",        "audio/raw"),
            ("X-Sample-Rate",       &audio.sample_rate.to_string()),
            ("X-Channels",          "1"),
            ("X-Bits-Per-Sample",   "32"),
        ],
        audio.pcm.iter()
            .flat_map(|s| s.to_le_bytes())
            .collect::<Vec<u8>>(),
    ))
}
```

---

## Model Files and Directory Layout

```
%APPDATA%\Engram\models\kokoro\
    model_quantized.onnx     (92 MB — int8 ONNX, bundled in installer)
    voices-v1.0.bin          ( 2 MB — NPZ voice bank, bundled in installer)

%APPDATA%\Engram\models\piper\    (optional, Piper backend only)
    en_US-lessac-medium.onnx      (63 MB — per-voice model)
    en_US-lessac-medium.onnx.json ( <1 MB — phoneme map and config)
```

**espeak-ng DLL** (`libespeak-ng.dll` and its data directory `espeak-ng-data/`) ships in the installer's application directory alongside `onnxruntime.dll`. Both `kokoroxide` (Kokoro) and direct espeak-ng calls (Piper) load the same DLL.

**Installer size budget:**

| Artifact | Size |
|---|---|
| `onnxruntime.dll` | ~17 MB (already present for VAD + Moonshine) |
| Moonshine base (encoder + decoder) | ~57 MB (Moonshine milestone) |
| Existing embedding model | ~22 MB (already present) |
| Kokoro `model_quantized.onnx` | 92 MB |
| `voices-v1.0.bin` | 2 MB |
| `libespeak-ng.dll` + data | ~8 MB |
| **Total new additions** | **102 MB** |

Total installer growth from the TTS milestone is ~102 MB, bringing the cumulative ML-artifacts total to ~198 MB. This is large but not unusual for a local-AI desktop application. Splitting the Kokoro model into a first-run download (keeping the installer at ~100 MB total) is a viable alternative if installer size is a hard constraint.

---

## HuggingFace Source

The quantised ONNX model and voice bank are published at:

```
onnx-community/Kokoro-82M-v1.0-ONNX
  model_quantized.onnx
  voices-v1.0.bin
```

Both files are Apache 2.0 licensed. The `kokoroxide` crate is MIT licensed. No API key, no login, no first-run network call (if bundled in installer).

---

## Streaming Synthesis (Sentence-by-Sentence)

For short utterances (confirmation prompts, digest headlines, search result snippets) the single-shot synthesis path above is sufficient. For longer text (full digest paragraphs, multi-paragraph search results) a streaming approach reduces first-audio latency:

1. Split the text into sentences at punctuation boundaries using a lightweight sentence splitter.
2. Synthesise each sentence as an independent ONNX call.
3. Begin playback of sentence N while sentence N+1 is being synthesised.

The implementation uses a `tokio::mpsc` channel between a synthesis task and a playback task:

```rust
let (tx, mut rx) = tokio::sync::mpsc::channel::<SynthesisResult>(2);   // prefetch 2

// Synthesis task
tokio::spawn(async move {
    for sentence in split_sentences(text) {
        let audio = tts.synthesise(&sentence, voice, speed).await?;
        tx.send(audio).await?;
    }
    Ok::<_, EngramError>(())
});

// Playback task
tokio::task::spawn_blocking(move || {
    while let Some(audio) = rx.blocking_recv() {
        play_blocking(&audio.pcm, audio.sample_rate)?;
    }
    Ok::<_, EngramError>(())
});
```

This is a follow-up scope item. Single-shot synthesis ships first.

---

## Relationship to Moonshine Integration

The Moonshine STT and Kokoro TTS integrations are fully independent. They share:

- The `ort` crate (same workspace-pinned version, same `onnxruntime.dll`)
- The `espeak-ng` DLL (Moonshine uses it for phoneme IDs via `kokoroxide`; both TTS backends use it for phonemisation)
- The same feature-flag pattern and trait-based abstraction

Sequencing: Moonshine ships first (higher user-facing impact, fully specified). Kokoro TTS ships in the following milestone. The two integrations do not share code and can be developed in parallel.

---

## Testing

**Unit tests** — `SynthesisService` has a `MockSynthesisService` returning a fixed 0.5-second silence buffer. All consumers (`engram-insight`, `engram-api`) use the mock in unit tests. No model files required.

**Integration tests** (gated behind `#[cfg(feature = "integration-tests")]`):

1. **Model load test** — load `KokoroService` from a test model directory, assert `Ok`.
2. **Round-trip test** — synthesise a 10-word sentence, assert `pcm.len() > 0` and `sample_rate == 24000`.
3. **Known-voice test** — synthesise "Hello, world." with `af_heart` at speed 1.0, assert duration is within ±10% of expected (0.8 s).
4. **Playback test** — explicitly skipped in CI (requires audio device), documented as a local-only test.

---

## Risks and Open Questions

**espeak-ng DLL.** `kokoroxide` links espeak-ng dynamically on Windows. The pre-built DLL and data files must be distributed in the installer. If `kokoroxide`'s espeak-ng version diverges from what Piper's direct integration needs, two separate DLL copies could be needed — resolve by aligning at the `kokoroxide` version used for both backends or by wrapping espeak-ng calls in a shared `engram-phoneme` internal crate.

**`kokoroxide` maturity.** This is a community crate, not an official Hume AI or Kokoro project release. Pin to a specific version and commit SHA. If the crate becomes unmaintained, the fallback is to write a thin `ort`-based `KokoroService` directly (the ONNX interface is simple and stable).

**Audio device conflicts.** `engram-audio` holds a WASAPI input stream; `engram-tts` opens a WASAPI output stream. Windows handles these independently. However, if the system uses a single USB audio device that is opened exclusively, conflicts could occur. Test on single-device configurations. Default to shared-mode WASAPI for the output stream (which `cpal` does).

**`voices-v1.0.bin` NPZ format.** The file uses the NumPy NPZ format despite the `.bin` extension. The `kokoroxide` crate handles loading internally. If the voice bank format changes in a future Kokoro release, `kokoroxide` updates would be needed. Pin HuggingFace downloads to a specific commit SHA.

**Digest readback timing.** The audio digest is generated at a scheduled time (e.g. 08:00). If the user's system is in a meeting or playing music at that time, Engram speaking aloud would be disruptive. A `tts_quiet_hours` config field (similar to notification quiet hours on mobile OSes) should be added alongside `tts.enabled`.

**Text sanitisation.** The digest and chat response text may contain markdown formatting, code blocks, URLs, and special characters. These should be stripped before passing to the TTS engine. A `strip_for_tts(text: &str) -> String` utility in `engram-tts` handles this, replacing markdown symbols, expanding common abbreviations (e.g. "vs." → "versus"), and normalising numbers.

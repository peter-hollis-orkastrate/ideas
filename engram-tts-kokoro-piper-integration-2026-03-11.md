# Engram — TTS Integration (Kokoro / Piper)

**Date:** 2026-03-11

---

## Summary

Engram has no text-to-speech capability today. Adding TTS enables audio digests, search result readback, voice chat responses, and accessibility — all use cases that arise naturally from the existing data pipeline. This document specifies an integration using **Kokoro** as the default English-first engine, with **Piper** as the alternative for multilingual breadth.

Both engines are ONNX-based, integrate through the `ort` crate already present in the workspace, run in real-time on CPU, and ship models small enough to bundle in the WiX installer. The integration lives in a new crate, `engram-tts`, behind a feature flag. Nothing else in the pipeline changes.

Kokoro is recommended as the default. Its mixed-precision quantised ONNX model (`model_q8f16.onnx`, 86 MB) fits alongside Moonshine (57 MB) and the existing embedding model within installer budget. Its 50 voices across 9 languages cover Engram's current English-first use case with room to expand. CPU synthesis of a 20-word utterance takes under 200 ms on a mid-range laptop.

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
| Model size | 86 MB (q8f16 ONNX) + 2 MB voices | 63–130 MB per voice |
| Output sample rate | 24,000 Hz | 16,000–22,050 Hz (voice-dependent) |
| CPU real-time factor | ~0.1–0.15× (fast) | ~0.05× (very fast) |
| ONNX via `ort` | Yes | Yes |
| Phonemiser | espeak-ng (via `kokoro-tts` crate) | espeak-ng (bundled data, no DLL) |
| English quality | Near-commercial | Good |
| Languages | 9 (50 voices, v1.0); EN via `kokoro-tts`, others need custom G2P | 40+ (70+ voices) |
| New native DLL | `libespeak-ng.dll` (for `kokoro-tts` phonemisation) | None (`piper-rs` bundles espeak data) |
| Licence | Apache 2.0 (model), MIT (`kokoro-tts`) | MIT (voices + `piper-rs`); new upstream GPL |
| Voices bundled | 2 (af_heart, bm_lewis) ~2 MB | 1 per install |
| HuggingFace | `onnx-community/Kokoro-82M-v1.0-ONNX` | `rhasspy/piper-voices` |

**Recommendation:** Kokoro as default. Piper as an optional alternative for users who need multilingual support beyond Kokoro's 9-language set, subject to the GPL note below.

**Piper licence note:** `rhasspy/piper` was archived (read-only) in October 2025; development moved to `OHF-Voice/piper1-gpl` under GPL. All existing voice files on `rhasspy/piper-voices` remain MIT-licensed. The community `thewh1teagle/piper-rs` crate (pure Rust, MIT) targets the original archived codebase — pin to a specific release and the original voice files. Do not take a dependency on `piper1-gpl` or `piper1-rs`.

---

## Kokoro ONNX Interface

The ONNX model takes three inputs and produces one output:

| Tensor | dtype | Shape | Description |
|---|---|---|---|
| `input_ids` | int64 | `[1, seq_len]` | Phoneme token IDs, padded with `0` at both ends: `[[0, *tokens, 0]]`. Max 512 total (510 usable tokens). |
| `style` | float32 | `[1, 1, 256]` | Style (voice) embedding. Loaded from the voice `.bin` file and indexed by `len(tokens) - 1`. |
| `speed` | float32 | `[1]` | Synthesis speed multiplier. `[1.0]` = normal, 0.5–2.0 practical range. |
| **`audio`** (output) | float32 | `[1, num_samples]` | Raw PCM audio at 24 kHz. |

**Voice files:** The `onnx-community/Kokoro-82M-v1.0-ONNX` repo distributes individual per-voice `.bin` files in a `voices/` directory (`af_heart.bin`, `bm_lewis.bin`, etc.), each ~522 kB. Each `.bin` is a raw float32 array of shape `N × 1 × 256` loaded as:

```rust
let bytes = std::fs::read("voices/af_heart.bin")?;
let floats: Vec<f32> = bytes.chunks_exact(4)
    .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
    .collect();
// shape: (floats.len() / 256, 1, 256)
// index by token count (= len(tokens) - 1) to get the [1, 1, 256] style tensor
```

Two voices cover the default installer bundle — ~1 MB combined:

- `af_heart.bin` — American English female (highest-quality English voice)
- `bm_lewis.bin` — British English male

Voice blending is possible by averaging two loaded float32 arrays element-wise before slicing.

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
kokoro   = ["dep:ort", "dep:ndarray", "dep:espeakng"]
piper    = ["dep:piper-rs"]

[dependencies]
engram-core  = { path = "../engram-core" }
tokio        = { workspace = true }
tracing      = { workspace = true }
thiserror    = { workspace = true }
cpal         = { workspace = true }

# Kokoro: direct ort inference — uses workspace-pinned ort, no third-party TTS crate.
# espeakng provides espeak-ng → IPA phonemisation for the Kokoro phoneme vocabulary.
ort      = { version = "2.0.0-rc.11", features = ["std", "ndarray", "load-dynamic"], optional = true }
ndarray  = { version = "0.17", optional = true }
espeakng = { version = "0.4", optional = true }

# Piper: pure-Rust ONNX synthesis via piper-rs, which bundles espeak-ng data.
piper-rs = { version = "1.1", optional = true }
```

`cpal` is already in the workspace (used by `engram-audio` for capture).

**Why direct `ort` for Kokoro, not a TTS crate?** Community Kokoro crates (`kokoroxide`, `kokoro-tts`) each pin their own `ort` version that may conflict with the workspace's `ort = "2.0.0-rc.11"`. `kokoroxide` pins `ort = "1.16"` — a major version behind. Implementing `KokoroService` directly against the workspace `ort` eliminates this conflict and keeps the dependency tree flat. The Kokoro ONNX interface is simple (three inputs, one output) and fully documented above.

`piper-rs` pins `ort = "2.0.0-rc.9"` — close to the workspace version and likely compatible without change, but this should be verified when the milestone is implemented.

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

`KokoroService` calls the ONNX session directly via the workspace `ort` crate, using `espeakng` for phonemisation. The voice style tensors are loaded at startup from individual `.bin` files in the `voices/` subdirectory:

```rust
// engram-tts/src/kokoro_service.rs

#[cfg(feature = "kokoro")]
pub mod kokoro_impl {
    use ort::{Session, Value};
    use ndarray::{Array1, Array3, CowArray};
    use espeakng::EspeakNg;
    use std::collections::HashMap;
    use engram_core::{error::EngramError, config::TtsConfig};
    use crate::{SynthesisResult, SynthesisService};

    // IPA character → Kokoro phoneme token ID map (abridged; full map in source)
    fn build_phoneme_map() -> HashMap<char, i64> { /* ... */ }

    pub struct KokoroService {
        session:     Session,
        // voice name → raw float32 tensor bytes, shape (N, 1, 256)
        voice_store: HashMap<String, Vec<f32>>,
        phoneme_map: HashMap<char, i64>,
    }

    impl KokoroService {
        pub fn new(config: &TtsConfig) -> Result<Self, EngramError> {
            // model_q8f16.onnx: 86 MB, int8 weights + fp16 activations
            let session = Session::builder()?
                .with_optimization_level(ort::GraphOptimizationLevel::Level3)?
                .with_model_from_file(
                    format!("{}/model_q8f16.onnx", config.model_dir)
                )?;

            // Load bundled voices (each .bin is a flat f32 array, shape N×1×256)
            let mut voice_store = HashMap::new();
            for name in &["af_heart", "bm_lewis"] {
                let path = format!("{}/voices/{}.bin", config.model_dir, name);
                let bytes = std::fs::read(&path)
                    .map_err(|e| EngramError::Config(format!("{path}: {e}")))?;
                let floats: Vec<f32> = bytes.chunks_exact(4)
                    .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
                    .collect();
                voice_store.insert(name.to_string(), floats);
            }

            Ok(Self { session, voice_store, phoneme_map: build_phoneme_map() })
        }

        fn phonemise(&self, text: &str) -> Result<Vec<i64>, EngramError> {
            // espeak-ng → IPA → Kokoro token IDs
            let ipa = EspeakNg::phonemise(text, "en")
                .map_err(|e| EngramError::Processing(e.to_string()))?;
            let mut ids: Vec<i64> = ipa.chars()
                .filter_map(|c| self.phoneme_map.get(&c).copied())
                .collect();
            // Pad with 0 at both ends (required by the model)
            ids.insert(0, 0);
            ids.push(0);
            Ok(ids)
        }

        fn get_style(&self, voice: &str, token_count: usize) -> Result<Array3<f32>, EngramError> {
            let floats = self.voice_store.get(voice)
                .ok_or_else(|| EngramError::Config(format!("unknown voice: {voice}")))?;
            // floats is laid out as (N, 1, 256); pick row = token_count - 1
            let row = (token_count - 1).min(floats.len() / 256 - 1);
            let start = row * 256;
            let slice = &floats[start..start + 256];
            Ok(Array3::from_shape_vec((1, 1, 256), slice.to_vec())?)
        }
    }

    impl SynthesisService for KokoroService {
        async fn synthesise(
            &self,
            text: &str,
            voice: &str,
            speed: f32,
        ) -> Result<SynthesisResult, EngramError> {
            // Run on a blocking thread — ort inference is synchronous
            let text = text.to_owned();
            let voice = voice.to_owned();
            let service = /* Arc<Self> */;

            tokio::task::spawn_blocking(move || {
                let token_ids = service.phonemise(&text)?;
                let n = token_ids.len();

                let input_ids = CowArray::from(
                    ndarray::Array2::from_shape_vec((1, n), token_ids)?
                ).into_dyn();

                let style = CowArray::from(service.get_style(&voice, n)?)
                    .into_dyn();

                let speed_t = CowArray::from(
                    Array1::from_vec(vec![speed])
                ).into_dyn();

                let outputs = service.session.run(ort::inputs![
                    "input_ids" => input_ids,
                    "style"     => style,
                    "speed"     => speed_t,
                ]?)?;

                let audio = outputs["audio"].try_extract_tensor::<f32>()?;
                let pcm: Vec<f32> = audio.iter().cloned().collect();

                Ok::<_, EngramError>(SynthesisResult { pcm, sample_rate: 24_000 })
            })
            .await
            .map_err(|e| EngramError::Processing(e.to_string()))?
        }
    }
}
```

The `phonemise` helper calls `espeakng` to get IPA for the input text, then maps each IPA character to a Kokoro token ID using the fixed phoneme vocabulary. The token padding (`[0, *tokens, 0]`) is required by the model — the style vector is then indexed at `len(tokens) - 1` (i.e. before padding) to match the token count the model sees.

### Step 5 — Implement `PiperService` (optional, behind `piper` feature)

`piper-rs` (thewh1teagle) is a pure-Rust implementation that handles phonemisation and ONNX inference internally. It requires no native DLL — espeak-ng's data directory is bundled with the crate or located via an environment variable. Voice is baked into the model at load time (one ONNX file per voice):

```rust
// engram-tts/src/piper_service.rs

#[cfg(feature = "piper")]
pub mod piper_impl {
    use piper_rs::PiperModel;
    use std::sync::Arc;
    use std::path::Path;
    use engram_core::{error::EngramError, config::TtsConfig};
    use crate::{SynthesisResult, SynthesisService};

    pub struct PiperService {
        model: Arc<dyn PiperModel + Send + Sync>,
        sample_rate: u32,
    }

    impl PiperService {
        pub fn new(config: &TtsConfig) -> Result<Self, EngramError> {
            // config.voice is the filename stem, e.g. "en_US-lessac-medium"
            let config_path = format!("{}/{}.onnx.json", config.model_dir, config.voice);

            // piper-rs discovers espeak-ng-data/ via:
            //   $PIPER_ESPEAKNG_DATA_DIRECTORY → ./espeak-ng-data/ → <exe-dir>/espeak-ng-data/
            // Engram ships espeak-ng-data/ in the application directory alongside the exe.
            let model = piper_rs::from_config_path(Path::new(&config_path))
                .map_err(|e| EngramError::Config(e.to_string()))?;

            let sample_rate = model.config().audio.sample_rate as u32;

            Ok(Self { model, sample_rate })
        }
    }

    impl SynthesisService for PiperService {
        async fn synthesise(
            &self,
            text: &str,
            _voice: &str,    // voice is baked into the session at load time
            speed: f32,
        ) -> Result<SynthesisResult, EngramError> {
            let phonemes = self.model
                .phonemize_text(text)
                .map_err(|e| EngramError::Processing(e.to_string()))?;

            // `speak_one_sentence` accepts the phoneme String returned by phonemize_text.
            // `PiperSynthesisConfig.length_scale` controls duration — speed inverts it.
            let mut opts = piper_rs::PiperSynthesisConfig::default();
            opts.length_scale = 1.0 / speed;

            let audio = self.model
                .speak_one_sentence(phonemes, &opts)
                .map_err(|e| EngramError::Processing(e.to_string()))?;

            Ok(SynthesisResult {
                pcm: audio.audio_samples,      // Vec<f32>
                sample_rate: self.sample_rate,
            })
        }
    }
}
```

`piper-rs` handles espeak-ng phonemisation internally via its bundled `espeak-rs` crate. No `libespeak-ng.dll` is needed at runtime — unlike the `espeakng` crate used by the Kokoro backend. The `espeak-ng-data/` directory (phoneme tables) must be present at the path resolved by `$PIPER_ESPEAKNG_DATA_DIRECTORY` or `<exe-dir>/espeak-ng-data/`; Engram ships this directory in the installer.

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
    model_q8f16.onnx         (86 MB — int8 weights + fp16 activations, bundled in installer)
    voices\
        af_heart.bin         (522 kB — American English female)
        bm_lewis.bin         (522 kB — British English male)

%APPDATA%\Engram\models\piper\    (optional, Piper backend only)
    en_US-lessac-medium.onnx      (63 MB — per-voice model)
    en_US-lessac-medium.onnx.json ( <1 MB — phoneme map and config)
```

**espeak-ng** is required by both engines but in different forms:

- **Kokoro (`kokoro-tts` feature):** requires `libespeak-ng.dll` at runtime for its phonemisation pass. The DLL ships in the installer's application directory alongside `onnxruntime.dll`.
- **Piper (`piper-rs` feature):** requires only the `espeak-ng-data/` directory (phoneme data files). No DLL needed — `piper-rs` does not dynamically link espeak-ng. The data directory ships in the installer.

If both features are compiled in, `libespeak-ng.dll` + `espeak-ng-data/` is present anyway (Kokoro needs both). If only Piper is compiled, only the data directory is needed, saving ~1 MB.

**Installer size budget (Kokoro default, both features compiled):**

| Artifact | Size |
|---|---|
| `onnxruntime.dll` | ~17 MB (already present for VAD + Moonshine) |
| Moonshine base (encoder + decoder) | ~57 MB (Moonshine milestone) |
| Existing embedding model | ~22 MB (already present) |
| Kokoro `model_q8f16.onnx` | 86 MB |
| `voices/af_heart.bin` + `voices/bm_lewis.bin` | 1 MB |
| `libespeak-ng.dll` + `espeak-ng-data/` | ~9 MB |
| **Total new additions** | **97 MB** |

Total installer growth from the TTS milestone is ~97 MB, bringing the cumulative ML-artifacts total to ~186 MB. Splitting the Kokoro model into a first-run download (keeping the installer at ~100 MB total) is a viable alternative if installer size is a hard constraint.

---

## HuggingFace Source

The quantised ONNX model and individual voice files are published at:

```
onnx-community/Kokoro-82M-v1.0-ONNX
  onnx/model_q8f16.onnx          (86 MB)
  voices/af_heart.bin            (522 kB)
  voices/bm_lewis.bin            (522 kB)
  ... (34 voices total)
```

All files are Apache 2.0 licensed. No API key, no login, no first-run network call (if bundled in installer).

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

**espeak-ng version alignment.** `kokoro-tts` links `libespeak-ng.dll` dynamically (espeak-ng v1.51 from the official Windows release). `piper-rs` bundles its own espeak-ng data directory but does not load the DLL. There is no version conflict between the two backends because they access espeak-ng through different paths. However, if `kokoro-tts` requires a different DLL version than what is bundled, synthesis will fail at startup with a clear load error — verify the DLL version during integration testing.

**`kokoro-tts` maturity.** This is a community crate, not an official Hume AI or Kokoro project release. Pin to a specific version. If the crate becomes unmaintained, the fallback is to write a thin `ort`-based `KokoroService` directly (the ONNX interface is documented above and stable). `kokoroxide` is an alternative community crate with a similar API but currently covers American English only — viable as a fallback for English-only builds.

**Audio device conflicts.** `engram-audio` holds a WASAPI input stream; `engram-tts` opens a WASAPI output stream. Windows handles these independently. However, if the system uses a single USB audio device that is opened exclusively, conflicts could occur. Test on single-device configurations. Default to shared-mode WASAPI for the output stream (which `cpal` does).

**Voice `.bin` file format.** Each voice file is a raw flat float32 array (little-endian), shape `N × 1 × 256` where N ≈ 510. This is read directly in `KokoroService::new` without any external crate. The style vector for a given synthesis call is sliced at row `len(tokens) - 1`. If the format changes in a future Kokoro release, this is a one-function change. Pin HuggingFace downloads to a specific commit SHA.

**Digest readback timing.** The audio digest is generated at a scheduled time (e.g. 08:00). If the user's system is in a meeting or playing music at that time, Engram speaking aloud would be disruptive. A `tts_quiet_hours` config field (similar to notification quiet hours on mobile OSes) should be added alongside `tts.enabled`.

**Text sanitisation.** The digest and chat response text may contain markdown formatting, code blocks, URLs, and special characters. These should be stripped before passing to the TTS engine. A `strip_for_tts(text: &str) -> String` utility in `engram-tts` handles this, replacing markdown symbols, expanding common abbreviations (e.g. "vs." → "versus"), and normalising numbers.

# Engram — Moonshine STT Integration

**Date:** 2026-02-25

---

## Summary

Moonshine is a drop-in replacement for the Whisper transcription step in Engram. It implements the same `TranscriptionService` trait, uses the `ort` crate already present in the workspace, and delivers 7× faster inference at a fraction of the model size. The integration is self-contained within `engram-whisper`: add a `moonshine` feature flag, add a `MoonshineService` struct that implements `TranscriptionService`, wire it up in `engram-app`. Nothing else in the pipeline changes.

---

## Current State of STT in Engram

`engram-whisper` wraps `whisper-rs` v0.13 (a Rust binding over whisper.cpp) behind a feature flag. The feature is opt-in because it requires cmake and a C++ compiler at build time — a meaningful friction point.

The public interface the crate exposes is a trait:

```rust
pub trait TranscriptionService: Send + Sync {
    fn transcribe(
        &self,
        audio_data: &[f32],
        sample_rate: u32,
    ) -> impl Future<Output = Result<TranscriptionResult, EngramError>> + Send;
}
```

`TranscriptionResult` carries `text: String`, `segments: Vec<Segment>` (each with start/end timestamps and a confidence score), `language: String`, and `duration_secs: f32`.

`WhisperConfig` has two fields: `model_path: String` and `language: String`.

The consumer is `engram-dictation`. Its state machine runs: **Idle → Listening → Processing → Typing → Idle**. During Processing it calls `transcribe()` with a `&[f32]` PCM buffer captured at 16 kHz by `engram-audio`. The resulting text is handed to `TextInjector` during Typing. Nothing in `engram-dictation` knows or cares which engine produced the text.

`engram-audio` already has `ort` 2.0.0-rc.11 as an optional dependency, activated by its `vad` feature (Silero VAD). The crate compiles fine today without the `ort` shared library if `vad` is disabled. This is the same `ort` version Moonshine would use.

---

## Why Moonshine

| | **Whisper large-v3-turbo (quantised)** | **Moonshine base** | **Moonshine tiny** |
|---|---|---|---|
| Model size | ~800 MB | ~57 MB | ~26 MB |
| Relative speed | 1× baseline | ~7× faster than faster-whisper base | Fastest |
| Build requirement | cmake + C++ toolchain | Pure Rust + ort shared lib | Same |
| Streaming support | No | Yes (v2 sliding window) | Yes |
| English accuracy | Strong | Better than Whisper large-v3 at top tier | Good |
| Licence | MIT | MIT | MIT |

The practical impact for Engram's dictation loop:

- **Latency.** Dictation today waits until the utterance is fully captured before transcribing. With Moonshine v2's sliding-window streaming, transcription can begin mid-utterance and the text can appear progressively. This is the difference between "voice note" UX and "live dictation" UX.
- **Footprint.** 57 MB fits comfortably in Engram's installer alongside the existing ONNX embedding model. 800 MB does not.
- **Build simplicity.** No cmake, no C++ compiler. The `ort` shared library is already needed for VAD. Moonshine adds no new native dependencies.
- **Model bundling.** A 57 MB file ships in the installer. A 800 MB file requires a first-run download with progress UI, retry logic, and integrity checks.

---

## What Changes, What Doesn't

**Changes:**
- `engram-whisper` — new `moonshine` feature, new `MoonshineService` struct, `ort` and `tokenizers` added as optional deps under that feature
- `engram-app` — feature flag wiring, `MoonshineService` instantiation, model path from config
- `engram-core` — one new config field (`stt_backend: SttBackend`) and one enum

**Unchanged:**
- `engram-audio` — audio capture, ring buffer, VAD, `AudioChunk` production, all unchanged
- `engram-dictation` — state machine, hotkey, `TextInjector`, all unchanged; it already accepts any `TranscriptionService`
- `engram-vector`, `engram-storage`, `engram-insight`, `engram-chat`, `engram-api` — no changes
- `engram-capture`, `engram-ocr` — no changes

---

## Integration Architecture

```
[engram-audio]
  WASAPI / cpal capture
  Silero VAD (ort, existing)
  AudioChunk { pcm: Vec<f32>, sample_rate: 16000, ... }
         │
         ▼
[engram-dictation]
  Idle → Listening → Processing
                         │
              TranscriptionService::transcribe(&[f32], 16000)
                         │
              ┌──────────┴──────────┐
              │  moonshine feature  │  whisper feature (existing)
              │  MoonshineService   │  WhisperService
              │  (ort + tokenizers) │  (whisper-rs / whisper.cpp)
              └──────────┬──────────┘
                         │
              TranscriptionResult { text, segments, ... }
                         │
                         ▼
              Typing → TextInjector
```

Both backends sit behind the same trait. `engram-app` picks one at startup based on config. Only one backend needs to be compiled in for any given build.

---

## Implementation Plan

### Step 1 — Add config variant in `engram-core`

```rust
// engram-core/src/config.rs

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub enum SttBackend {
    #[default]
    Moonshine,
    Whisper,
}

// Add to EngramConfig:
pub stt_backend: SttBackend,
pub moonshine_model_dir: String,   // path to directory containing model files
pub moonshine_model_size: MoonshineModelSize,

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub enum MoonshineModelSize {
    Tiny,
    #[default]
    Base,
}
```

### Step 2 — Add `moonshine` feature to `engram-whisper/Cargo.toml`

```toml
[features]
default = []
whisper  = ["dep:whisper-rs"]
moonshine = ["dep:ort", "dep:ndarray", "dep:tokenizers"]

[dependencies]
engram-core = { path = "../engram-core" }
tokio       = { workspace = true }
tracing     = { workspace = true }
thiserror   = { workspace = true }

whisper-rs  = { version = "0.13", optional = true }

ort         = { version = "2.0.0-rc.11", features = ["std", "ndarray", "load-dynamic"], optional = true }
ndarray     = { version = "0.17", optional = true }
tokenizers  = { version = "0.19", default-features = false, features = ["onig"], optional = true }
```

`ort` is pinned to the same version already used by `engram-audio` for VAD. `tokenizers` (the HuggingFace tokenizers crate) handles the Moonshine BPE vocab without any Python dependency.

### Step 3 — Implement `MoonshineService`

Moonshine's ONNX export uses two model files:
- `encoder_model.ort` — encodes the raw 16 kHz PCM waveform into hidden states
- `decoder_model_merged.ort` — autoregressive decoder with merged KV-cache (handles both first-pass and subsequent steps in one session)

The tokenizer is distributed as `tokenizer.json` alongside the model files, in HuggingFace tokenizers format.

```rust
// engram-whisper/src/moonshine_service.rs

#[cfg(feature = "moonshine")]
mod moonshine_impl {
    use ort::{Session, Value};
    use ndarray::{Array1, Array2, CowArray};
    use tokenizers::Tokenizer;
    use engram_core::error::EngramError;
    use crate::{TranscriptionResult, Segment};

    const SAMPLE_RATE: u32 = 16_000;
    const EOT_TOKEN: u32 = 50256;   // same end-of-text token as Whisper

    pub struct MoonshineService {
        encoder: Session,
        decoder: Session,
        tokenizer: Tokenizer,
    }

    impl MoonshineService {
        pub fn new(model_dir: &str) -> Result<Self, EngramError> {
            let encoder = Session::builder()?
                .with_optimization_level(ort::GraphOptimizationLevel::Level3)?
                .with_model_from_file(format!("{}/encoder_model.ort", model_dir))?;

            let decoder = Session::builder()?
                .with_optimization_level(ort::GraphOptimizationLevel::Level3)?
                .with_model_from_file(format!("{}/decoder_model_merged.ort", model_dir))?;

            let tokenizer = Tokenizer::from_file(
                format!("{}/tokenizer.json", model_dir)
            ).map_err(|e| EngramError::Config(e.to_string()))?;

            Ok(Self { encoder, decoder, tokenizer })
        }

        pub async fn transcribe(
            &self,
            audio_data: &[f32],
            sample_rate: u32,
        ) -> Result<TranscriptionResult, EngramError> {
            // Resample if needed (engram-audio produces 16 kHz, so this is a no-op
            // in the normal path but guards against future changes)
            let pcm = if sample_rate == SAMPLE_RATE {
                audio_data.to_vec()
            } else {
                resample(audio_data, sample_rate, SAMPLE_RATE)
            };

            let duration_secs = pcm.len() as f32 / SAMPLE_RATE as f32;

            // Encoder pass
            let audio_input = CowArray::from(
                Array2::from_shape_vec((1, pcm.len()), pcm)?
            ).into_dyn();
            let encoder_outputs = self.encoder.run(
                ort::inputs!["input_values" => audio_input]?
            )?;
            let hidden_states = encoder_outputs["last_hidden_state"].try_extract_tensor::<f32>()?;

            // Greedy decode
            let tokens = greedy_decode(&self.decoder, hidden_states, EOT_TOKEN)?;

            // Decode tokens to text
            let text = self.tokenizer
                .decode(&tokens, true)
                .map_err(|e| EngramError::Processing(e.to_string()))?
                .trim()
                .to_string();

            Ok(TranscriptionResult {
                text: text.clone(),
                segments: vec![Segment {
                    start: 0.0,
                    end: duration_secs,
                    text,
                    confidence: 1.0,   // Moonshine doesn't emit per-segment confidence;
                                       // segment-level confidence can be derived from
                                       // decoder logprobs in a follow-up pass
                }],
                language: "en".to_string(),
                duration_secs,
            })
        }
    }
}
```

The greedy decode loop is straightforward — feed the encoder hidden states and autoregressively sample the highest-logit token at each step until EOT or a max-length cap.

### Step 4 — Wire into `engram-whisper/src/lib.rs`

```rust
#[cfg(feature = "moonshine")]
pub use moonshine_service::MoonshineService;

#[cfg(feature = "whisper")]
pub use whisper_service::WhisperService;
```

### Step 5 — Wire into `engram-app`

```rust
// engram-app/src/main.rs (or pipeline wiring module)

let transcription_service: Arc<dyn TranscriptionService> = match config.stt_backend {
    SttBackend::Moonshine => {
        #[cfg(feature = "moonshine")]
        {
            Arc::new(MoonshineService::new(&config.moonshine_model_dir)?)
        }
        #[cfg(not(feature = "moonshine"))]
        {
            return Err(EngramError::Config(
                "moonshine feature not compiled in".into()
            ));
        }
    }
    SttBackend::Whisper => {
        #[cfg(feature = "whisper")]
        {
            Arc::new(WhisperService::new(&config.whisper_config)?)
        }
        #[cfg(not(feature = "whisper"))]
        {
            return Err(EngramError::Config(
                "whisper feature not compiled in".into()
            ));
        }
    }
};
```

The `engram-app` Cargo.toml default features become `["moonshine"]`, replacing the current `["whisper"]`.

---

## Model Acquisition and Bundling

The Moonshine ONNX models are published in two places:

- **HuggingFace (onnx-community):** `onnx-community/moonshine-base-ONNX` — the `.ort` flatbuffer files and `tokenizer.json`
- **HuggingFace (UsefulSensors):** `UsefulSensors/moonshine` — original weights in multiple formats

For Engram's installer, the base model (57 MB encoder + decoder) ships in the WiX package alongside the existing embedding model. The model directory is configured via `ENGRAM_MOONSHINE_MODEL_DIR` or `moonshine_model_dir` in `engram.toml`.

A first-run download path is not needed for the base model given its size, but should be considered for a future medium model. If added, it belongs in `engram-app`'s startup routine with progress reporting via an existing SSE endpoint.

Expected directory layout:

```
%APPDATA%\Engram\models\moonshine-base\
    encoder_model.ort
    decoder_model_merged.ort
    tokenizer.json
```

---

## Tokenizer

Moonshine uses a BPE tokenizer with the same vocabulary as Whisper (50,257 tokens). The `tokenizer.json` file distributed with the ONNX export is in HuggingFace tokenizers format, directly loadable with the `tokenizers` crate:

```rust
let tokenizer = Tokenizer::from_file("path/to/tokenizer.json")?;
```

No Python, no tiktoken, no runtime downloads. The tokenizer file is ~2 MB and ships with the model.

The `tokenizers` crate's `onig` feature is used for regex-based normalisation without requiring the full default feature set. Build time is fast.

---

## Streaming Transcription (v2)

The base integration above uses Moonshine in non-streaming mode: capture a full utterance, transcribe, inject text. This is the same behaviour as the current Whisper implementation.

Moonshine v2 introduces a sliding-window attention mechanism that enables streaming: process audio in fixed-length windows as the user speaks and emit partial results. The architecture paper (arxiv 2602.12241) describes bounded latency regardless of utterance length.

To add streaming to `engram-dictation`:

1. The Listening state feeds audio frames to a `StreamingTranscriptionService` trait (a new trait alongside the existing one, or an extension of it via an optional method).
2. `MoonshineStreamingService` runs the encoder on rolling windows and emits partial `TranscriptionResult` values over a channel.
3. `engram-dictation` forwards partial results to `TextInjector` with a backspace-and-retype correction mechanism (same approach used by most live dictation tools).

This is a follow-up scope item. The non-streaming integration is complete and independently shippable.

---

## The `ort` Shared Library

Both `engram-audio` (VAD) and `engram-whisper` (Moonshine) use `ort` with `load-dynamic`. This means a single `onnxruntime.dll` is loaded at runtime. There is one copy, no version conflict, and no linker friction. The WiX installer already needs to bundle this DLL for VAD — Moonshine adds no new native artifact.

If the DLL is absent at runtime, `ort::Session::builder()` returns an error. Engram should surface this as a clear startup error: `"OnnxRuntime DLL not found — reinstall Engram"` rather than a raw ort error.

---

## Risks and Open Questions

**Confidence scores.** `TranscriptionResult` includes per-segment confidence. Moonshine's greedy decoder does not expose per-token log-probabilities in the current ONNX export. Options: (a) hardcode `1.0` initially, (b) extract logprobs from the decoder output tensor manually. The rest of the codebase tolerates low-confidence segments gracefully, so `1.0` is a safe placeholder until the upstream model exposes this.

**Segment timestamps.** Moonshine's non-streaming ONNX export does not produce word-level or segment-level timestamps in the same way Whisper does. The current integration returns a single segment spanning the full audio duration. If `engram-storage` or `engram-insight` use segment timestamps for anything meaningful, this needs investigation. From the current codebase review, timestamps appear to be stored but not heavily relied upon downstream.

**Language selection.** Moonshine's multi-language models (Arabic, Japanese, Korean, Spanish, Ukrainian, Vietnamese, Chinese) are separate model files — not selectable via a language flag at inference time. For Engram's current English-first use case this is fine. If multi-language support is needed, the `MoonshineModelSize` enum should be extended to include language variants or the config should accept an arbitrary model directory path (which it already does).

**Model versioning.** The ONNX community models on HuggingFace are community-maintained, not official Moonshine AI releases. The official release path is the C++ library or Python package. Pinning to a specific HuggingFace commit SHA in the download routine (if one is added) avoids silent model updates.

**Windows ONNX Runtime version.** The `ort` crate 2.0.0-rc.11 ships with OnnxRuntime 1.20. Verify the `.ort` flatbuffer files from HuggingFace are encoded for this version. If there's a mismatch, `ort::Session::builder()` will fail with a format error at load time, not at inference time — easy to detect in integration tests.

---

## Testing

`engram-whisper` already has a `MockTranscriptionService` for unit testing without real models. No changes needed there.

Integration tests for `MoonshineService`:

1. **Model load test** — load encoder and decoder from a test model directory, assert no error. Can use the tiny model (26 MB) to keep CI fast.
2. **Round-trip test** — feed a known 16 kHz sine wave or silence clip, assert `transcribe()` returns without error and `text` is a `String` (not necessarily correct — just well-formed).
3. **Real transcription test** — feed a short audio clip with known content, assert the transcription matches within edit distance. Gate this test behind a `#[cfg(feature = "integration-tests")]` flag so it only runs locally with the model files present.

The existing `MockTranscriptionService` continues to cover all `engram-dictation` tests without modification.

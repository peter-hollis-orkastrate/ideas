# Engram — TADA TTS Review

**Date:** 2026-03-11

---

## Summary

TADA (Text-Audio Dual-stream Architecture, by Hume AI) is a high-quality generative TTS framework that achieves 1:1 token alignment between text and speech, eliminating frame-rate fixed synthesis and transcript hallucination. It produces naturalistic, low-latency speech with accurate prosody from relatively small LLM backbones (1B–3B parameters).

However, TADA is not a viable fit for Engram in its current form. It is a Python/PyTorch library with 1–3B parameter models that require GPU acceleration and cannot be bundled into a Windows installer. It has no ONNX export path and therefore cannot be integrated through the `ort` crate that already anchors Engram's inference stack.

TTS *is* a genuinely useful capability for Engram (audio digests, search result readback, accessibility, voice chat responses). The right path is a lightweight ONNX-based TTS engine — Kokoro or Piper — following the same principles that make Moonshine the right call for STT: small model, ONNX runtime, bundleable, no new native toolchain requirements.

---

## What TADA Does

TADA introduces a dual-stream generation architecture where each text token maps to exactly one speech vector ("1:1 token alignment"). Rather than generating a fixed number of audio frames per timestep, the model generates the complete speech for each token in a single autoregressive step, allowing dynamic prosody and duration without frame-rate constraints.

Key properties:

- **Model sizes:** TADA-1B (Llama 3.2 1B backbone) and TADA-3B-ML (Llama 3.2 3B, multilingual, 9 languages)
- **Codec:** Shared `HumeAI/tada-codec` encoder/decoder pair
- **Framework:** PyTorch, via `hume-tada` PyPI package
- **API:** Load `Encoder` + `TadaForCausalLM`, supply reference audio + text prompt, call `model.generate()`
- **Licence:** MIT
- **Inference requirement:** GPU strongly implied by model size; no CPU-optimised quantisation path documented

---

## Engram's Architecture Constraints

Engram is built on four principles that any new inference component must satisfy:

1. **Rust-native or Rust-callable.** All inference runs through `ort` (ONNX Runtime) or native Rust libraries. No Python interpreter, no subprocess with a multi-second startup cost.
2. **Bundleable.** Models ship in the WiX installer or are downloaded at first-run via the existing SSE progress endpoint. The practical limit for bundled models is ~100 MB; larger models require explicit first-run download UX.
3. **CPU-first, GPU-optional.** Engram runs on ordinary Windows laptops without discrete GPUs. Inference paths must be fast on CPU, with GPU as a bonus.
4. **No new native toolchains.** The `moonshine` decision document established that cmake and C++ compiler requirements are a meaningful friction point that should be avoided. All new native dependencies flow through `ort`'s single shared `onnxruntime.dll`.

---

## Why TADA Does Not Fit Today

| Criterion | TADA | Required |
|---|---|---|
| Language / runtime | Python + PyTorch | Rust or ONNX via `ort` |
| ONNX export | Not available | Required |
| Model size | 1B–3B parameters (~2–6 GB weights) | ≤100 MB bundled, or first-run download |
| CPU inference | Unusably slow at these sizes | Must be real-time on CPU |
| New native deps | Python interpreter, CUDA/ROCm | None beyond existing `onnxruntime.dll` |
| Build simplicity | pip install, separate venv | cargo build, no toolchain |

TADA's architecture is optimised for quality and naturalness at scale, not for embedded desktop inference. It is the TTS equivalent of Whisper large-v3 — excellent capability, wrong fit for Engram's deployment envelope.

There is no ONNX export path for TADA. The architecture depends on a custom codec (`tada-codec`) and dual-stream generation logic that is tightly coupled to the PyTorch execution graph. Exporting this to ONNX would require upstream engineering effort from Hume AI.

---

## What TTS Capability Would Benefit Engram

Despite TADA not being the right engine, TTS is a legitimate capability gap in Engram worth addressing. Concrete use cases:

**1. Audio Digests.** Engram already generates daily digests in `engram-insight`. Reading these aloud as a morning briefing while the user is away from their desk is a natural extension of the existing summarisation pipeline. The TTS engine synthesises digest text and streams audio through the default output device.

**2. Search Result Readback.** When a user issues a voice query via `engram-dictation`, returning the top result as synthesised speech closes the voice-in/voice-out loop without requiring the user to look at the screen.

**3. Notification Readback.** The action engine (`engram-action`) detects tasks and intent. Reading a confirmation prompt aloud ("Delete 3 files matching 'draft'. Confirm?") before the user responds reinforces safety-gated flows.

**4. Accessibility.** The web dashboard at `localhost:3030` currently has no audio output path. TTS enables screen-reader-like interaction for users who benefit from it.

All four use cases require:
- Latency ≤ 500 ms to first audio byte for short utterances (≤ 30 words)
- Naturalness sufficient for intelligibility; not requiring expressive emotion or voice cloning
- CPU-only real-time synthesis on a mid-range laptop
- English-first, with the same multi-language consideration as Moonshine

---

## Recommended Alternative: Kokoro or Piper

Two ONNX-compatible TTS engines fit Engram's constraints.

### Kokoro

| Property | Value |
|---|---|
| Model size | ~82 MB (ONNX export, FP32), ~41 MB (FP16) |
| Quality | MOS scores competitive with commercial TTS |
| ONNX export | Official, maintained |
| Languages | English (V0.19); multilingual variants in progress |
| Voices | 54 bundled (American/British English) |
| CPU real-time | Yes; ~0.15× real-time on CPU (generates 1 second of speech in 150 ms) |
| Licence | Apache 2.0 |
| HuggingFace | `hexgrad/Kokoro-82M` |

Kokoro's ONNX export takes a phoneme sequence and style embedding as inputs and produces a raw audio waveform. The phonemiser (espeak-ng) is the only external dependency — a small C library available as a pre-built Windows binary that can be bundled in the installer.

The `kokoro-rs` crate (community) wraps the ONNX model via `ort` and the `espeakng` crate. It follows the same pattern as the proposed `MoonshineService`: load ONNX sessions at startup, call synchronously or async from a Tokio task.

### Piper

| Property | Value |
|---|---|
| Model size | 63 MB (medium) to 130 MB (high) per voice |
| Quality | Good; slightly below Kokoro at equivalent size |
| ONNX export | Official, maintained by Rhasspy |
| Languages | 40+ languages, 70+ voices |
| CPU real-time | Yes; ~0.05× real-time on CPU |
| Licence | MIT |
| HuggingFace | `rhasspy/piper-voices` |

Piper also uses espeak-ng for phonemisation. Its Rust integration is more established (`piper-rs`, used in Home Assistant). Piper's advantage is language breadth; Kokoro's advantage is English quality.

### Comparison to TADA

| | TADA | Kokoro | Piper |
|---|---|---|---|
| ONNX | No | Yes | Yes |
| Bundleable | No (2–6 GB) | Yes (41–82 MB) | Yes (63–130 MB) |
| CPU real-time | No | Yes | Yes |
| Rust via `ort` | No | Yes | Yes |
| Quality (English) | Best-in-class | Near-commercial | Good |
| Licence | MIT | Apache 2.0 | MIT |

---

## Proposed Architecture (Kokoro)

The TTS integration is narrower than the Moonshine STT integration because TTS is a new capability rather than a replacement for an existing one. A new crate `engram-tts` is the right home.

```
[engram-insight / engram-chat / engram-action]
  DigestText / SearchResult / ConfirmationPrompt
         │
         ▼
[engram-tts]
  SynthesisService trait
  KokoroService (ort + espeak-ng phonemiser)
         │
  Vec<f32> PCM at 24 kHz
         │
         ▼
[cpal output device]
  real-time audio streaming via cpal ring buffer
```

**Trait:**

```rust
pub trait SynthesisService: Send + Sync {
    fn synthesise(
        &self,
        text: &str,
        voice: &str,
    ) -> impl Future<Output = Result<SynthesisResult, EngramError>> + Send;
}

pub struct SynthesisResult {
    pub pcm: Vec<f32>,
    pub sample_rate: u32,   // 24000 for Kokoro
}
```

**Changes required:**

- `engram-tts` — new crate with `KokoroService` behind a `kokoro` feature flag
- `engram-core` — `TtsBackend` enum (`Kokoro`, `Disabled`), `TtsConfig` with voice name and model dir
- `engram-insight` — call `SynthesisService::synthesise()` for digest readback (optional, gated by `tts_enabled` in config)
- `engram-api` — new endpoint `POST /api/speak` that accepts text and streams audio bytes (enables the web dashboard's voice output)
- `engram-app` — wire `KokoroService` at startup

**Unchanged:** `engram-audio`, `engram-whisper`, `engram-dictation`, `engram-storage`, `engram-vector`, `engram-ocr`, `engram-capture`, `engram-action`, `engram-chat`.

---

## Model Bundling

Kokoro FP16 ONNX (~41 MB) + voices (~2 MB each) + espeak-ng data (~8 MB) totals ~55 MB for a two-voice bundle (one American English, one British English). This fits alongside Moonshine base (57 MB) and the existing embedding model within reasonable installer size limits.

Expected directory layout:

```
%APPDATA%\Engram\models\kokoro\
    kokoro-v0_19.onnx
    voices\
        af_heart.bin
        bm_lewis.bin
    espeak-ng-data\
        en_dict
        intonations
        ...
```

The espeak-ng Windows DLL ships pre-built; no compiler toolchain required. The `ort` shared library is already bundled for VAD and Moonshine. No new native artifacts beyond `libespeak-ng.dll`.

---

## Revisiting TADA: Conditions for Future Fit

TADA could become relevant to Engram if any of the following materialise:

1. **Official ONNX export.** Hume AI publishes a supported ONNX path for TADA-1B. At 1B parameters, even FP8 quantisation would produce a ~500 MB model, likely requiring a first-run download — acceptable with the existing download infrastructure, but not bundleable.

2. **GPU-gated feature.** Engram detects CUDA/ROCm availability at startup and offers TADA as an optional high-quality voice for users with a GPU. This is a meaningful UX bifurcation and adds ongoing maintenance surface.

3. **Hosted mode.** Engram adds an optional cloud mode that proxies TTS requests to Hume AI's hosted TADA API (if one becomes available). This breaks the local-first privacy guarantee and is architecturally out of scope for Engram's core.

None of these conditions exist today. The right decision for 2026 is to ship Kokoro (or Piper) and revisit TADA when an ONNX path exists.

---

## Relationship to Moonshine Integration

The Moonshine document established a pattern for integrating ONNX inference into Engram:

- Feature flag in the relevant crate
- `ort` + `ndarray` as optional dependencies pinned to the workspace version
- Trait implementation with `async fn` returning a domain result type
- Config variant in `engram-core`
- Single wiring point in `engram-app`

The TTS integration follows the same pattern exactly, using `engram-tts` instead of `engram-whisper`. The two integrations are independent and can be developed in parallel. Shipping Moonshine first is the right sequencing: dictation quality is a more impactful user-facing improvement than TTS readback, and Moonshine's integration path is fully validated.

---

## Risks and Open Questions

**espeak-ng DLL on Windows.** The pre-built espeak-ng Windows binary is maintained by the Rhasspy project alongside Piper. It is a well-tested path. Kokoro's community Rust crate links against it dynamically. If espeak-ng adds any toolchain requirements for the Engram build, Piper should be evaluated as the alternative (its Rust crate has a more established Windows build story).

**Kokoro voice quality regression.** Kokoro V0.19 is the current stable release. Future Kokoro versions may change model format or phonemiser requirements. Pinning to a specific HuggingFace commit SHA and `kokoro-rs` version protects against silent regressions.

**Audio device contention.** `engram-audio` uses cpal for capture. Adding cpal for playback introduces the possibility of device contention if the system has a single audio device that cannot simultaneously capture and play. In practice, Windows WASAPI handles this correctly for separate input and output streams, but it should be validated in integration tests.

**Streaming synthesis.** Kokoro generates the full waveform before returning, introducing latency proportional to utterance length. For short utterances (digest headlines, confirmation prompts) this is acceptable. For longer text (full digest paragraphs), chunk-and-stream synthesis — synthesising sentence by sentence and starting playback before the full text is processed — is a follow-up scope item.

---

## Recommendation

1. **Do not integrate TADA.** It is a poor architectural fit today: wrong runtime, wrong size, no ONNX path.
2. **Proceed with Moonshine STT** as the next integration (per the existing document), as it has the higher user-facing impact.
3. **Add TTS as a follow-on milestone** using Kokoro (English-first) or Piper (if multilingual breadth is prioritised). The integration pattern is established, the model fits the installer, and the use cases (audio digests, search readback, accessibility) are concrete.
4. **Revisit TADA** when Hume AI publishes an ONNX export or provides a hosted API with acceptable privacy characteristics.

# Engram vs Swictation: Comparative Analysis

## Executive Summary

**Engram** and **Swictation** are both privacy-focused, local-first Rust applications that share significant architectural philosophy but solve different primary problems. Swictation is a dedicated voice-to-text dictation engine, while Engram is a screen memory and knowledge capture system with dictation as one of several capabilities. This comparison identifies where Swictation's mature dictation pipeline could strengthen Engram's audio/dictation subsystem.

---

## At a Glance

| Dimension | Engram | Swictation |
|---|---|---|
| **Primary Purpose** | Screen memory & knowledge capture | Voice-to-text dictation |
| **Platform** | Windows | Linux & macOS |
| **Language** | Rust (axum web framework) | Rust (Tokio async daemon) |
| **Crate Count** | 14 | 6+ |
| **STT Engine** | Whisper (whisper.cpp) | Parakeet-TDT (ONNX Runtime) |
| **VAD** | Silero | Silero v6 |
| **Text Injection** | Windows SendInput | xdotool / wtype / ydotool / Accessibility API |
| **GPU Acceleration** | Feature-gated | CUDA (Linux), CoreML/Metal (macOS) |
| **Licence** | MIT | Apache 2.0 |

---

## Shared Architectural Principles

Both projects share a remarkably similar philosophical foundation:

1. **Local-first / privacy-by-design** - Zero cloud dependencies; all inference runs on-device.
2. **Rust monorepo with domain-specific crates** - Clean separation of concerns across audio, STT, VAD, and application layers.
3. **Silero VAD** - Both use Silero for voice activity detection to trigger transcription.
4. **cpal for audio capture** - Both use the `cpal` Rust crate as their cross-platform audio backend.
5. **Hotkey-activated dictation** - Both support global hotkey triggers (Ctrl+Shift+D in both cases).
6. **Text injection into active windows** - Both transcribe speech and inject the result into whatever application has focus.

---

## Detailed Comparison by Subsystem

### 1. Speech-to-Text Engine

| Aspect | Engram | Swictation |
|---|---|---|
| **Model** | Whisper (via whisper.cpp) | Parakeet-TDT 0.6B / 1.1B |
| **WER** | ~5-10% (model-dependent) | 5.77% (1.1B), 7-8% (0.6B) |
| **Inference** | whisper.cpp C bindings | ONNX Runtime (ort 2.0) |
| **Quantization** | Model-dependent | INT8 (1.1B), FP32 (0.6B) |
| **Latency** | Higher (batch-oriented) | 100-250ms GPU, 200-400ms CPU |
| **Adaptive Model Selection** | No | Yes - auto-selects based on VRAM |

**Insight for Engram:** Swictation's adaptive model selection based on available GPU VRAM is a compelling pattern. Engram could benefit from detecting hardware capabilities at startup and automatically selecting the appropriate Whisper model size (tiny/base/small/medium/large) rather than requiring manual configuration.

### 2. Voice Activity Detection

| Aspect | Engram | Swictation |
|---|---|---|
| **Model** | Silero VAD | Silero VAD v6 |
| **Threshold** | Configurable | 0.25 (production-optimized) |
| **Silence Duration** | Not documented | 0.5-0.8s configurable |
| **Noise Robustness** | Standard | 16% improvement over v5 on noisy data |

**Insight for Engram:** If Engram is not already on Silero v6, upgrading would provide meaningfully better noise robustness. Swictation's tuned 0.25 threshold and 0.8s silence window are battle-tested defaults worth adopting.

### 3. Audio Pipeline

| Aspect | Engram | Swictation |
|---|---|---|
| **Backend** | cpal + WASAPI | cpal + PipeWire/ALSA/CoreAudio |
| **Sample Rate** | Not documented | 16kHz mono |
| **Buffer Strategy** | Standard | Lock-free ring buffer |
| **Chunk Size** | Not documented | 1024 samples (~64ms) |
| **Resampling** | Not documented | rubato for non-16kHz sources |
| **Capture Latency** | Not documented | <5ms overhead |

**Insight for Engram:** Swictation's lock-free ring buffer design ensures audio capture never blocks the main processing thread - critical for Engram where audio runs alongside continuous screen capture and OCR. The explicit resampling support via `rubato` is also worth noting; not all audio devices output at 16kHz, and handling this gracefully prevents subtle transcription quality issues.

### 4. Text Transformation & Secretary Mode

This is Swictation's standout differentiator. Engram has no equivalent.

**Swictation's Secretary Mode provides:**
- 60+ voice commands for punctuation ("comma", "period", "question mark")
- Bracket/quote management ("open paren", "close bracket")
- Number conversion ("number forty two" → "42")
- Formatting commands ("new line", "new paragraph", "tab")
- Capitalization controls ("caps on/off", "all caps", "capital")
- Programming symbols ("double equals", "triple equals", "increment")
- Three-layer processing: escape detection → phrase matching → mode-aware rules
- Automatic capitalization after sentence-ending punctuation

**Insight for Engram:** Secretary Mode would be a high-value addition to Engram's dictation feature. Users dictating notes, emails, or code benefit enormously from being able to say "open paren see dot get open paren close paren close paren semicolon" and getting `(c.get());`. Even a subset of punctuation commands would significantly improve dictation usability.

### 5. Intelligent Correction System

Swictation includes a learning correction system:
- Learns from user edits over time
- Phonetic fuzzy matching with configurable sensitivity (0.0-1.0)
- Case-aware pattern matching (uppercase, title case, preserve)

**Insight for Engram:** Engram's knowledge capture architecture is already built around learning from user activity. Integrating a correction feedback loop where edits to dictated text train future transcription post-processing would be a natural extension of Engram's existing design philosophy.

### 6. Text Injection

| Aspect | Engram | Swictation |
|---|---|---|
| **Platform** | Windows (SendInput) | Linux (xdotool/wtype/ydotool), macOS (CGEvent/Accessibility API) |
| **Auto-detection** | N/A (Windows-only) | Yes - detects X11/Wayland/macOS |
| **Batching** | Not documented | Batched CGEvent delivery on macOS |
| **Fallback Chain** | None documented | Three-tool fallback on Linux |

**Insight for Engram:** If Engram ever targets Linux or macOS, Swictation's platform-detection and fallback chain architecture is a proven pattern to follow.

### 7. Performance Characteristics

| Metric | Engram | Swictation |
|---|---|---|
| **End-to-end latency** | Not benchmarked publicly | 150-300ms typical |
| **Daemon memory** | Not documented | ~150MB baseline |
| **GPU VRAM** | Feature-gated | 800MB-2.2GB (model-dependent) |
| **Hotkey response** | Not documented | <10ms |

**Insight for Engram:** Swictation's sub-second pipeline is impressive for real-time dictation. Engram's dictation module should target similar latency budgets. The detailed latency breakdown (hotkey <10ms, transcription 100-250ms, injection 10-50ms) provides a useful benchmark.

---

## Key Insights & Recommendations for Engram

### High Priority

1. **Adopt Secretary Mode (or a subset)** - Swictation's voice command system for punctuation and formatting is its killer feature. Even implementing the top 20 commands (period, comma, question mark, new line, new paragraph, open/close paren, quotes) would dramatically improve Engram's dictation UX.

2. **Adaptive Model Selection** - Auto-detect GPU/VRAM and select the optimal Whisper model variant. This removes a configuration burden from users and ensures best performance on their hardware.

3. **Lock-free Audio Buffer** - If Engram's audio pipeline doesn't already use a lock-free ring buffer, adopting this pattern would improve reliability, especially given Engram's concurrent screen capture and OCR workloads.

### Medium Priority

4. **Upgrade to Silero VAD v6** - The 16% noise robustness improvement is meaningful for real-world environments with background noise (fans, typing, ambient office sound).

5. **Correction Learning System** - Engram already captures screen content and user activity. Building a feedback loop where post-dictation edits improve future transcription accuracy aligns perfectly with Engram's "memory" philosophy.

6. **Latency Benchmarking** - Swictation's detailed latency breakdown (per-stage timing) provides a template for instrumenting Engram's dictation pipeline. The `swictation-metrics` crate approach could be adapted.

### Lower Priority / Future Consideration

7. **Evaluate Parakeet-TDT as Alternative STT** - With 5.77% WER and faster inference than Whisper, Parakeet-TDT is worth evaluating as an alternative or option alongside Whisper, particularly if Engram adds GPU acceleration.

8. **Cross-platform Expansion** - If Engram targets Linux/macOS in the future, Swictation's platform detection, text injection fallback chains, and service management (systemd/launchd) patterns provide a proven blueprint.

9. **Text Transformation Pipeline Architecture** - Swictation's MidStream external module approach (text transformation as a separable submodule) suggests Engram could benefit from a plugin-style transformation pipeline where Secretary Mode, PII redaction, and custom transforms are composable stages.

---

## Complementary Strengths

The two projects have complementary strengths that suggest potential synergy:

| Engram Excels At | Swictation Excels At |
|---|---|
| Screen OCR & visual memory | Real-time audio pipeline optimization |
| Semantic search & vector indexing | Voice command parsing & text transformation |
| Entity extraction & summarization | Adaptive hardware detection & model selection |
| PII redaction & safety | Cross-platform text injection |
| Conversational query interface | Sub-second dictation latency |
| Action engine & task management | Intelligent correction learning |

A combined approach where Engram's knowledge capture and intelligence layer wraps Swictation's optimized dictation pipeline would yield a system that both captures everything and allows high-quality voice input across the captured context.

---

## Conclusion

Swictation represents a deep investment in solving voice-to-text dictation well, with particular strengths in real-time audio pipeline engineering, voice command processing, and cross-platform text injection. Engram's dictation subsystem (`engram-dictation` + `engram-whisper` + `engram-audio`) would benefit most from adopting Swictation's Secretary Mode concept, adaptive model selection, and lock-free audio buffering. These enhancements would elevate Engram's dictation from a functional feature to a polished, production-quality input method befitting the rest of its sophisticated architecture.

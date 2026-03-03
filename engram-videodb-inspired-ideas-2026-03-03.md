# Video-DB Inspired Ideas for Engram — Local-Only

**Date:** 2026-03-03

---

## Framing

Video-DB is a cloud video infrastructure platform. As a cloud service it is not compatible with Engram's local-only guarantee. But its product thinking is useful: it has solved interesting problems around visual scene understanding, agent orchestration over media, timeline-based retrieval, and multi-layer summarization — all in the context of continuous capture.

The exercise here is to treat video-db as a source of *concepts*, not code, and ask: what is the local-only equivalent of each idea, and does it fill a real gap in Engram?

All implementations below require no network connection, no API keys, and no data leaving the machine.

---

## The Common Thread: Ollama as a Local LLM Layer

All six ideas below converge on the same architectural addition: an optional **Ollama integration** in Engram.

Ollama:
- Runs entirely on-device — no network, no API keys, no cost
- Exposes an OpenAI-compatible REST API, easy to call from Rust via `reqwest`
- Supports vision models (moondream2, LLaVA) and text models (Llama 3, Phi-3, Mistral, Qwen)
- Handles model download and lifecycle management

**Proposed architecture:** a trait in `engram-core` called `InferenceBackend` with two implementations:
1. The current local path (ONNX embeddings + regex NLP) as the default
2. An optional `OllamaBackend` enabled via `~/.engram/config.toml`

The local-only guarantee holds either way. The Ollama path requires the user to have Ollama installed and a model pulled — it is opt-in, not the default. The default behaviour does not change.

```toml
# ~/.engram/config.toml
[inference]
backend = "ollama"          # or "local" (default)
ollama_host = "127.0.0.1"
ollama_port = 11434
text_model = "phi3:mini"
vision_model = "moondream"
```

---

## Idea 1: Local Vision Layer

**Inspired by:** `videodb-python`'s `index_scenes()` and `extract_scenes()` APIs

### The Gap

Engram captures screens at 1 FPS and extracts text via WinRT OCR. It has no concept of *what the user is looking at visually* — only what text appears on screen. A screen full of a chart, a diagram, a video call, or a design tool produces little or no useful OCR output.

### The Idea

Add periodic visual scene description using a local vision model. [moondream2](https://github.com/vikhyat/moondream) is a 1.8B parameter vision-language model that runs locally via Ollama and produces natural language descriptions of images in ~1 second on modest hardware.

On a configurable cadence (e.g. every 10 seconds, or on significant visual change), Engram sends the current screen capture to moondream and stores the description alongside the OCR text.

**Example outputs:**
- "User is reviewing a pull request diff in a dark-themed code editor"
- "A terminal window shows a Rust compiler error with a stack trace"
- "A video call with four participants, one sharing a slide deck"
- "A browser tab showing a data visualisation with bar charts"

These descriptions are indexed in `engram-vector` and stored as a new `VisualSceneEvent` in `engram-core`, enabling search queries that OCR cannot answer:

- *"when was I last looking at a chart?"*
- *"find when the terminal had a build error"*
- *"what was on screen during the 3pm call?"*

### Implementation Notes

- New `engram-vision` crate with a `VisionBackend` trait (local stub + Ollama implementation)
- Only runs when `backend = "ollama"` and a vision model is configured
- Visual change detection (frame diff threshold) avoids redundant inference on static screens
- Descriptions stored in `captures` table alongside existing `ocr_text` column

---

## Idea 2: Ollama-Powered Chat

**Inspired by:** Director's natural language agent orchestration

### The Gap

`engram-chat` uses a hand-written regex NLP parser with 40+ patterns. This was flagged in the DeepNote comparison as the weakest point in the intelligence stack. It cannot handle:
- Novel phrasing that doesn't match a known pattern
- Multi-step queries ("find what I was working on before the call last Tuesday and summarise it")
- Contextual follow-up that requires understanding prior conversation turns

### The Idea

When the Ollama backend is configured, replace the regex parser in `engram-chat` with a local LLM call. The LLM receives:
1. A system prompt describing Engram's capabilities and data schema
2. The conversation history (for follow-up resolution)
3. The user's query
4. Relevant retrieved context from `engram-vector`

It returns a structured response: intent classification, extracted parameters, generated answer, and **source citations** linking back to specific screen captures or audio segments by timestamp.

The citation linking is the key UX improvement — users can verify exactly where an answer came from and navigate to that moment.

The regex parser becomes a fast fallback when Ollama is not configured, preserving the default behaviour.

### Implementation Notes

- `engram-chat` gains an `LlmChatBackend` alongside the existing `RegexChatBackend`
- System prompt is a static file, tunable without recompiling
- Structured output via JSON mode (Ollama supports `format: "json"`)
- Citations are `(timestamp, source_type, excerpt)` tuples embedded in the response

---

## Idea 3: Local Meeting Intelligence

**Inspired by:** Director's pre-built meeting agents (meeting summarisation, action item extraction, CRM export)

### The Gap

Engram transcribes meetings via Whisper.cpp but produces no higher-level meeting intelligence. The transcript is stored and searchable but not interpreted. There is no extraction of action items, decisions, key topics, or follow-up dates.

### The Idea

After `engram-whisper` closes a meeting-length audio segment (detected by silence or a manual end-of-meeting signal), pipe the transcript to a local Ollama model with a structured extraction prompt.

Extract and store:
- **Action items** with owner (if mentioned) and due date (if mentioned)
- **Decisions made** — things the group agreed on
- **Key topics** — a ranked list of subjects discussed
- **Open questions** — unresolved items
- **Follow-up dates** — any future commitments mentioned

The result is stored as a `MeetingIntelligenceEvent` in `engram-storage` and surfaced in `engram-ui` as a meeting summary card.

The `engram-action` crate's existing 7-state async workflow handles the extraction job — it already knows how to manage background tasks with user-visible progress.

### Implementation Notes

- Trigger: audio segment length > configurable threshold (default 10 minutes) OR manual `/meeting end` chat command
- Prompt uses structured JSON output format for reliable parsing
- Action items surface in the existing task view in `engram-ui`
- No changes to the capture pipeline — this is pure post-processing

---

## Idea 4: Timeline Replay

**Inspired by:** PromptClip ("find me the moments where X happened" → returns video clips)

### The Gap

Engram stores screenshots, OCR text, and audio transcripts with timestamps, but there is no way to *replay* a time window. You can search and get a result, but you cannot say "show me everything that happened during the hour I was debugging that error" and get a coherent reconstruction.

### The Idea

A new `GET /v1/memory/replay` endpoint in `engram-api` that accepts a natural language query or a time range and returns an ordered sequence of events reconstructed from stored data:

```json
{
  "query": "when I was debugging the auth error last Thursday",
  "events": [
    { "t": "14:32:10", "type": "screen", "ocr": "...", "scene": "terminal with stack trace", "screenshot_id": 8821 },
    { "t": "14:32:45", "type": "audio", "transcript": "okay so the token is expired...", "segment_id": 441 },
    { "t": "14:33:02", "type": "screen", "ocr": "...", "scene": "browser showing JWT docs", "screenshot_id": 8834 }
  ]
}
```

If Ollama is available, the query goes through the LLM to identify the time window and filter relevant events. If not, it falls back to vector search + time range expansion.

The `engram-ui` dashboard renders this as a scrollable timeline — screenshot thumbnails on one track, transcript segments on another, meeting summaries where they exist. PromptClip returns a video; Engram returns an interactive timeline of stills and text. Same concept, no video required, entirely local.

### Implementation Notes

- New `ReplayQuery` type in `engram-core`
- `engram-api` endpoint delegates to `engram-vector` for retrieval and `engram-storage` for event hydration
- LLM used only for query → time range interpretation, not for content generation
- Timeline rendering is a new view in `engram-ui` using the existing SSE event stream

---

## Idea 5: Hierarchical Local Summarisation

**Inspired by:** focusd's 5-layer summarisation pipeline (raw event → activity → micro-summary → session → daily)

### The Gap

Engram's daily digests use extractive summarisation — it selects and concatenates existing text rather than generating new language. This works for short periods but loses coherence over longer time spans. focusd's insight is that *hierarchical* summarisation — where each level summarises summaries rather than raw events — scales to days, weeks, and months without losing the thread.

### The Idea

When Ollama is configured, replace the extractive digest pipeline in `engram-insight` with a generative hierarchy:

| Level | Input | Output | Cadence |
|---|---|---|---|
| Activity | Raw OCR + scene events | 1-sentence activity description | Every ~5 min of continuous activity |
| Micro-summary | Activity descriptions | Short paragraph | Per work session |
| Session summary | Micro-summaries | Structured summary with topics + mood | Per day part (morning / afternoon / evening) |
| Daily digest | Session summaries | Full daily narrative with insights | End of day |
| Weekly digest | Daily digests | Weekly patterns + highlights | End of week |

Each level uses a small, fast local model (phi3:mini works well for summarisation tasks). The daily and weekly levels can use a larger model if available.

This directly enables Stage 3 (pattern recognition) from the intelligence stack framing: the weekly digest can surface patterns across days that raw search cannot — "you spend Tuesday mornings almost entirely in deep work but Thursday afternoons are fragmented by context switches."

### Implementation Notes

- New summarisation scheduler in `engram-insight` driven by event counts and time triggers
- Each summary stored with its level, time range, and source event IDs (for citation)
- Existing daily digest endpoint in `engram-api` returns the generative version when available, extractive as fallback
- The weekly digest is a new `GET /v1/digest/weekly` endpoint

---

## Idea 6: Local Claim Monitor

**Inspired by:** video-db's `fact-checker` app (real-time claim classification on system audio)

### The Gap

Engram transcribes audio continuously but applies no real-time analysis to the content of what is being said. The transcript is stored for later search but not acted on in the moment.

### The Idea

An optional real-time analysis module in `engram-insight` that monitors the live Whisper transcript buffer and classifies claims using a local LLM. Claims are flagged as:

- **Unverified** — asserted as fact, not obviously verifiable from Engram's memory
- **Contradicts memory** — Engram has stored context that contradicts the claim
- **Consistent with memory** — Engram has stored context that supports the claim

The third category is the most interesting and the most Engram-native: *"someone in this meeting just said the launch was Q3 — I remember reading an email on screen last week that said Q2"*. That is something only a system with personal memory can surface.

Alerts appear as non-intrusive notifications in `engram-ui`. The user can click through to the relevant memory context.

This differs from video-db's fact-checker (which hits external sources like Gemini) by grounding claims only against Engram's own memory — no network calls, no external lookups.

### Implementation Notes

- New `ClaimMonitor` in `engram-insight`, off by default, enabled via config
- Subscribes to the existing audio event stream
- Transcript segments are batched (e.g. every 30 seconds) to avoid per-sentence inference overhead
- LLM classifies claims and `engram-vector` retrieves relevant memory context for contradiction checking
- A `ClaimAlertEvent` is emitted to the SSE stream for the UI to display

---

## Priority Order

Given Engram's intelligence stack framing (Stages 2–4 are the goal, Stage 1 is not the differentiator), and the principle of building for personal use first:

| Priority | Idea | Why |
|---|---|---|
| 1 | **Ollama integration + LLM chat** | Fixes the weakest link (regex NLP). Every other idea builds on this. |
| 2 | **Hierarchical summarisation** | Directly advances Stage 3 (pattern recognition). The most impactful intelligence upgrade. |
| 3 | **Meeting intelligence** | High personal utility. Meetings are the highest-value capture context. |
| 4 | **Visual scene layer** | Fills the largest gap in capture quality. Unlocks queries nothing else can answer. |
| 5 | **Timeline replay** | Powerful UX, but depends on ideas 1 and 4 being in place for best results. |
| 6 | **Claim monitor** | Interesting but situational. Build last. |

The natural implementation order is also 1 → 2 → 3 → 4 → 5 → 6 since each depends on the prior. Ideas 1 through 3 require no changes to the capture pipeline and can ship as pure intelligence upgrades to existing stored data.

---

*Inspiration source: [video-db GitHub organisation](https://github.com/orgs/video-db/repositories). All implementations described here are local-only with no cloud dependency.*

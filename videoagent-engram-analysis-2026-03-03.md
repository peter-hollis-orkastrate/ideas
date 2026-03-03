# VideoAgent → Engram Integration Analysis

**Date:** 2026-03-03
**Repos:** [HKUDS/VideoAgent](https://github.com/HKUDS/VideoAgent) · [peter-hollis-orkastrate/engram](https://github.com/peter-hollis-orkastrate/engram)

---

## Summary

VideoAgent and Engram solve related but distinct problems: VideoAgent orchestrates LLM agents to understand, edit, and remake *video files* from natural language commands; Engram passively captures everything on your *screen and in meetings* and makes it searchable locally. The conceptual overlap is substantial — both treat rich time-series media as a queryable memory store — but their execution philosophies diverge sharply on privacy (cloud LLMs vs. fully local) and target media (pre-existing video files vs. live screen/audio capture).

The most impactful ideas Engram can borrow from VideoAgent are:

1. **Graph-based workflow orchestration** to replace the current 7-state task machine
2. **Temporal session understanding** — treating screen-capture sessions as "video narratives" rather than isolated frames
3. **LLM-powered intent decomposition** to replace the 80+ regex patterns in `engram-action` and `engram-chat`
4. **Two-step self-evaluation** loops for task automation

All four can be implemented with *local* LLMs, preserving Engram's privacy-first model.

---

## Side-by-Side Overview

| | **VideoAgent** | **Engram** |
|---|---|---|
| **Repository** | [HKUDS/VideoAgent](https://github.com/HKUDS/VideoAgent) | [peter-hollis-orkastrate/engram](https://github.com/peter-hollis-orkastrate/engram) |
| **Core idea** | Agentic framework that understands, edits, and remakes *video files* from natural language | Local-only screen memory — continuously captures what you see and hear, indexes it, makes it searchable |
| **Primary metaphor** | "AI video production assistant" | "Total recall for your desktop" |
| **Language** | Python 3.10 | Rust (14-crate workspace) |
| **Platform** | Cross-platform (cloud API dependent) | Windows-only (Win32/WinRT) |
| **AI approach** | Cloud LLMs — Claude for routing, GPT-4o for editing, Gemini for captions, DeepSeek for remixing | All local — ONNX embeddings, Whisper.cpp, regex NLP. No API keys required. |
| **Memory / retrieval** | VideoRAG: caption-indexed video banks + ImageBind multimodal embeddings | SQLite + FTS5 + HNSW vector index over OCR text and transcriptions |
| **Orchestration** | LLM-powered intent analysis → graph workflow engine → self-evaluation loop | 80+ regex pattern intent detection → 7-state task machine |
| **Input** | Explicit: user uploads video files and issues commands | Passive/ambient: continuous background capture |
| **Output** | Edited/remixed video files, summaries, Q&A answers | Searchable memory, chat answers, injected text, automated tasks |
| **Privacy** | Data leaves the machine (cloud LLMs) | Fully local, PII redacted before storage |
| **Maturity** | Research prototype with benchmark results | 6 phases complete, 1,325 tests, 27 ADRs |

---

## VideoAgent Architecture Deep-Dive

VideoAgent is built on three interlocking innovations:

### 1. Intent Analysis
The system decomposes a user instruction (e.g., *"make a meme video of the funny moments, then dub it in Spanish"*) into **explicit sub-intents** (clip funny moments, add Spanish audio) and **implicit sub-intents** (detect scene transitions, match lip sync). Each sub-intent maps to a specific agent/tool.

### 2. Graph-Powered Workflow Engine
Sub-intents are assembled into a directed graph where **nodes = tool capabilities** and **edges = data dependencies**. Claude acts as the graph router, selecting which tools to activate and in what order. The graph supports branching, parallelism, and conditional paths.

### 3. Storyboard Agent + VideoRAG
Before retrieval, user input is transformed into a "storyboard" — a sequence of visual queries. A pre-captioned video bank (generated offline by Gemini) enables semantic retrieval via fine-grained sub-queries. This is essentially **RAG for video**, treating a video as a sequence of timestamped, captioned segments.

### 4. Two-Step Self-Evaluation
After each tool invocation, the system evaluates: (a) did the tool succeed? and (b) does the output satisfy the original sub-intent? Failures trigger re-planning or parameter adjustment. This is iterated until convergence or a retry limit is reached.

---

## Engram Architecture — Relevant Crates

| Crate | Relevance to VideoAgent ideas |
|---|---|
| `engram-action` | Intent detection (80+ regex patterns) + 7-state task machine — **biggest gap vs. VideoAgent** |
| `engram-chat` | NLP parser (40+ patterns) + session persistence — also regex-heavy |
| `engram-insight` | Summarization, entity extraction, clustering — closest to VideoAgent's storyboard summarization |
| `engram-vector` | HNSW + ONNX embeddings — solid foundation for VideoRAG-style retrieval |
| `engram-storage` | SQLite + FTS5 — already timestamped; enables temporal queries |
| `engram-capture` | Continuous screenshot capture — the "video stream" equivalent |
| `engram-whisper` | Local Whisper transcription — already does what VideoAgent does via cloud |
| `engram-ocr` | WinRT OCR — frame-level "captioning" equivalent |

---

## Integration Opportunities

### Opportunity 1: Graph-Based Workflow Engine (High Impact)

**VideoAgent's approach:** Claude decomposes a user intent into a directed acyclic graph of tool invocations, executes it, and self-corrects.

**Engram's current state:** `engram-action` uses a flat 7-state machine. Complex multi-step tasks (e.g., *"find all mentions of Project X from last week, summarize them, and draft an email"*) cannot be expressed.

**How to adapt:**
- Add a `WorkflowGraph` struct to `engram-action`: nodes are `ActionStep` enums (Search, Summarize, Inject, OpenApp, etc.), edges are data dependencies.
- Use a local LLM (Ollama/llama.cpp) as the graph router, replacing Claude with a locally-hosted model.
- The graph executes topologically; each step's output feeds the next.
- Keeps Engram's privacy guarantee: LLM inference stays on-device.

**Effort:** Large (new subsystem). Could be scoped as `engram-workflow` crate.

---

### Opportunity 2: LLM-Powered Intent Decomposition (High Impact)

**VideoAgent's approach:** Rather than pattern matching, an LLM reads the full user utterance and returns structured JSON: `{ "explicit_intents": [...], "implicit_intents": [...], "tool_assignments": {...} }`.

**Engram's current state:** `engram-action` has 80+ hardcoded regex patterns and `engram-chat` has 40+ NLP patterns. These fail on novel phrasings, compound requests, and ambiguous commands.

**How to adapt:**
- Add an optional `IntentLLM` backend to `engram-action` and `engram-chat`.
- When a local LLM is configured (via `~/.engram/config.toml`), route intent parsing through it; fall back to regex if not available.
- Prompt template mirrors VideoAgent's decomposition: ask the model to return explicit vs. implicit intents and the best matching action handler.
- The existing action handlers remain unchanged — only the routing layer improves.

**Effort:** Medium. The action handlers don't change; only the dispatch layer gains an LLM option.

---

### Opportunity 3: Temporal Session Understanding (Medium Impact)

**VideoAgent's approach:** A video is not just a bag of frames — it's a **narrative arc** with scenes, transitions, and temporal relationships. The Storyboard Agent builds a scene-level summary before doing fine-grained retrieval.

**Engram's current state:** Screen captures are stored and indexed as individual frames. Queries return matching frames in reverse-chronological order, but there's no concept of an **activity session** (e.g., "the 45 minutes I spent writing the report on Monday").

**How to adapt:**
- Add **session segmentation** to `engram-insight`: group consecutive frames by application focus, idle gaps, or topic similarity into "sessions".
- Generate a **session-level summary** (like a storyboard caption) using local extractive summarization already in `engram-insight`.
- Index session summaries alongside frame-level records; expose a `session` search scope in the API.
- This makes queries like *"what was I working on Tuesday afternoon"* return a coherent session narrative, not a list of raw OCR snippets.

**Effort:** Medium. Builds on existing `engram-insight` extractive summarization.

---

### Opportunity 4: Two-Step Self-Evaluation for Task Automation (Medium Impact)

**VideoAgent's approach:** After each tool call, the system checks (1) did the tool succeed technically? and (2) does the result satisfy the user's original intent? Mismatches trigger re-planning.

**Engram's current state:** The 7-state task machine in `engram-action` has terminal `Failed` and `Completed` states but no reflection step — a task either finishes or errors out.

**How to adapt:**
- Add a `Reflect` state between `Executing` and `Completed`.
- In the `Reflect` state, check: did the action produce output? Does the output match the original intent (heuristically or via LLM)?
- If the check fails, transition to a `Retry` state that can re-plan with adjusted parameters (e.g., broaden a search query, try a different application target).
- Cap retry depth to prevent infinite loops.

**Effort:** Small-to-medium. Extends the existing state machine without replacing it.

---

### Opportunity 5: VideoRAG for Meeting Recordings (Niche but High Value)

**VideoAgent's approach:** Pre-process a video corpus offline — generate timestamped captions per segment, embed them, store in a vector DB. At query time, retrieve the most relevant segments.

**Engram's current state:** Engram already transcribes audio via Whisper locally. But transcriptions are stored as flat text, not segmented and indexed as a temporal vector store.

**How to adapt:**
- Treat audio transcription as a VideoRAG pipeline: chunk transcripts into ~30-second segments, embed each, store as a `TranscriptSegment` table in SQLite alongside the existing OCR store.
- Expose a `meeting` search scope in the API that retrieves relevant transcript segments with timestamps.
- This makes queries like *"what did they decide about the Q2 roadmap in yesterday's standup"* directly answerable.

**Effort:** Small. `engram-whisper` already produces text; it just needs chunking and vector indexing on output.

---

### Opportunity 6: Storyboard-Style Memory Digests (Lower Priority)

**VideoAgent's approach:** The Storyboard Agent produces a structured, scene-by-scene description of video content as a retrieval aid.

**Engram's current state:** `engram-insight` does extractive summarization but not session-level digest generation.

**How to adapt:**
- After each work session ends (detected by idle gap), run `engram-insight` to produce a "memory digest": a bulleted summary of what was on screen, what was said, and what was typed.
- Expose digests in the dashboard as a daily/weekly timeline view.
- Makes the memory more usable for retrospective review (like reading a journal entry about your day).

**Effort:** Small. Scheduling + formatting on top of existing summarization.

---

## Privacy Considerations

VideoAgent is fundamentally cloud-dependent — it sends video content to Claude, GPT-4o, Gemini, and DeepSeek. This is **incompatible with Engram's local-only guarantee** unless:

1. Local LLMs (Ollama, llama.cpp, LM Studio) are used as drop-in replacements for the cloud routing models.
2. The graph router and intent decomposition prompts are simple enough that a 7B–13B local model can handle them reliably.
3. Video/screen content never leaves the machine.

For the intent decomposition and graph routing tasks (Opportunities 1 and 2), local LLMs are entirely viable — these are structured JSON generation tasks that small models handle well. The multimodal tasks (Gemini captions, GPT-4o video editing) would require local vision models (LLaVA, moondream) if Engram ever processed actual video files.

---

## Recommended Roadmap

| Priority | Opportunity | Effort | Impact |
|---|---|---|---|
| 1 | **Transcript segmentation + meeting search** (VideoRAG for audio) | Small | High |
| 2 | **Temporal session segmentation** in `engram-insight` | Medium | High |
| 3 | **LLM-powered intent routing** (optional, local model) | Medium | High |
| 4 | **Self-evaluation `Reflect` state** in task machine | Medium | Medium |
| 5 | **Graph-based workflow engine** (`engram-workflow` crate) | Large | High (long-term) |
| 6 | **Memory digests** (session-end summaries) | Small | Medium |

The first two items require no LLM dependency and fit naturally into Engram's existing architecture. They can ship without any philosophical shift. Items 3–5 introduce optional local LLM support — a direction worth exploring as local models improve rapidly.

---

## Conclusion

VideoAgent is best understood as a *blueprint for agentic media memory systems*, not as a library to directly import. Its three core innovations — intent decomposition, graph workflow orchestration, and temporal retrieval (VideoRAG) — all have direct analogs in Engram's domain, just applied to screen/audio captures instead of video files.

The most Engram-compatible idea is the **VideoRAG pipeline adapted for meeting audio**: chunk Whisper transcripts into segments, embed them, and expose a `meeting` search scope. This delivers immediately useful functionality with minimal effort and zero privacy compromise.

The highest-ceiling idea is the **graph workflow engine with LLM routing**: this would transform Engram's task automation from a regex-matched command dispatcher into a genuinely agentic system capable of multi-step, multi-tool workflows driven by natural language. It is a large investment but aligns with where AI-native productivity tools are heading.

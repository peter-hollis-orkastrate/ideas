# Engram vs DeepNote-AI — Comparison Review

**Date:** 2026-02-24

---

## Summary

Engram and DeepNote-AI are **complementary rather than competitive** projects. Engram captures data passively and keeps everything local-only — no data ever leaves the machine. DeepNote-AI takes intentional user input and generates rich output using cloud AI providers.

The most impactful ideas for Engram to borrow are **agentic RAG with source citations** and **content generation tools** — these would elevate Engram's chat and insight capabilities without compromising its local-only privacy model. Conversely, DeepNote-AI would benefit most from Engram's **ambient capture pipeline** and **PII redaction system**.

Adding optional cloud LLM support remains a high-value opportunity but represents a philosophical shift from "local-only" to "local-first with optional cloud" — a decision that should be weighed carefully against Engram's core value proposition.

---

## Overview

| | **Engram** | **DeepNote-AI** |
|---|---|---|
| **Repository** | [peter-hollis-orkastrate/engram](https://github.com/peter-hollis-orkastrate/engram) | [Clemens865/DeepNote-AI](https://github.com/Clemens865/DeepNote-AI) |
| **Core idea** | Local-only screen memory system — continuously captures what you *see and hear*, indexes it, makes it searchable | Cloud-dependent AI research workstation — you *upload* documents, chat with them, and generate new content from them |
| **Data source** | Passive/ambient: screen OCR, audio capture, voice dictation | Active/intentional: user uploads PDFs, DOCX, URLs, YouTube transcripts, audio files |
| **Primary metaphor** | "Total recall for your desktop" (like Microsoft Recall / Rewind.ai) | "Your own NotebookLM" (like Google NotebookLM) |
| **Language** | Rust (14-crate workspace) | TypeScript/Electron (React frontend) |
| **Platform** | Windows-only (Win32/WinRT APIs) | Cross-platform (Electron) |
| **AI approach** | All local — ONNX embeddings, Whisper.cpp, regex-based NLP. No API keys needed. | Cloud-dependent — requires API keys for Gemini, Claude, OpenAI, or Groq. Local ONNX only used as fallback for embeddings. |
| **Database** | SQLite + WAL + FTS5 + HNSW vector index | SQLite (better-sqlite3) + Drizzle ORM + ONNX vector store |
| **Privacy model** | **Local-only** — no data ever leaves the machine, no network calls, PII redaction | Local storage, but sends data to cloud AI providers for inference. No PII handling. |
| **Maturity** | 6 phases complete, 1,325 tests, 27 ADRs | Public beta, ~40 commits |

---

## Where They Overlap

1. **Hybrid search** — both combine semantic (vector) search with keyword search
2. **Local embeddings** — both use ONNX Runtime with small transformer models for on-device vector generation
3. **SQLite as the backbone** — both chose SQLite for persistence
4. **Voice/audio processing** — Engram has Whisper.cpp transcription; DeepNote-AI ingests audio files and has voice Q&A
5. **Chat interface over indexed content** — both let you ask natural language questions about your data
6. **System tray integration** — both run as background desktop apps with tray access

---

## Where They Diverge

| Dimension | **Engram** | **DeepNote-AI** |
|---|---|---|
| **Input model** | Zero-effort, ambient capture | Intentional document upload |
| **Privacy** | Local-only — no data leaves the machine, PII redaction, localhost-only API | Local storage but cloud-dependent for intelligence — data is sent to AI providers |
| **Content generation** | Extractive summaries, daily digests, entity extraction | 15+ studio tools (podcasts, slide decks, whitepapers, flashcards, mind maps, infographics, etc.) |
| **AI providers** | Fully offline (no API keys needed) | Requires API keys for Gemini/Claude/OpenAI/Groq |
| **RAG sophistication** | Regex-based NLP parser (40+ patterns) | Agentic multi-query RAG with source citations |
| **Output quality pipeline** | None | Research, Write, Review multi-agent pipeline with retry middleware |
| **Visual content** | Web dashboard (8 tabs) | Rich React UI with charts (Recharts), diagrams (Mermaid), flow graphs (@xyflow), drag-and-drop editors |
| **Intelligence ownership** | *Owned* — runs on local models, no recurring costs | *Rented* — depends on cloud provider availability and pricing |

---

## Ideas From DeepNote-AI That Engram Should Consider

### 1. Agentic RAG with Source Citations (High Value)

Engram's current chat uses regex-based NLP parsing. DeepNote-AI's agentic RAG rewrites queries into multiple sub-queries, retrieves from different angles, and returns answers **with inline source citations**. This is a major UX improvement — users can verify where an answer came from. Even with local models, Engram could implement citation linking back to specific screen captures or audio segments.

### 2. Content Generation Studio (Medium Value)

DeepNote-AI's studio generates 15+ content types from source material. Engram already has daily digests and Obsidian export. Consider adding:

- **Flashcard generation** from captured content (great for learning workflows)
- **Weekly/project reports** auto-generated from screen activity
- **Mind map visualization** of topic clusters (Engram already does topic clustering — visualizing it is the natural next step)
- **Timeline view** of captured activity

### 3. AI Output Validation Middleware (Medium Value)

DeepNote-AI has an `aiMiddleware.ts` that validates AI-generated output format and automatically retries malformed responses. As Engram evolves its intelligence layer, this pattern of structured output validation with retry is worth adopting — particularly for summarization and entity extraction where output format matters.

### 4. Rich Document Ingestion (Medium Value)

Engram captures what's *on screen* but doesn't let users intentionally add documents. Adding the ability to ingest PDFs, DOCX, or URLs directly would complement the ambient capture — users could say "index this PDF alongside my screen history" for richer context.

### 5. Cross-Session Memory with Confidence Scoring (Low-Medium Value)

DeepNote-AI's `memory.ts` maintains learned patterns and preferences across chat sessions with confidence scores. Engram's chat has session persistence but could benefit from remembering user preferences and frequently-asked-about topics across sessions.

### 6. Multi-Provider AI Support (High Value but Philosophical Change)

DeepNote-AI lets users swap between Gemini, Claude, OpenAI, and Groq per conversation. Engram's local-only approach is a core differentiator — no data ever leaves the machine, no API keys, no recurring costs. Offering optional cloud LLM integration would dramatically improve chat quality and summarization, but it would shift Engram from **local-only** to **local-first with optional cloud**. That is a philosophical change, not just a feature flag.

Considerations:

- Engram's intelligence is *owned*; DeepNote-AI's is *rented*. As local models improve (Llama, Phi, Mistral), Engram's architecture is better positioned to benefit without changing its privacy model.
- If pursued, cloud support should be behind an explicit opt-in with clear messaging about what data leaves the machine.
- The PII redaction system would need to be applied before any data is sent to a cloud provider.
- This could be positioned as a separate "Engram Pro" mode rather than changing the default behaviour.

---

## Things in Engram That DeepNote-AI Could Use

### 1. Ambient Screen Capture + OCR Pipeline

DeepNote-AI requires users to manually upload content. Engram's continuous screen capture with OCR would let DeepNote-AI passively index everything a researcher sees — papers they read in the browser, Slack messages, emails — without manual upload. This is Engram's single biggest differentiator.

### 2. PII Redaction System

Engram automatically detects and redacts credit cards, SSNs, emails, and phone numbers. DeepNote-AI sends user content to cloud AI providers with no mention of PII handling. Engram's redaction layer would be particularly valuable applied before any data leaves the machine.

### 3. Safety-Gated Action Execution

Engram's action engine has a 7-state task lifecycle with mandatory user confirmation before executing actions. DeepNote-AI has no equivalent safety layer for its generation pipeline. As DeepNote-AI adds more autonomous features, this pattern would prevent unintended actions.

### 4. Event-Driven Architecture (49 Domain Events)

Engram's event system with SSE streaming is more sophisticated than DeepNote-AI's IPC-based communication. The event-driven approach would allow DeepNote-AI to add real-time reactivity — for example, automatically re-indexing when a linked file changes.

### 5. Tiered Data Retention with Automatic Purging

Engram has configurable retention windows (default 90 days) with automatic data tiering and purging. DeepNote-AI has no data lifecycle management — notebooks just accumulate. For a research tool that ingests large documents, this would help manage storage.

### 6. Comprehensive Test Suite and ADR Documentation

Engram has 1,325 tests and 27 Architecture Decision Records. DeepNote-AI appears to have minimal testing infrastructure. Engram's disciplined approach to testing and documenting architectural decisions is something any project would benefit from adopting.

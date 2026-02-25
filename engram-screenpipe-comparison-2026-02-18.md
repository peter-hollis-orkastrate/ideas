# Screenpipe vs Engram: Where Does Engram Actually Fit?

Internal ideation notes. Not a pitch, not marketing -- just honest thinking about where Engram sits in the intelligence stack and whether it makes sense to keep building it.

---

## The Intelligence Stack

There's a useful way to think about personal AI memory systems as a four-stage stack. Most projects cluster at the bottom. Almost nobody is working on the top.

### Stage 1: Raw Data Capture

Screen recording, audio capture, OCR, keystroke logging. The firehose. This is where Screenpipe lives and it does it well -- cross-platform, HEVC video, plugin system, MCP server, the works. It's a mature, community-backed project with real momentum.

The thing about Stage 1 is that it's necessary but not sufficient. Recording everything is the easy conceptual leap. The hard part is making any of it useful after the fact.

### Stage 2: Structured Memory

Taking the raw capture and organizing it into queryable, contextualized knowledge. This means semantic search (not just keyword matching), entity extraction, topic clustering, temporal relationships between events. Turning "I saw something about X last Tuesday" into an actual retrievable answer.

This is where things start getting genuinely hard. Raw data is cheap. Structured memory requires understanding what matters, how things relate to each other, and what level of detail to preserve vs. discard.

### Stage 3: Pattern Recognition

Identifying habits, recurring workflows, context switches, productivity patterns, communication rhythms. Not just "what happened" but "what keeps happening" and "what does that mean."

This layer is where personal AI stops being a search tool and starts being an understanding tool. It requires sustained observation over time and the ability to surface patterns the user hasn't explicitly asked about.

### Stage 4: Predictive/Proactive Intelligence

Anticipating needs before the user asks. Surfacing relevant context before a meeting based on calendar + past interactions. Noticing you've been stuck on something and pulling up what helped last time. Pre-fetching information based on time-of-day patterns.

Nobody has cracked this. It's the hardest stage by a wide margin, and it's where the real value lives.

---

## Where Each Project Sits

**Screenpipe** is wide and deep at Stage 1. It records screens, audio, does OCR, supports multiple platforms, has a plugin ecosystem (pipes), and integrates with AI tools via MCP. Its pipes are mostly Stage 1 extensions -- different ways to capture or format data, not fundamentally different ways to understand it. Screenpipe is explicitly positioned as infrastructure: "we capture everything, you build on top."

**Engram** is focused on Stages 2-4. Semantic vector search with hybrid retrieval, automated insight pipelines (summarization, entity extraction, topic clustering, daily digests), and voice dictation that injects output back into the user's workflow. It's narrower on capture (Windows-only, no video timeline) but deeper on intelligence.

The key insight: these aren't really competitors. They operate at different layers of the stack.

---

## Why Stages 2-4 Are Harder (and More Valuable) Than Stage 1

Stage 1 is an engineering problem. It's hard engineering -- cross-platform screen capture, efficient video encoding, real-time OCR -- but it's well-understood. The inputs and outputs are clear. You record stuff, you store it, you make it searchable by timestamp and keyword.

Stages 2-4 are research problems disguised as engineering problems. Consider:

- **Structured memory** requires decisions about what to keep, how to connect it, and how to degrade it over time. There's no single right answer. The optimal memory structure depends on the user's work patterns, which you don't know in advance.

- **Pattern recognition** requires enough historical data to be meaningful, but the patterns you're looking for aren't predefined. You're doing unsupervised discovery on someone's digital life. False positives are annoying. False negatives mean the system feels useless.

- **Predictive intelligence** requires all of the above plus the confidence to act on predictions. Getting it wrong isn't neutral -- it's actively disruptive. The bar for "helpful" is much higher than "I found what you searched for."

This is why Screenpipe's plugin ecosystem hasn't organically produced Stage 2-4 capabilities. It's not a gap the community overlooked -- it's a fundamentally different kind of problem that doesn't emerge naturally from a capture-focused architecture.

---

## Engram Doesn't Need to Compete with Screenpipe

The pragmatic framing: Engram could sit on top of Screenpipe (or any capture layer). The capture layer is becoming commoditized. There will be more Screenpipe-like tools. OS vendors will eventually build this in (Apple is already moving in this direction with Apple Intelligence).

What won't be commoditized quickly:

- A personal semantic memory layer that actually works
- Pattern recognition tuned to individual workflows
- Proactive intelligence that earns the user's trust over time

Engram's value proposition isn't "we also record your screen." It's "we make recorded data actually useful in ways nobody else is building."

If Screenpipe (or Apple, or Microsoft Recall, or whoever) wins the capture layer, that's fine. That just means Engram has more raw data to work with.

---

## The Pragmatic Perspective: Side Project Discipline

Reality check: there are already 2 SaaS companies to run. Engram is a side project and should stay that way -- for now.

The trap with side projects that feel important is premature scaling. Hiring, fundraising, building a team, doing marketing -- all before the thing has proven it's indispensable. That kills side projects faster than neglect does.

The better approach:

1. **Build it for yourself first.** Use it every day. Not as a demo, as an actual tool in your workflow.
2. **Wait for the signal.** The signal isn't "this is cool" or "people on Twitter like it." The signal is: **if someone took this away from you, would you be angry?** Not disappointed -- angry. That's when a side project has earned the right to be more.
3. **Keep it lean.** No infrastructure costs that scale with zero users. No features built for hypothetical customers. Every feature should solve a problem you personally have today.
4. **Let the 2 SaaS companies fund the R&D.** Engram benefits from patience. The intelligence stack isn't a race because nobody else is seriously building Stages 2-4. There's time to get it right.

The worst outcome isn't "Engram stays a side project forever." The worst outcome is burning out on a third company that wasn't ready to be a company.

---

## The Signal to Watch For

When Engram surfaces something you didn't search for, and it's exactly what you needed -- that's Stage 3 working.

When Engram prepares context for your day before you sit down at the keyboard -- that's Stage 4 working.

When either of those things happens and you think "I would pay serious money to keep this" -- that's the signal. Not before.

Until then, it's a side project, and that's not a demotion. It's discipline.

---

## Open Source vs SaaS: Future Considerations

This decision doesn't need to be made now, but worth thinking about:

**Arguments for open source (like Screenpipe):**
- Community contributions accelerate development
- Trust factor is higher for a tool that records your screen and processes your data
- Screenpipe has proven this model works for Stage 1
- Engram is a side project -- open source means it can survive periods of low attention from the maintainer

**Arguments for SaaS / closed source:**
- Stages 2-4 are the hard part. Giving away the hard part while the easy part (capture) is already open source doesn't build a business.
- A SaaS model creates recurring revenue that could eventually justify Engram becoming more than a side project.
- The intelligence layer is personal and opinionated. It benefits from a curated experience more than a plugin-based one.

**A middle path:**
- Open source the core memory/search layer (Stage 2). This builds trust and community.
- Keep the intelligence layer (Stages 3-4) proprietary. This is where the moat is. Pattern recognition tuned to an individual and predictive intelligence that improves over time are hard to replicate even with access to the source code, because the value is in the accumulated model of the user, not the algorithm.

---

## The Moat

Worth saying plainly: Stage 4 intelligence is the moat, and it's a real one.

Cross-platform screen capture is engineering. Someone with enough time and resources can replicate Screenpipe. Video timelines, plugin systems, MCP integration -- these are features, not defensibility.

A predictive layer that genuinely understands your work patterns, anticipates your needs, and improves over time? That requires:

- Sustained personal data (can't be replicated by a new entrant)
- Sophisticated pattern recognition (not a weekend project)
- User trust earned through consistent accuracy (can't be shortcut)
- Taste in what to surface and when (the hardest design problem in the stack)

If Engram gets Stage 4 right, it doesn't matter who wins Stage 1. The capture layer becomes a commodity input. The intelligence layer is the product.

That's the bet. It's a long one, and it should stay a side project until the signal says otherwise. But it's the right bet.

---

*These are working notes. Revisit when Engram has been in daily personal use for 30+ days and reassess whether the intelligence stack thesis holds up against actual usage patterns.*

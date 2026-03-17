# Claude Code OAuth + Paperclip Integration Analysis

**Date:** 2026-03-17
**Repo:** https://github.com/paperclipai/paperclip

## Question

Can Claude Code OAuth be used with paperclipai/paperclip?

## Short Answer

**No.** Anthropic explicitly prohibits third-party applications from using Claude Code's OAuth system.

## Details

### What Claude Code OAuth Is

Claude Code authenticates users via OAuth through `claude.ai/oauth/authorize`, issuing tokens with the `sk-ant-oat01-` prefix. These tokens are tied to Claude.ai Pro/Max subscriptions and count against subscription quotas.

### Why It Can't Be Used by Paperclip

1. **Policy violation**: Using OAuth tokens from Claude Free/Pro/Max accounts in any product other than Claude Code and Claude.ai violates Anthropic's Consumer Terms of Service.

2. **Enforced since January 2026**: Anthropic deployed server-side blocks in January 2026 that actively reject OAuth tokens used in third-party tools. Tools like OpenCode (56k+ stars) and others were blocked overnight.

3. **No public OAuth provider**: Anthropic does not offer a public OAuth provider endpoint for third-party apps to authenticate users and obtain Claude API access.

### Why Anthropic Made This Change

Third-party tools could bypass the rate limiting built into Claude Code subscriptions, enabling overnight autonomous loops and consuming far more tokens than the subscription price justified.

## Recommended Alternative for Paperclip

| Approach | How |
|----------|-----|
| **User-provided API keys** | Ask users to provide their own Claude Console API keys (paid, per-token billing via `console.anthropic.com`) |
| **AWS Bedrock** | Integrate with Claude via Amazon Bedrock for enterprise deployments |
| **Google Vertex AI** | Integrate with Claude via Google Cloud Vertex AI |
| **Direct API** | Use `ANTHROPIC_API_KEY` from Claude Console — this is the supported path for third-party tools |

## Conclusion for Paperclip

Paperclip should not attempt to use Claude Code OAuth. The correct integration path is:
- Require users to supply their own Anthropic API keys from [console.anthropic.com](https://console.anthropic.com)
- Or integrate via Bedrock/Vertex for enterprise/cloud deployments

This is also more aligned with Paperclip's model of orchestrating teams of agents — enterprise customers are better served by API-key or cloud-provider auth anyway.

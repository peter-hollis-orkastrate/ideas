/**
 * Ollama Local VLM + OCR Configuration
 *
 * Replaces the former Gemini API configuration.
 * No API key required — Ollama runs locally.
 *
 * Two separate model slots mirror the original two-model design:
 *   OLLAMA_VLM_MODEL  — image analysis / description  (replaces Gemini)
 *   OLLAMA_OCR_MODEL  — document text extraction assist (replaces Datalab AI)
 */

import { z } from 'zod';

export const OLLAMA_MODELS = {
  // Good all-round vision models
  LLAVA: 'llava',
  LLAVA_LLAMA3: 'llava-llama3',
  // Compact / fast options
  MINICPM_V: 'minicpm-v',
  MOONDREAM: 'moondream2',
} as const;

// Kept for interface compatibility with callers that reference GEMINI_MODELS
export const GEMINI_MODELS = {
  FLASH_3: OLLAMA_MODELS.LLAVA,
} as const;

export type GeminiModelId = string;

// Kept for interface compatibility — Ollama has no hard rate limits
export const GEMINI_RATE_LIMIT = {
  RPM: 999_999,
  TPM: 999_999_999,
} as const;

// ThinkingLevel kept for interface compat (ignored by Ollama)
export type ThinkingLevel = 'HIGH' | 'MEDIUM' | 'LOW' | 'MINIMAL';
export type GeminiMode = 'fast' | 'thinking' | 'multimodal';

// Allowed MIME types for FileRef
export const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf',
] as const;

export type AllowedMimeType = (typeof ALLOWED_MIME_TYPES)[number];

// Max file size: 20MB
export const MAX_FILE_SIZE = 20 * 1024 * 1024;

// MediaResolution kept for interface compat (ignored by Ollama)
export type MediaResolution = 'MEDIA_RESOLUTION_HIGH' | 'MEDIA_RESOLUTION_LOW';

// Configuration schema for Ollama
export const GeminiConfigSchema = z.object({
  // Ollama server
  baseUrl: z.string().default('http://localhost:11434'),

  // VLM model — used for image analysis / description (replaces Gemini)
  // Set via OLLAMA_VLM_MODEL. Needs vision support (e.g. llava, llava-llama3, minicpm-v).
  vlmModel: z.string().default(OLLAMA_MODELS.LLAVA),

  // OCR-assist model — used for document text extraction tasks (replaces Datalab AI layer)
  // Set via OLLAMA_OCR_MODEL. Can be any capable text model; a vision model is better
  // for scanned/handwritten docs. Defaults to the same model as vlmModel when unset.
  ocrModel: z.string().default(OLLAMA_MODELS.LLAVA),

  // `model` kept for internal use — set to vlmModel by loadGeminiConfig()
  model: z.string().default(OLLAMA_MODELS.LLAVA),

  // Generation defaults
  maxOutputTokens: z.number().default(8192),
  temperature: z.number().min(0).max(2).default(0.1),
  // mediaResolution kept for interface compat
  mediaResolution: z
    .enum(['MEDIA_RESOLUTION_HIGH', 'MEDIA_RESOLUTION_LOW'])
    .default('MEDIA_RESOLUTION_HIGH'),

  // Retry configuration
  retry: z
    .object({
      maxAttempts: z.number().default(3),
      baseDelayMs: z.number().default(500),
      maxDelayMs: z.number().default(10000),
    })
    .default({}),

  // Circuit breaker
  circuitBreaker: z
    .object({
      failureThreshold: z.number().default(5),
      recoveryTimeMs: z.number().default(60000),
    })
    .default({}),

  // apiKey kept as optional for interface compat (not used)
  apiKey: z.string().optional().default('not-required'),
});

export type GeminiConfig = z.infer<typeof GeminiConfigSchema>;

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid numeric env var ${name}: "${raw}"`);
  }
  return parsed;
}

/**
 * Load Ollama configuration from environment variables.
 *
 * Environment variables:
 *   OLLAMA_BASE_URL   — Ollama server URL (default: http://localhost:11434)
 *   OLLAMA_VLM_MODEL  — Vision model for image analysis (default: llava)
 *   OLLAMA_OCR_MODEL  — Model for OCR text-extraction tasks (default: llava)
 *   OLLAMA_TEMPERATURE — Generation temperature (default: 0.1)
 */
export function loadGeminiConfig(overrides?: Partial<GeminiConfig>): GeminiConfig {
  const vlmModel =
    overrides?.vlmModel ??
    process.env.OLLAMA_VLM_MODEL ??
    // Legacy single-model fallback
    process.env.OLLAMA_MODEL ??
    OLLAMA_MODELS.LLAVA;

  const ocrModel =
    overrides?.ocrModel ??
    process.env.OLLAMA_OCR_MODEL ??
    // Fall back to the VLM model if no dedicated OCR model is set
    vlmModel;

  const envConfig = {
    baseUrl: overrides?.baseUrl ?? process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434',
    vlmModel,
    ocrModel,
    model: vlmModel, // `model` used by analyzeImage() — always the VLM model
    maxOutputTokens: parseIntEnv('OLLAMA_MAX_OUTPUT_TOKENS', 8192),
    temperature: process.env.OLLAMA_TEMPERATURE ? parseFloat(process.env.OLLAMA_TEMPERATURE) : 0.1,
    apiKey: 'not-required',
  };

  return GeminiConfigSchema.parse({ ...envConfig, ...overrides });
}

/**
 * Generation config presets — kept for interface compat, values map to Ollama settings.
 */
export const GENERATION_PRESETS = {
  fast: {
    temperature: 0.0,
    maxOutputTokens: 4096,
    responseMimeType: 'application/json' as const,
    thinkingConfig: { thinkingLevel: 'MINIMAL' as ThinkingLevel },
  },
  thinking: (level: ThinkingLevel = 'HIGH') => ({
    temperature: 0.1,
    maxOutputTokens: 8192,
    thinkingConfig: { thinkingLevel: level },
  }),
  multimodal: {
    temperature: 0.1,
    maxOutputTokens: 8192,
    responseMimeType: 'application/json' as const,
    thinkingConfig: { thinkingLevel: 'MINIMAL' as ThinkingLevel },
  },
} as const;


/**
 * Ollama Local VLM Client
 *
 * Drop-in replacement for the former GeminiClient.
 * Connects to a locally running Ollama instance — no API key required.
 *
 * Start Ollama and pull a vision model before use:
 *   ollama serve
 *   ollama pull llava          # or: llava-llama3, minicpm-v, moondream2
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  type GeminiConfig,
  loadGeminiConfig,
  ALLOWED_MIME_TYPES,
  MAX_FILE_SIZE,
  type ThinkingLevel,
  type AllowedMimeType,
  type MediaResolution,
} from './config.js';
import { CircuitBreaker, CircuitBreakerOpenError } from './circuit-breaker.js';

// Re-export error type for callers
export { CircuitBreakerOpenError };

// ---- Shared singletons ----
let _sharedClient: GeminiClient | null = null;
let _sharedCircuitBreaker: CircuitBreaker | null = null;

function getSharedCircuitBreaker(config: {
  failureThreshold: number;
  recoveryTimeMs: number;
}): CircuitBreaker {
  if (!_sharedCircuitBreaker) {
    _sharedCircuitBreaker = new CircuitBreaker(config);
  }
  return _sharedCircuitBreaker;
}

/**
 * Get a shared GeminiClient (Ollama) singleton.
 */
export function getSharedClient(): GeminiClient {
  if (!_sharedClient) {
    _sharedClient = new GeminiClient();
  }
  return _sharedClient;
}

/** Reset all shared state (for testing) */
export function resetSharedClient(): void {
  _sharedCircuitBreaker = null;
  _sharedClient = null;
}

/**
 * Token usage from a response
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  thinkingTokens: number;
  totalTokens: number;
}

/**
 * Response from VLM (mirrors former GeminiResponse interface)
 */
export interface GeminiResponse {
  text: string;
  usage: TokenUsage;
  model: string;
  processingTimeMs: number;
}

/**
 * File reference for multimodal requests
 */
export interface FileRef {
  mimeType: AllowedMimeType;
  data: string; // Base64 encoded
  sizeBytes: number;
}

// Internal generation options (kept for interface compat)
interface GenerationOptions {
  temperature?: number;
  maxOutputTokens?: number;
  responseMimeType?: 'application/json' | 'text/plain';
  responseSchema?: object;
  thinkingConfig?: { thinkingLevel: ThinkingLevel };
  mediaResolution?: MediaResolution;
  requestTimeout?: number;
}

/**
 * Ollama chat API response shape
 */
interface OllamaChatResponse {
  model: string;
  message: {
    role: string;
    content: string;
  };
  done: boolean;
  done_reason?: string;
  eval_count?: number;
  prompt_eval_count?: number;
  total_duration?: number;
}

/**
 * GeminiClient — implemented using Ollama for local inference.
 *
 * The public API is identical to the former Gemini-based client so that
 * callers (VLMService, tools, etc.) require no changes.
 */
export class GeminiClient {
  private readonly config: GeminiConfig;
  private readonly circuitBreaker: CircuitBreaker;

  constructor(configOverrides?: Partial<GeminiConfig>) {
    this.config = loadGeminiConfig(configOverrides);
    this.circuitBreaker = getSharedCircuitBreaker({
      failureThreshold: this.config.circuitBreaker.failureThreshold,
      recoveryTimeMs: this.config.circuitBreaker.recoveryTimeMs,
    });
  }

  /**
   * Fast mode: text-only prompt with optional JSON schema
   */
  async fast(
    prompt: string,
    schema?: object,
    options?: { maxOutputTokens?: number; requestTimeout?: number }
  ): Promise<GeminiResponse> {
    return this.generateText(prompt, {
      temperature: 0.0,
      maxOutputTokens: options?.maxOutputTokens ?? 4096,
      responseSchema: schema,
      requestTimeout: options?.requestTimeout,
    });
  }

  /**
   * Thinking mode: kept for interface compat, behaves same as fast for Ollama
   */
  async thinking(prompt: string, _level: ThinkingLevel = 'HIGH'): Promise<GeminiResponse> {
    return this.generateText(prompt, { temperature: 0.1, maxOutputTokens: 8192 });
  }

  /**
   * Multimodal mode: analyze image with prompt
   */
  async analyzeImage(
    prompt: string,
    file: FileRef,
    options: {
      schema?: object;
      mediaResolution?: MediaResolution;
      thinkingConfig?: { thinkingLevel: ThinkingLevel };
    } = {}
  ): Promise<GeminiResponse> {
    const startTime = Date.now();

    const schemaInstruction = options.schema
      ? `\n\nYou MUST respond with valid JSON only. No explanation, no markdown fences — just the raw JSON object matching this schema:\n${JSON.stringify(options.schema, null, 2)}`
      : '';

    const fullPrompt = prompt + schemaInstruction;

    const response = await this.circuitBreaker.execute(() =>
      this.executeWithRetry(() =>
        this.callOllamaChat(fullPrompt, file.data, {
          temperature: this.config.temperature,
          maxOutputTokens: this.config.maxOutputTokens,
          requestTimeout: 120_000,
        })
      )
    );

    return {
      ...response,
      processingTimeMs: Date.now() - startTime,
    };
  }

  /**
   * Analyze a PDF document (delegates to analyzeImage)
   */
  async analyzePDF(prompt: string, file: FileRef, schema?: object): Promise<GeminiResponse> {
    if (file.mimeType !== 'application/pdf') {
      throw new Error('File must be a PDF (application/pdf)');
    }
    return this.analyzeImage(prompt, file, { schema });
  }

  /**
   * Text-only generation (no image)
   */
  private async generateText(
    prompt: string,
    options: GenerationOptions
  ): Promise<GeminiResponse> {
    const startTime = Date.now();

    const schemaInstruction = options.responseSchema
      ? `\n\nRespond with valid JSON matching: ${JSON.stringify(options.responseSchema)}`
      : '';

    const response = await this.circuitBreaker.execute(() =>
      this.executeWithRetry(() =>
        this.callOllamaGenerate(prompt + schemaInstruction, options)
      )
    );

    return {
      ...response,
      processingTimeMs: Date.now() - startTime,
    };
  }

  /**
   * Call Ollama /api/chat with an image (multimodal)
   */
  private async callOllamaChat(
    prompt: string,
    imageBase64: string,
    options: { temperature?: number; maxOutputTokens?: number; requestTimeout?: number }
  ): Promise<Omit<GeminiResponse, 'processingTimeMs'>> {
    const url = `${this.config.baseUrl}/api/chat`;
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      options.requestTimeout ?? 120_000
    );

    let rawResponse: Response;
    try {
      rawResponse = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.config.model,
          messages: [
            {
              role: 'user',
              content: prompt,
              images: [imageBase64],
            },
          ],
          stream: false,
          options: {
            temperature: options.temperature ?? this.config.temperature,
            num_predict: options.maxOutputTokens ?? this.config.maxOutputTokens,
          },
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!rawResponse.ok) {
      const body = await rawResponse.text().catch(() => '');
      throw new Error(
        `Ollama API error ${rawResponse.status}: ${rawResponse.statusText}. ${body.slice(0, 200)}`
      );
    }

    const data = (await rawResponse.json()) as OllamaChatResponse;
    const text = data.message?.content ?? '';
    const inputTokens = data.prompt_eval_count ?? 0;
    const outputTokens = data.eval_count ?? 0;

    return {
      text,
      model: this.config.model,
      usage: {
        inputTokens,
        outputTokens,
        cachedTokens: 0,
        thinkingTokens: 0,
        totalTokens: inputTokens + outputTokens,
      },
    };
  }

  /**
   * Call Ollama /api/generate for text-only prompts
   */
  private async callOllamaGenerate(
    prompt: string,
    options: GenerationOptions
  ): Promise<Omit<GeminiResponse, 'processingTimeMs'>> {
    const url = `${this.config.baseUrl}/api/generate`;
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      options.requestTimeout ?? 60_000
    );

    interface OllamaGenerateResponse {
      model: string;
      response: string;
      done: boolean;
      eval_count?: number;
      prompt_eval_count?: number;
    }

    let rawResponse: Response;
    try {
      rawResponse = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.config.model,
          prompt,
          stream: false,
          options: {
            temperature: options.temperature ?? this.config.temperature,
            num_predict: options.maxOutputTokens ?? this.config.maxOutputTokens,
          },
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!rawResponse.ok) {
      const body = await rawResponse.text().catch(() => '');
      throw new Error(
        `Ollama API error ${rawResponse.status}: ${rawResponse.statusText}. ${body.slice(0, 200)}`
      );
    }

    const data = (await rawResponse.json()) as OllamaGenerateResponse;
    const text = data.response ?? '';
    const inputTokens = data.prompt_eval_count ?? 0;
    const outputTokens = data.eval_count ?? 0;

    return {
      text,
      model: this.config.model,
      usage: {
        inputTokens,
        outputTokens,
        cachedTokens: 0,
        thinkingTokens: 0,
        totalTokens: inputTokens + outputTokens,
      },
    };
  }

  /**
   * Execute a request function with exponential backoff retry
   */
  private async executeWithRetry<T>(
    fn: () => Promise<T>
  ): Promise<T> {
    const { maxAttempts, baseDelayMs, maxDelayMs } = this.config.retry;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error as Error;
        const msg = lastError.message;

        // Ollama may return 503 when model is still loading
        const isRetryable = /503|502|500|ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed|model.*load/i.test(msg);

        if (attempt < maxAttempts - 1 && isRetryable) {
          const delay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
          console.error(
            `[OllamaClient] Attempt ${attempt + 1}/${maxAttempts} failed: ${msg}. Retrying in ${delay}ms...`
          );
          await this.sleep(delay);
        } else if (!isRetryable) {
          throw lastError;
        }
      }
    }

    throw lastError ?? new Error('All retry attempts failed');
  }

  /**
   * Create FileRef from a file path (same interface as former GeminiClient)
   */
  static fileRefFromPath(filePath: string): FileRef {
    const ext = path.extname(filePath).toLowerCase().slice(1);

    const mimeTypes: Record<string, AllowedMimeType> = {
      pdf: 'application/pdf',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
    };

    const mimeType = mimeTypes[ext];
    if (!mimeType) {
      throw new Error(
        `Unsupported image format for VLM: '${ext}' (file: ${path.basename(filePath)}). ` +
          `Ollama vision accepts: png, jpg, jpeg, gif, webp. ` +
          `Convert the image first (e.g. imagemagick: convert file.tiff file.png).`
      );
    }

    let sizeBytes: number;
    let data: string;
    {
      const buffer = fs.readFileSync(filePath);
      if (buffer.length > MAX_FILE_SIZE) {
        throw new Error(`File too large: ${buffer.length} bytes. Max: ${MAX_FILE_SIZE} (20MB)`);
      }
      sizeBytes = buffer.length;
      data = buffer.toString('base64');
    }

    return { mimeType, data, sizeBytes };
  }

  /**
   * Create FileRef from a buffer
   */
  static fileRefFromBuffer(buffer: Buffer, mimeType: AllowedMimeType): FileRef {
    if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
      throw new Error(
        `Unsupported MIME type: ${mimeType}. Allowed: ${ALLOWED_MIME_TYPES.join(', ')}`
      );
    }
    if (buffer.length > MAX_FILE_SIZE) {
      throw new Error(`File too large: ${buffer.length} bytes. Max: ${MAX_FILE_SIZE} (20MB)`);
    }
    return { mimeType, data: buffer.toString('base64'), sizeBytes: buffer.length };
  }

  /**
   * Create cached content — no-op for Ollama (no server-side caching).
   * Returns a local cache key for interface compat.
   */
  async createCachedContent(contextText: string, _ttlSeconds: number = 3600): Promise<string> {
    const cacheId = `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this._contextCache.set(cacheId, contextText.slice(0, 8000));
    console.error(`[OllamaClient] Created local context cache ${cacheId}`);
    return cacheId;
  }

  private readonly _contextCache = new Map<string, string>();

  /**
   * Generate using cached context (prepends context to prompt)
   */
  async generateWithCache(
    cacheId: string,
    prompt: string,
    file: FileRef,
    options: { schema?: object; mediaResolution?: MediaResolution } = {}
  ): Promise<GeminiResponse> {
    const cached = this._contextCache.get(cacheId);
    if (!cached) {
      throw new Error(`Cache not found: ${cacheId}. Create with createCachedContent() first.`);
    }
    const contextualPrompt = `Document context (from OCR):\n${cached}\n\n${prompt}`;
    return this.analyzeImage(contextualPrompt, file, options);
  }

  deleteCachedContent(cacheId: string): boolean {
    return this._contextCache.delete(cacheId);
  }

  /**
   * Batch analyze images sequentially
   */
  async batchAnalyzeImages(
    requests: Array<{
      prompt: string;
      file: FileRef;
      options?: { schema?: object; mediaResolution?: MediaResolution };
    }>,
    onProgress?: (completed: number, total: number) => void
  ): Promise<Array<{ index: number; result?: GeminiResponse; error?: string }>> {
    const results: Array<{ index: number; result?: GeminiResponse; error?: string }> = [];

    for (let i = 0; i < requests.length; i++) {
      try {
        const result = await this.analyzeImage(
          requests[i].prompt,
          requests[i].file,
          requests[i].options ?? {}
        );
        results.push({ index: i, result });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[OllamaClient] Batch item ${i}/${requests.length} failed: ${message}`);
        results.push({ index: i, error: message });
      }
      onProgress?.(i + 1, requests.length);
    }

    return results;
  }

  /**
   * Get client status
   */
  getStatus() {
    return {
      model: this.config.model,
      baseUrl: this.config.baseUrl,
      rateLimiter: { available: true, queueLength: 0 },
      circuitBreaker: this.circuitBreaker.getStatus(),
    };
  }

  reset(): void {
    this.circuitBreaker.reset();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

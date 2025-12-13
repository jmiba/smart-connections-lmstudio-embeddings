export type LmStudioSettings = {
  baseUrl: string;
  requestTimeoutMs: number;
  maxTokens: number;
  batchSize: number;
};

let settings: LmStudioSettings = {
  baseUrl: "http://127.0.0.1:1234",
  requestTimeoutMs: 120_000,
  maxTokens: 512,
  batchSize: 16
};

export function setLmStudioSettings(next: Partial<LmStudioSettings>) {
  settings = { ...settings, ...next };
}

function normalizeBaseUrl(url: string) {
  return String(url).trim().replace(/\/$/, "");
}

async function fetchJson(urlPath: string, init?: RequestInit) {
  const baseUrl = normalizeBaseUrl(settings.baseUrl);
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), settings.requestTimeoutMs);
  try {
    const res = await fetch(`${baseUrl}${urlPath}`, { ...init, signal: controller.signal });
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      throw new Error(`LM Studio HTTP ${res.status} ${res.statusText}${text ? `: ${text}` : ""}`);
    }
    return text ? JSON.parse(text) : null;
  } finally {
    window.clearTimeout(timeout);
  }
}

export type ProviderModelConfig = {
  id: string;
  name: string;
  model_key?: string;
  model?: string;
  description?: string;
  dims?: number;
  max_tokens?: number;
  batch_size?: number;
  use_gpu?: boolean;
  adapter: string;
};

let cachedModels: Record<string, ProviderModelConfig> = {};
let lastFetchedAt = 0;

export async function listModels(refresh = false) {
  const now = Date.now();
  if (!refresh && now - lastFetchedAt < 15_000 && Object.keys(cachedModels).length) return cachedModels;

  const data = await fetchJson("/v1/models");
  const models: any[] = Array.isArray((data as any)?.data) ? (data as any).data : [];

  const next: Record<string, ProviderModelConfig> = {};
  for (const m of models) {
    const id = String(m?.id ?? "").trim();
    if (!id) continue;
    next[id] = {
      id,
      name: id,
      model_key: id,
      model: id,
      description: "LM Studio local embedding model",
      max_tokens: settings.maxTokens,
      batch_size: settings.batchSize,
      use_gpu: false,
      adapter: "lmstudio"
    };
  }

  cachedModels = next;
  lastFetchedAt = now;
  return cachedModels;
}

function coerceToText(item: any): string {
  if (typeof item === "string") return item;
  const candidate =
    item?.embed_input ??
    item?.text ??
    item?.content ??
    item?.input ??
    item?.data?.embed_input ??
    item?.data?.text ??
    item?.data?.content ??
    null;
  if (typeof candidate === "string") return candidate;
  return "";
}

function normalizeBatchInputs(inputs: any[]): string[] {
  return inputs.map((item) => {
    const text = coerceToText(item);
    const trimmed = text.trim();
    return trimmed ? trimmed : " ";
  });
}


async function createEmbeddings(model: string, input: string | string[]) {
  // LM Studio is typically OpenAI-compatible. `encoding_format` improves compatibility
  // with newer servers that require an explicit output type.
  const body = JSON.stringify({ model, input, encoding_format: "float" });
  return await fetchJson("/v1/embeddings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body
  });
}

function extractEmbeddings(data: any): number[][] {
  const items: any[] = Array.isArray(data?.data) ? data.data : [];
  const out: number[][] = [];
  for (const it of items) {
    const emb = it?.embedding;
    if (!Array.isArray(emb)) throw new Error("LM Studio: invalid embedding response");
    out.push(emb);
  }
  return out;
}

async function embedOne(modelKey: string, text: string): Promise<number[]> {
  const data = await createEmbeddings(modelKey, text);
  const embeddings = extractEmbeddings(data);
  if (!embeddings[0]) throw new Error("LM Studio: empty embedding response");
  return embeddings[0];
}

function chunk<T>(items: T[], size: number) {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function estimateTokens(text: string) {
  const len = typeof text === "string" ? text.length : 0;
  return Math.max(1, Math.ceil(len / 4)); // rough heuristic; SC mainly needs non-zero
}

export class LmStudioEmbeddingAdapter {
  static adapter = "lmstudio";
  static batch_size = 16;
  model: any;
  state: "unloaded" | "loaded" = "unloaded";

  constructor(model: any) {
    this.model = model;
  }

  get models() {
    return cachedModels;
  }

  private coerceRefreshArg(arg: any): boolean {
    if (typeof arg === "boolean") return arg;
    if (arg && typeof arg === "object" && "refresh" in arg) return Boolean((arg as any).refresh);
    return false;
  }

  async get_models(refreshOrOpts: any = false) {
    const refresh = this.coerceRefreshArg(refreshOrOpts);
    const models = await listModels(refresh);
    if (this?.model?.data && (!this.model.data.provider_models || Object.keys(this.model.data.provider_models).length === 0)) {
      this.model.data.provider_models = models;
    }
    return models;
  }

  async load(refreshOrOpts: any = false) {
    await this.get_models(refreshOrOpts);
    this.state = "loaded";
    return this;
  }

  private async ensureModelKey(): Promise<string> {
    const candidate =
      this?.model?.data?.model_key ??
      this?.model?.data?.model ??
      this?.model?.data?.model_id ??
      this?.model?.data?.id ??
      this?.model?.model_key ??
      this?.model?.id ??
      null;

    const key = typeof candidate === "string" ? candidate.trim() : "";
    if (key) return key;

    await this.get_models(true);
    const fallback = Object.keys(cachedModels)[0]?.trim() ?? "";
    if (!fallback) throw new Error("LM Studio: no models available (GET /v1/models returned empty)");

    if (this?.model?.data) {
      this.model.data.model_key = fallback;
      this.model.data.model = fallback;
      this.model.debounce_save?.();
    }
    return fallback;
  }

  private padToLength(vectors: number[][], targetLength: number) {
    if (vectors.length >= targetLength) return vectors.slice(0, targetLength);
    const dims =
      (Number.isFinite(this?.model?.data?.dims) ? this.model.data.dims : null) ??
      (Number.isFinite(vectors[0]?.length) ? vectors[0].length : null) ??
      1536;
    const out = vectors.slice();
    for (let i = vectors.length; i < targetLength; i++) out.push(Array.from({ length: dims }, () => 0));
    return out;
  }

  private ensureBatchSize(): number {
    const fallback = settings.batchSize ?? 16;
    const candidate = Number(this?.model?.data?.batch_size);
    const valid = Number.isFinite(candidate) && candidate > 0 ? candidate : fallback;
    try {
      if (this?.model?.data) {
        if (!Number.isFinite(this.model.data.batch_size) || this.model.data.batch_size <= 0) this.model.data.batch_size = valid;
        if (!Number.isFinite(this.model.data.max_batch_size) || this.model.data.max_batch_size <= 0) this.model.data.max_batch_size = valid;
        this.model.debounce_save?.();
      }
    } catch {
      // ignore
    }
    return valid;
  }

  get batch_size() {
    return this.ensureBatchSize();
  }

  private coerceBatchInputs(arg0: any, arg1: any): any[] {
    if (Array.isArray(arg0) && arg0.length) return arg0;
    if (Array.isArray(arg1) && arg1.length) return arg1;
    if (Array.isArray(arg0)) return arg0;
    if (Array.isArray(arg1)) return arg1;
    const fromObj =
      arg0?.texts ??
      arg0?.text ??
      arg0?.inputs ??
      arg0?.input ??
      arg0?.items ??
      arg1?.texts ??
      arg1?.inputs ??
      arg1?.items ??
      null;
    return Array.isArray(fromObj) ? fromObj : [];
  }

  private coerceBatchInputsFromArgs(args: any[]): any[] {
    for (const a of args) {
      if (Array.isArray(a) && a.length) return a;
    }
    for (const a of args) {
      if (a && typeof a === "object") {
        const candidate = a.texts ?? a.inputs ?? a.items ?? a.data?.texts ?? a.data?.inputs ?? a.data?.items ?? null;
        if (Array.isArray(candidate) && candidate.length) return candidate;
      }
    }
    for (const a of args) {
      if (Array.isArray(a)) return a;
    }
    return [];
  }

  async embed_batch(...args: any[]) {
    const [arg0, arg1, arg2] = args;
    const coerced = this.coerceBatchInputsFromArgs(args);
    if (coerced.length === 0) return [];

    const batchSize = this.ensureBatchSize();
    const modelKey = await this.ensureModelKey();

    const normalized = normalizeBatchInputs(coerced);
    if (normalized.length === 0) return [];

    const vectors: number[][] = [];

    for (const group of chunk(normalized, batchSize)) {
      try {
        const data = await createEmbeddings(modelKey, group);
        const embeddings = extractEmbeddings(data);

        // Some servers accept an array input but return a different count.
        // Guarantee 1 embedding per input, in order, to match Smart Connections expectations.
        if (embeddings.length !== group.length) {
          console.log(
            "[LM Studio Embeddings] embedding count mismatch; recovering",
            "expected=",
            group.length,
            "got=",
            embeddings.length
          );
          const recovered: number[][] = [];
          for (const one of group) recovered.push(await embedOne(modelKey, one));
          vectors.push(...recovered);
        } else {
          vectors.push(...embeddings.slice(0, group.length));
        }
      } catch (err) {
        // Compatibility fallback: some servers only accept a single string.
        const recovered: number[][] = [];
        for (const one of group) recovered.push(await embedOne(modelKey, one));
        vectors.push(...recovered);
      }

      // Best-effort dims inference + persistence.
      const inferredDims = vectors[0]?.length;
      if (Number.isFinite(inferredDims) && this?.model?.data && !Number.isFinite(this.model.data.dims)) {
        this.model.data.dims = inferredDims;
        this.model.debounce_save?.();
      }
    }

    const padded = this.padToLength(vectors, normalized.length);
    return padded.map((vec, idx) => ({ vec, tokens: estimateTokens(normalized[idx] ?? "") }));
  }

  async embed(texts: any[]) {
    const inputs = Array.isArray(texts) ? texts : [texts];
    const items = await this.embed_batch(inputs);
    return items[0] ?? { vec: [] };
  }

  async embed_documents(texts: any[]) {
    return this.embed_batch(texts);
  }

  async embed_query(text: any) {
    const items = await this.embed_batch([text]);
    return items[0] ?? { vec: [] };
  }

  async unload() {
    this.state = "unloaded";
  }
}

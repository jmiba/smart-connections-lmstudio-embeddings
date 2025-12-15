import { App, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { LmStudioEmbeddingAdapter, setLmStudioSettings, listModels } from "./lmstudio";

type Settings = {
  baseUrl: string;
  requestTimeoutMs: number;
  maxTokens: number;
  batchSize: number;
};

const DEFAULT_SETTINGS: Settings = {
  baseUrl: "http://127.0.0.1:1234",
  requestTimeoutMs: 120_000,
  maxTokens: 512,
  batchSize: 16
};

/**
 * Known adapter keys that Smart Connections may use to look up the LM Studio adapter.
 * We register under all of these to maximize compatibility.
 */
const ADAPTER_KEYS = ["lm_studio", "lmstudio", "lm-studio"] as const;

function findSmartConnectionsPlugin(app: App) {
  try {
    const appAny = app as any;
    return appAny?.plugins?.getPlugin?.("smart-connections") ?? appAny?.plugins?.plugins?.["smart-connections"] ?? null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function findProvidersRegistry(env: any): Record<string, any> | null {
  const candidates = [
    env?.config?.collections?.embedding_models?.providers,
    env?.config?.embedding_models?.providers,
    env?.embedding_models?.providers,
    env?.embedding_models?.config?.providers
  ];

  for (const c of candidates) {
    if (isRecord(c)) return c;
  }

  const collections = env?.config?.collections;
  if (isRecord(collections)) {
    for (const value of Object.values(collections)) {
      const maybeProviders = (value as any)?.embedding_models?.providers ?? (value as any)?.providers;
      if (isRecord(maybeProviders)) return maybeProviders;
    }
  }

  return null;
}

async function waitForSmartConnectionsEnv(app: App, timeoutMs = 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const sc = findSmartConnectionsPlugin(app);
    const env = sc?.env;
    if (sc && env && (findProvidersRegistry(env) || env?.embedding_models)) return { sc, env };
    await new Promise((r) => window.setTimeout(r, 500));
  }
  throw new Error("Timed out waiting for Smart Connections env");
}

function registerLmStudioProvider(sc: any, env: any, settings: Settings) {
  const providers = findProvidersRegistry(env);
  if (!providers) throw new Error("Smart Connections providers registry missing");

  const keys = Object.keys(providers);
  let targetKey =
    keys.find((k) => k === "lm_studio" || k === "lmstudio" || k === "lm-studio") ??
    keys.find((k) => /studio/i.test(k)) ??
    null;

  if (!targetKey) {
    for (const [k, v] of Object.entries(providers)) {
      const name = String((v as any)?.name ?? (v as any)?.label ?? "").toLowerCase();
      if (name.includes("lm studio")) {
        targetKey = k;
        break;
      }
    }
  }

  // Patch in-place so an existing (often PRO/disabled) dropdown entry becomes usable.
  targetKey = targetKey ?? "lm_studio";

  const existing = (providers as any)[targetKey];
  if (existing?.class === LmStudioEmbeddingAdapter) return;

  // IMPORTANT: Use the transformers provider as a UI template so the model modal keeps
  // the same controls (New/Delete/Test + any test input fields).
  const transformersTemplate = (providers as any).transformers ?? Object.values(providers)[0] ?? {};
  const batchSize = settings?.batchSize ?? DEFAULT_SETTINGS.batchSize;

  const providerConfig = {
    ...transformersTemplate,
    ...(existing ?? {}),

    id: targetKey,
    name: "LM Studio",
    label: "LM Studio",
    description: "local, requires LM Studio app",
    adapter: "lm_studio",
    adapter_key: "lm_studio",
    adapterKey: "lm_studio",
    batch_size: batchSize,
    max_batch_size: batchSize,

    // These flags control whether SC marks the provider as PRO/disabled in some versions.
    pro: false,
    is_pro: false,
    isPro: false,
    requires_pro: false,
    requiresPro: false,
    available: true,
    enabled: true,

    class: LmStudioEmbeddingAdapter
  };

  // Register under all known keys for maximum compatibility
  for (const key of ADAPTER_KEYS) {
    (providers as any)[key] = providerConfig;
  }

  // Some versions keep an additional registry under env.embedding_models.providers
  try {
    const alt = env?.embedding_models?.providers;
    if (isRecord(alt)) {
      for (const key of ADAPTER_KEYS) {
        (alt as any)[key] = providerConfig;
      }
    }
  } catch {
    // ignore
  }

  // CRITICAL: Register the adapter CLASS in adapter registries.
  // This is what Smart Connections uses to instantiate the adapter when loading embeddings.
  // Without this, SC won't be able to load the adapter and will treat items as unembedded.
  registerAdapterClass(env);

  // Note: We intentionally do NOT emit providers-updated events here.
  // Those events can trigger model:changed notifications which confuse users.
  // The adapter registration itself is sufficient for SC to recognize LM Studio.
}

/**
 * Register the LmStudioEmbeddingAdapter class in all adapter registries that Smart Connections
 * might use to look up adapter classes by key. This is essential for SC to recognize
 * existing embeddings on restart.
 */
function registerAdapterClass(env: any) {
  // Various places SC might store adapter classes
  const registries = [
    env?.embedding_models?.adapters,
    env?.embedding_models?.adapter_classes,
    env?.embedding_models?.adapterClasses,
    env?.embedding_models?.adapter_registry,
    env?.embedding_models?.adapterRegistry,
    env?.embedding_models?.embedding_adapters,
    env?.embedding_models?.embeddingAdapters,
    env?.config?.modules?.smart_embed_model?.adapters,
    env?.config?.embedding_models?.adapters,
    // Direct on embed model
    env?.smart_sources?.embed_model?.adapters,
    env?.smart_blocks?.embed_model?.adapters,
  ];

  for (const reg of registries) {
    if (!isRecord(reg)) continue;
    for (const key of ADAPTER_KEYS) {
      (reg as any)[key] = LmStudioEmbeddingAdapter;
    }
  }

  // Also try to register on the SmartEmbedModel class if available
  try {
    const SmartEmbedModel = env?.config?.modules?.smart_embed_model?.class;
    if (SmartEmbedModel?.adapters && isRecord(SmartEmbedModel.adapters)) {
      for (const key of ADAPTER_KEYS) {
        SmartEmbedModel.adapters[key] = LmStudioEmbeddingAdapter;
      }
    }
  } catch {
    // ignore
  }
}


export default class SmartConnectionsLmStudioEmbeddings extends Plugin {
  settings: Settings = DEFAULT_SETTINGS;
  private bootstrapped = false;
  private registrationInterval: number | null = null;

  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.applySettings();
    this.addSettingTab(new LmStudioSettingsTab(this.app, this));

    new Notice(`LM Studio Embeddings loaded (v${this.manifest?.version ?? "unknown"})`);

    // Try to register immediately - this may catch SC if it's already loaded
    this.tryEarlyRegistration();
    
    // Set up a short polling interval to catch SC as early as possible
    // This is critical for preventing re-embedding on restart
    this.registrationInterval = window.setInterval(() => {
      if (this.bootstrapped) {
        if (this.registrationInterval) {
          window.clearInterval(this.registrationInterval);
          this.registrationInterval = null;
        }
        return;
      }
      this.tryEarlyRegistration();
    }, 200);

    // Also try on layout ready
    this.app.workspace.onLayoutReady(() => {
      this.bootstrap().catch((err) => console.warn("[LM Studio Embeddings] bootstrap failed", err));
    });
    
    // Fallback: full bootstrap with longer timeout
    this.bootstrap().catch((err) => console.warn("[LM Studio Embeddings] bootstrap failed", err));
  }

  onunload() {
    if (this.registrationInterval) {
      window.clearInterval(this.registrationInterval);
      this.registrationInterval = null;
    }
  }

  /**
   * Try to register the adapter as early as possible, before SC initializes entities.
   * This is non-blocking and won't throw errors if SC isn't ready yet.
   */
  private tryEarlyRegistration() {
    try {
      const sc = findSmartConnectionsPlugin(this.app);
      if (!sc) return false;
      
      const env = sc?.env;
      if (!env) return false;

      const providers = findProvidersRegistry(env);
      if (!providers) return false;
      
      // SC is available - register immediately
      // Note: registerLmStudioProvider already calls registerAdapterClass internally
      registerLmStudioProvider(sc, env, this.settings);
      
      console.log("[LM Studio Embeddings] Early registration successful");
      this.bootstrapped = true;
      
      if (this.registrationInterval) {
        window.clearInterval(this.registrationInterval);
        this.registrationInterval = null;
      }
      
      // Warm model list in background
      listModels(true).catch((err) => 
        console.warn("[LM Studio Embeddings] Failed to list models", err)
      );
      
      return true;
    } catch (err) {
      // Silently fail - we'll retry
      return false;
    }
  }

  private applySettings() {
    setLmStudioSettings({
      baseUrl: this.settings.baseUrl,
      requestTimeoutMs: this.settings.requestTimeoutMs,
      maxTokens: this.settings.maxTokens,
      batchSize: this.settings.batchSize
    });
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.applySettings();
  }

  private async bootstrap() {
    if (this.bootstrapped) return;
    const { sc, env } = await waitForSmartConnectionsEnv(this.app, 120_000);
    registerLmStudioProvider(sc, env, this.settings);

    // Warm model list so dropdown has options immediately.
    try {
      await listModels(true);
    } catch (err) {
      console.warn("[LM Studio Embeddings] Failed to list models", err);
    }

    this.bootstrapped = true;
    new Notice("LM Studio Embeddings: provider registered");
  }
}

class LmStudioSettingsTab extends PluginSettingTab {
  plugin: SmartConnectionsLmStudioEmbeddings;

  constructor(app: App, plugin: SmartConnectionsLmStudioEmbeddings) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("LM Studio base URL")
      .setDesc("Example: http://127.0.0.1:1234")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.baseUrl)
          .setValue(this.plugin.settings.baseUrl)
          .onChange(async (value) => {
            this.plugin.settings.baseUrl = value.trim() || DEFAULT_SETTINGS.baseUrl;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Request timeout (ms)")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.requestTimeoutMs)).onChange(async (value) => {
          const n = Number(value);
          this.plugin.settings.requestTimeoutMs = Number.isFinite(n) ? Math.max(5_000, n) : DEFAULT_SETTINGS.requestTimeoutMs;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Default max tokens")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.maxTokens)).onChange(async (value) => {
          const n = Number(value);
          this.plugin.settings.maxTokens = Number.isFinite(n) ? Math.max(16, n) : DEFAULT_SETTINGS.maxTokens;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Default batch size")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.batchSize)).onChange(async (value) => {
          const n = Number(value);
          this.plugin.settings.batchSize = Number.isFinite(n) ? Math.max(1, n) : DEFAULT_SETTINGS.batchSize;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Reload model list")
      .setDesc("Fetches available models from LM Studio (GET /v1/models).")
      .addButton((btn) => {
        btn.setButtonText("Fetch").onClick(async () => {
          try {
            await listModels(true);
            new Notice("LM Studio Embeddings: model list refreshed");
          } catch (err: any) {
            new Notice(`LM Studio Embeddings: failed to fetch models (${err?.message ?? err})`);
          }
        });
      });
  }
}

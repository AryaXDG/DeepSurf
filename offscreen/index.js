/**
 * @fileoverview Persistent background sandbox housing the WebGPU contexts and local databases.
 *
 * This document runs outside the extension service worker to bypass the service worker's
 * short execution lifetime and prevent graphics memory (VRAM) reclamation. It orchestrates the on-device
 * ONNX runtime for text embeddings, hosts the local WebLLM chat engine, and runs the PGlite vector database
 * for semantic search.
 */

import { pipeline, env as transformersEnv } from "@xenova/transformers";
import { CreateMLCEngine } from "@mlc-ai/web-llm";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { MSG } from "../lib/messages.js";
import { vecToLiteral, reciprocalRankFusion } from "../lib/vectorUtils.js";
import { buildSnippet, cleanUrlForDb } from "../lib/utils.js";

transformersEnv.allowLocalModels = false;
transformersEnv.allowRemoteModels = true;
transformersEnv.useBrowserCache = true;
transformersEnv.backends.onnx.wasm.numThreads = 1;
transformersEnv.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("assets/");

/** @type {import("@xenova/transformers").FeatureExtractionPipeline | null} */
let embedder = null;
/** @type {import("@mlc-ai/web-llm").MLCEngine | null} */
let llmEngine = null;
/** @type {import("@electric-sql/pglite").PGlite | null} */
let db = null;
/** @type {Promise<import("@electric-sql/pglite").PGlite> | null} */
let dbInitPromise = null;

let globalEmbedMutex = Promise.resolve();

/** @type {Promise<import("@xenova/transformers").FeatureExtractionPipeline> | null} */
let embedderInitPromise = null;
/** @type {Promise<import("@mlc-ai/web-llm").MLCEngine> | null} */
let llmInitPromise = null;
let llmLoading = false;
let llmUnsupported = false;
let embedderLoading = false;

/**
 * Broadcasts the current initialization and loading status of AI models to other extension pages.
 *
 * @param {Object} status - The model status object.
 * @returns {void}
 */
function broadcastStatus(status) {
  chrome.runtime.sendMessage({ type: MSG.MODEL_STATUS_UPDATE, payload: status }).catch((e) => {
    console.error("[DeepSurf:ERROR] Failed to send MODEL_STATUS_UPDATE:", e);
  });
}

/**
 * Initializes the PGlite database in the offscreen context.
 *
 * It sets up the vector extensions, configures schemas, and creates indexes.
 *
 * @returns {Promise<import("@electric-sql/pglite").PGlite>} The database instance.
 * @throws {Error} If database initialization or schema migration fails.
 */
function initDB() {
  if (db) return Promise.resolve(db);
  if (dbInitPromise) return dbInitPromise;

  dbInitPromise = (async () => {
    console.log("[DeepSurf] Initializing PGlite database in offscreen document.");
    const instance = new PGlite("idb://deepsurf-vectors", { extensions: { vector } });

    await instance.exec(`CREATE TABLE IF NOT EXISTS schema_info (version INT)`);
    const versionRes = await instance.query(`SELECT version FROM schema_info LIMIT 1`);
    let currentVersion = versionRes.rows.length > 0 ? versionRes.rows[0].version : 0;

    if (currentVersion === 0) {
      await instance.exec(`
        CREATE EXTENSION IF NOT EXISTS vector;
        CREATE TABLE IF NOT EXISTS pages (
          id          TEXT PRIMARY KEY,
          url         TEXT NOT NULL UNIQUE,
          title       TEXT NOT NULL DEFAULT '',
          text        TEXT NOT NULL DEFAULT '',
          visited_at  BIGINT NOT NULL,
          embedding   vector(384)
        );
      `);

      await instance.exec(`
        CREATE INDEX IF NOT EXISTS pages_embedding_hnsw_idx
          ON pages USING hnsw (embedding vector_cosine_ops)
          WITH (m = 16, ef_construction = 64);
      `);

      await instance.exec(`
        CREATE INDEX IF NOT EXISTS pages_fts_idx 
          ON pages USING GIN (to_tsvector('english', title || ' ' || text));
      `);

      await instance.exec(`
        CREATE TABLE IF NOT EXISTS telemetry_pulses (
          id TEXT PRIMARY KEY,
          session_id TEXT,
          domain TEXT NOT NULL,
          url TEXT NOT NULL,
          timestamp BIGINT NOT NULL,
          active_seconds INTEGER,
          scroll_pixels_total INTEGER,
          scroll_direction_changes INTEGER,
          interaction_count INTEGER,
          mouse_distance_px INTEGER,
          is_media_playing BOOLEAN,
          has_text_selection BOOLEAN
        );
        
        CREATE INDEX IF NOT EXISTS idx_telemetry_time 
          ON telemetry_pulses(timestamp);
      `);

      await instance.exec(`
        CREATE TABLE IF NOT EXISTS canvas_threads (
          id          TEXT PRIMARY KEY,
          name        TEXT NOT NULL,
          created_at  BIGINT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS canvas_nodes (
          id          TEXT PRIMARY KEY,
          thread_id   TEXT REFERENCES canvas_threads(id) ON DELETE CASCADE,
          type        TEXT NOT NULL DEFAULT 'highlight',
          text        TEXT NOT NULL,
          annotation  TEXT NOT NULL DEFAULT '',
          url         TEXT NOT NULL DEFAULT '',
          title       TEXT NOT NULL DEFAULT '',
          xpath       TEXT NOT NULL DEFAULT '',
          context_before TEXT NOT NULL DEFAULT '',
          context_after  TEXT NOT NULL DEFAULT '',
          pos_x       REAL NOT NULL DEFAULT 0,
          pos_y       REAL NOT NULL DEFAULT 0,
          created_at  BIGINT NOT NULL,
          embedding   vector(384)
        );

        CREATE TABLE IF NOT EXISTS canvas_edges (
          id          TEXT PRIMARY KEY,
          thread_id   TEXT NOT NULL,
          source_id   TEXT NOT NULL,
          target_id   TEXT NOT NULL,
          score       REAL NOT NULL DEFAULT 0,
          manual      BOOLEAN NOT NULL DEFAULT FALSE,
          label       TEXT NOT NULL DEFAULT '',
          created_at  BIGINT NOT NULL
        );
      `);

      // Legacy compatibility: earlier DB schemas had thread_id as non-null,
      // but we allow orphans now for threadless inbox nodes.
      try { await instance.exec(`ALTER TABLE canvas_nodes ALTER COLUMN thread_id DROP NOT NULL;`); } catch(e) { /* expected on fresh installs */ }

      await instance.exec(`INSERT INTO schema_info (version) VALUES (1)`);
      currentVersion = 1;
    }

    if (currentVersion === 1) {

    }

    db = instance;
    console.log(`[DeepSurf] PGlite database initialized successfully (schema v${currentVersion}).`);
    return db;
  })();
  return dbInitPromise;
}

/**
 * Loads and initializes the text embedding model from the CDN or cache.
 *
 * @returns {Promise<import("@xenova/transformers").FeatureExtractionPipeline>} The feature extraction pipeline.
 * @throws {Error} If model downloading or initialization fails.
 */
function getEmbedder() {
  if (embedder) return Promise.resolve(embedder);
  if (embedderInitPromise) return embedderInitPromise;

  embedderLoading = true;
  broadcastStatus({ embedder: "loading" });

  embedderInitPromise = pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
    quantized: true,
  }).then((pipe) => {
    console.log("[DeepSurf] Embedder model initialized successfully.");
    embedder = pipe;
    embedderLoading = false;
    broadcastStatus({ embedder: "ready" });
    return embedder;
  }).catch((e) => {
    embedderLoading = false;
    embedderInitPromise = null;
    broadcastStatus({ embedder: "error", error: e.message });
    throw e;
  });

  return embedderInitPromise;
}

/**
 * Encodes text into a normalized float array embedding using a concurrency lock.
 *
 * @param {string} text - The input text to encode.
 * @param {number} [timeoutMs=30000] - Time limit to prevent thread lockups.
 * @returns {Promise<Float32Array>} The normalized 384-dimensional vector data.
 * @throws {Error} If embedding fails or times out.
 */
async function safeEmbed(text, timeoutMs = 30000) {
  let release;
  const lock = new Promise(r => release = r);
  const currentLock = globalEmbedMutex;
  globalEmbedMutex = lock;

  // We serialize embedding requests because running multiple ONNX inferences
  // simultaneously in the same WASM instance crashes the browser thread.
  await currentLock;
  try {
    const pipe = await getEmbedder();
    const embedPromise = pipe(text, { pooling: "mean", normalize: true });
    
    // We enforce a hard timeout because WebGPU/WASM occasionally freezes
    // without throwing when the GPU scheduler drops commands.
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Embedding timeout — WASM may be stuck")), timeoutMs)
    );
    const output = await Promise.race([embedPromise, timeoutPromise]);
    return output.data;
  } catch (e) {
    console.error("[DeepSurf:Offscreen] safeEmbed failed:", e.message);
    embedder = null;
    embedderInitPromise = null;
    broadcastStatus({ embedder: "error", error: e.message });

    const msg = e.message || "";
    
    // If the browser loses the WebGPU device (e.g. system went to sleep),
    // we must clear both model instances so they rebuild clean contexts.
    if (msg.includes("lost") || msg.includes("destroyed") || msg.includes("disposed")) {
      console.warn("[DeepSurf:Offscreen] GPU device lost detected in embedder — resetting LLM too.");
      llmEngine = null;
      llmInitPromise = null;
      broadcastStatus({ llm: "idle", embedder: "idle" });
    }

    throw e;
  } finally {
    release();
  }
}

/**
 * Inspects system capabilities to choose the correct LLM variant size.
 *
 * @returns {Promise<{tier: string, modelId?: string, reason?: string}>} The hardware capability mapping.
 */
async function profileHardware() {
  if (!navigator.gpu) return { tier: "unsupported", reason: "No WebGPU" };
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { tier: "unsupported", reason: "No GPU Adapter" };

    const systemRam = navigator.deviceMemory || 4;
    const hasF16 = adapter.features.has("shader-f16");

    const maxBufferBytes = adapter.limits?.maxBufferSize ?? 0;
    
    // We check maxBufferSize to verify the GPU adapter can allocate at least 512MB
    // which is the minimum chunk size required to load Llama weights.
    const hasAdequateVram = maxBufferBytes >= 512 * 1024 * 1024;

    if (systemRam < 4 || !hasAdequateVram) {
      return { tier: "unsupported", reason: `Insufficient resources (RAM: ${systemRam}GB, maxBuffer: ${Math.round(maxBufferBytes / 1024 / 1024)}MB)` };
    }

    // Modern mobile and desktop GPUs support 16-bit float instructions,
    // allowing us to load faster models and save half the graphics memory.
    if (hasF16) {
      return { tier: "high", modelId: "Llama-3.2-1B-Instruct-q4f16_1-MLC" };
    } else {
      return { tier: "low", modelId: "Llama-3.2-1B-Instruct-q4f32_1-MLC" };
    }
  } catch (e) {
    return { tier: "unsupported", reason: e.message };
  }
}

/**
 * Loads the LLM MLC engine according to the profiled hardware tier.
 *
 * @returns {Promise<import("@mlc-ai/web-llm").MLCEngine | null>} The local LLM engine, or null if unsupported.
 * @throws {Error} If compilation or model parsing fails.
 */
async function getLLM() {
  if (llmEngine) return Promise.resolve(llmEngine);
  if (llmInitPromise) return llmInitPromise;

  llmLoading = true;
  broadcastStatus({ llm: "loading", progress: 0 });

  const hardware = await profileHardware();

  if (hardware.tier === "unsupported") {
    llmLoading = false;
    llmUnsupported = true;
    broadcastStatus({ llm: "unsupported" });
    return Promise.resolve(null);
  }

  console.log(`[DeepSurf:Offscreen] Hardware Tier: ${hardware.tier}. Loading model: ${hardware.modelId}`);

  llmInitPromise = CreateMLCEngine(hardware.modelId, {
    initProgressCallback: (p) => {
      broadcastStatus({ llm: "loading", progress: Math.round(p.progress * 100) });
    },
  }).then((engine) => {
    llmEngine = engine;
    llmLoading = false;
    broadcastStatus({ llm: "ready" });
    return llmEngine;
  }).catch((e) => {
    console.error("[DeepSurf:Offscreen] LLM Boot Error:", e);
    llmLoading = false;
    llmInitPromise = null;
    
    if (e.message.includes("adapter") || e.message.includes("GPU") || e.message.includes("No available")) {
      llmUnsupported = true;
      broadcastStatus({ llm: "unsupported" });
      return null;
    } else {
      broadcastStatus({ llm: "error", error: e.message });
      throw e;
    }
  });

  return llmInitPromise;
}

/**
 * Unloads the LLM MLC engine and frees VRAM.
 *
 * @returns {Promise<void>}
 */
async function unloadLLM() {
  if (llmInitPromise) {
    try {
      const engine = await Promise.race([
        llmInitPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error("Forced timeout during unload")), 5000))
      ]);
      if (engine) {
        chatAborted = true; 
        await engine.interruptGenerate(); 
        await engine.unload(); 
      }
    } catch (e) {
      console.warn("[DeepSurf:Offscreen] Error unloading LLM:", e.message);
    }
  }
  
  llmEngine = null;
  llmInitPromise = null;
  llmLoading = false;
  llmUnsupported = false;
  
  broadcastStatus({ llm: "idle", progress: 0 });
}

/**
 * Embeds a text snippet from a page, checks for similarity, and inserts it into the database.
 *
 * @param {Object} payload - The page structure to ingest.
 * @param {string} payload.id - Unique ID of the page.
 * @param {string} payload.url - The clean URL.
 * @param {string} payload.title - The title text.
 * @param {string} payload.text - The full page text.
 * @param {number} payload.visitedAt - Epoch timestamp.
 * @param {boolean} [skipSimilarity=false] - Whether to bypass similarity check to speed up sync.
 * @returns {Promise<Object | null>} The similar page match details, or null.
 * @throws {Error} If ingestion fails.
 */
async function ingestPage(payload, skipSimilarity = false) {
  const { id, url, title, text, visitedAt } = payload;
  const pg = await initDB();

  const safeVisitedAt = Math.round(Number(visitedAt));

  try {
    console.log(`[DeepSurf] Embedding page content for URL: ${url}`);
    const vec = await safeEmbed(title + " " + text.slice(0, 512));
    const literal = vecToLiteral(vec);

    let match = null;
    if (!skipSimilarity) {
      const cutoffMs = Date.now() - (24 * 60 * 60 * 1000); 
      const similar = await pg.query(
        `SELECT url, title, visited_at, 1 - (embedding <=> $1::vector) AS score
         FROM pages
         WHERE url != $2 AND visited_at < $3
         ORDER BY embedding <=> $1::vector LIMIT 1`,
        [literal, url, cutoffMs]
      );

      if (similar.rows.length > 0) {
        const top = similar.rows[0];
        if (Number(top.score) > 0.75) {
          match = { url: top.url, title: top.title, visitedAt: Number(top.visited_at), score: top.score };
        }
      }
    }

    const doInsert = () => pg.query(
      `INSERT INTO pages (id, url, title, text, visited_at, embedding)
       VALUES ($1, $2, $3, $4, $5, $6::vector)
       ON CONFLICT (url) DO UPDATE
         SET title      = EXCLUDED.title,
             text       = EXCLUDED.text,
             visited_at = EXCLUDED.visited_at,
             embedding  = EXCLUDED.embedding`,
      [id, url, title, text, safeVisitedAt, literal]
    );

    try {
      await doInsert();
    } catch (insertErr) {
      const errMsg = (insertErr.name || "") + " " + (insertErr.message || "");
      
      // IndexedDB limits can trigger quota errors. We handle this by dropping the oldest
      // 20% of entries and forcing vacuum cleanup to prevent persistent write blocks.
      if (errMsg.toLowerCase().includes("quota")) {
        console.warn("[DeepSurf:Offscreen] QuotaExceededError — auto-pruning oldest 20% and retrying...");
        const countRes = await pg.query("SELECT COUNT(*) as total FROM pages");
        const total = Number(countRes.rows[0].total);
        const toDelete = Math.max(1, Math.floor(total * 0.2));
        await pg.query(
          `DELETE FROM pages WHERE url IN (
            SELECT url FROM pages ORDER BY visited_at ASC LIMIT $1
          )`, [toDelete]
        );
        await pg.exec("VACUUM");
        await doInsert();
      } else {
        throw insertErr;
      }
    }

    console.log(`[DeepSurf] Successfully ingested page: ${url}`);
    return match;
  } catch (error) {
    console.error(`[DeepSurf:Offscreen] Critical error inside ingestPage for ${url}:`, error);
    throw error;
  }
}

/**
 * Queries pages from the database using offset limits and date boundaries.
 *
 * @param {Object} params - Query filters.
 * @param {number} [params.offset=0] - Offset index.
 * @param {number} [params.limit=50] - Result size.
 * @param {number} [params.startDate] - Start timestamp range.
 * @param {number} [params.endDate] - End timestamp range.
 * @returns {Promise<{pages: Array<Object>, total: number}>} The queried rows and total counts.
 */
async function getPages({ offset = 0, limit = 50, startDate, endDate }) {
  const pg = await initDB();
  let query = "SELECT id, url, title, visited_at FROM pages";
  let countQuery = "SELECT COUNT(*) FROM pages";
  const filterParams = [];
  const conditions = [];

  if (startDate) {
    conditions.push(`visited_at >= $${filterParams.length + 1}`);
    filterParams.push(startDate);
  }
  if (endDate) {
    conditions.push(`visited_at <= $${filterParams.length + 1}`);
    filterParams.push(endDate);
  }

  const whereClause = conditions.length > 0 ? " WHERE " + conditions.join(" AND ") : "";
  query += whereClause + ` ORDER BY visited_at DESC LIMIT $${filterParams.length + 1} OFFSET $${filterParams.length + 2}`;
  countQuery += whereClause;

  const mainParams = [...filterParams, limit, offset];

  const [result, countResult] = await Promise.all([
    pg.query(query, mainParams),
    pg.query(countQuery, filterParams),
  ]);

  return {
    pages: result.rows.map(r => ({ id: r.id, url: r.url, title: r.title, visitedAt: Number(r.visited_at) })),
    total: Number(countResult.rows[0].count),
  };
}

/**
 * Deletes pages matching a list of URLs or wipes the database entirely.
 *
 * @param {Object} params - Selection options.
 * @param {Array<string> | string} params.urls - An array of URLs to remove, or "ALL" to truncate.
 * @returns {Promise<void>}
 */
async function deleteHistory({ urls }) {
  const pg = await initDB();
  
  if (urls === "ALL") {
    await pg.query("TRUNCATE pages");
    return;
  }
  
  for (const url of urls) {
    await pg.query("DELETE FROM pages WHERE url = $1", [url]);
  }
}

/**
 * Deletes database pages older than a specified duration.
 *
 * @param {Object} params - Pruning criteria.
 * @param {number} params.thresholdMs - Duration in milliseconds to compute the cutoff boundary.
 * @returns {Promise<void>}
 */
async function pruneHistory({ thresholdMs }) {
  const cutoff = Date.now() - thresholdMs;
  const pg = await initDB();
  
  console.log(`[DeepSurf] Pruning history before ${new Date(cutoff).toISOString()}`);
  await pg.query("DELETE FROM pages WHERE visited_at < $1", [cutoff]);

  console.log("[DeepSurf] Running database VACUUM to reclaim space...");
  await pg.exec("VACUUM"); 
}

/**
 * Imports a batch of history pages.
 *
 * @param {Object} params - Synchronization payload.
 * @param {Array<Object>} params.batch - Collection of pages to ingest.
 * @returns {Promise<void>}
 */
async function syncHistory({ batch }) {
  for (const item of batch) {
    try { await ingestPage(item, true); } catch (e) { console.error(`[DeepSurf:Offscreen] Failed to ingest during sync: ${item.url}`, e); }
  }
}

/**
 * Performs a blended semantic and lexical query.
 *
 * @param {Object} params - Search params.
 * @param {string} params.query - Plain text search query.
 * @param {number} [params.limit=12] - Max count of fused search items.
 * @param {number} [params.vectorWeight=0.6] - Ratio to weigh vector scores versus lexical scores.
 * @returns {Promise<Array<Object>>} Blended search items sorted descending by fusion score.
 */
async function hybridSearch({ query, limit = 12, vectorWeight = 0.6 }) {
  console.log(`[DeepSurf] Starting hybrid search for query: "${query}"`);
  const pg = await initDB();

  const vec = await safeEmbed(query);
  const literal = vecToLiteral(vec);
  const fetchLimit = Math.min(Math.max(1, limit * 2), 200);

  const [vectorRows, lexRows] = await Promise.all([
    pg.query(
      `SELECT id, url, title, text, visited_at, 1 - (embedding <=> $1::vector) AS score
       FROM pages ORDER BY embedding <=> $1::vector LIMIT $2`,
      [literal, fetchLimit]
    ),
    pg.query(
      `SELECT id, url, title, text, visited_at, 
              ts_rank(to_tsvector('english', title || ' ' || text), plainto_tsquery('english', $1)) AS score
       FROM pages 
       WHERE to_tsvector('english', title || ' ' || text) @@ plainto_tsquery('english', $1)
       ORDER BY score DESC LIMIT $2`,
      [query, fetchLimit]
    )
  ]);

  const vectorList = vectorRows.rows.map((r) => ({ url: r.url, score: Number(r.score) }));
  const lexList = lexRows.rows.map((r) => ({ url: r.url, score: Number(r.score) }));

  const fusedScores = reciprocalRankFusion(vectorList, lexList, vectorWeight);
  const rowMap = new Map();

  for (const r of vectorRows.rows) rowMap.set(r.url, r);
  for (const r of lexRows.rows) {
    if (!rowMap.has(r.url)) rowMap.set(r.url, r);
  }

  console.log(`[DeepSurf] Hybrid search complete. Found ${fusedScores.size} unique results.`);
  return [...fusedScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([url, score]) => {
      const row = rowMap.get(url) ?? {};
      return {
        url, 
        title: row.title ?? "", 
        snippet: buildSnippet(row.text ?? "", query),
        score, 
        visitedAt: Number(row.visited_at ?? 0),
      };
    });
}

let chatAborted = false;
let isGenerating = false;

/**
 * Streams local LLM responses using contextual system messages and prompt histories.
 *
 * @param {Object} params - Model orchestration configs.
 * @param {string} params.query - User text.
 * @param {Array<Object>} params.context - Retrieved context files.
 * @param {Array<Object>} params.history - Message logs.
 * @returns {Promise<void>}
 */
async function streamChat({ query, context, history }) {
  if (isGenerating) {
    chrome.runtime.sendMessage({ 
      type: MSG.CHAT_ERROR, 
      payload: { error: "Please wait for the current response to finish." } 
    }).catch(() => {});
    return;
  }
  isGenerating = true;

  try {
    console.log(`[DeepSurf] Starting local LLM stream for query: "${query}"`);
    const engine = await getLLM();
    if (!engine) {
      chrome.runtime.sendMessage({
        type: MSG.CHAT_ERROR,
        payload: { error: "On-device AI is not supported on this device. WebGPU is required." }
      }).catch(() => {});
      return;
    }
    chatAborted = false;

    const hasData = context && context.length > 0;
    const contextBlock = hasData
      ? context.map((r, i) => `[${i + 1}] ${r.title}\n${r.snippet}`).join("\n\n")
      : "[SYSTEM NOTIFICATION: NO RELEVANT SEARCH RESULTS FOUND IN DATABASE]";

    const systemPrompt =
      `You are DeepSurf, a factual personal history assistant. You ONLY answer questions using the provided CONTEXT.\n` +
      `CRITICAL RULES:\n` +
      `1. If the CONTEXT says "NO RELEVANT SEARCH RESULTS", you MUST reply: "I couldn't find anything matching that in your browsing history."\n` +
      `2. NEVER mention your AI training, factory knowledge, or the fact that you are a model.\n` +
      `3. Answer ONLY based on the text below. If the information is missing, admit it.\n\n` +
      `CONTEXT:\n${contextBlock}`;

    const messages = [
      { role: "system", content: systemPrompt },
      ...history, 
      { role: "user", content: query },
    ];

    const stream = await engine.chat.completions.create({ messages, stream: true, temperature: 0.1, max_tokens: 512 });

    let tokenBuffer = "";
    let fullText = "";
    const FLUSH_MS = 75;

    // We buffer tokens and flush them on an interval because sending every single token
    // individually via Chrome's messaging system creates massive overhead and lags the UI.
    const flushTokenBuffer = () => {
      if (tokenBuffer.length > 0) {
        chrome.runtime.sendMessage({ type: MSG.CHAT_TOKEN, payload: { token: tokenBuffer } }).catch((e) => {
          console.error("[DeepSurf:ERROR] Failed to send CHAT_TOKEN:", e);
        });
        tokenBuffer = "";
      }
    };

    const tokenFlushInterval = setInterval(flushTokenBuffer, FLUSH_MS);

    for await (const chunk of stream) {
      if (chatAborted) { await engine.interruptGenerate(); break; }
      const token = chunk.choices[0]?.delta?.content ?? "";
      if (token) {
        fullText += token;
        tokenBuffer += token;
      }
    }

    clearInterval(tokenFlushInterval);
    flushTokenBuffer();

    chrome.runtime.sendMessage({ type: MSG.CHAT_DONE, payload: { fullText } }).catch((e) => {
      console.error("[DeepSurf:ERROR] Failed to send CHAT_DONE:", e);
    });
  } catch (e) {
    const errorMsg = e.message || "";
    if (errorMsg.includes("disposed") || errorMsg.includes("Instance reference") || errorMsg.includes("lost")) {
      llmEngine = null; llmInitPromise = null;
      embedder = null; embedderInitPromise = null;
      broadcastStatus({ llm: "idle", embedder: "idle" });
      chrome.runtime.sendMessage({ 
        type: MSG.CHAT_ERROR, 
        payload: { error: "GPU Memory limit exceeded. The engine has been reset. Try clearing chat or asking a shorter question." } 
      }).catch((e) => { console.error("[DeepSurf:ERROR] Failed to send CHAT_ERROR (GPU limit):", e); });
    } else {
      chrome.runtime.sendMessage({ type: MSG.CHAT_ERROR, payload: { error: errorMsg } }).catch((e) => { console.error("[DeepSurf:ERROR] Failed to send CHAT_ERROR:", e); });
    }
  } finally {
    isGenerating = false;
  }
}

/**
 * Counts rows and retrieves the earliest timestamp in the database.
 *
 * @returns {Promise<{total: number, oldest: number}>} The counts and boundary values.
 */
async function getStats() {
  const pg = await initDB();
  const result = await pg.query("SELECT COUNT(*) as total, MIN(visited_at) as oldest FROM pages");
  const row = result.rows[0];
  return { total: Number(row.total), oldest: Number(row.oldest ?? 0) };
}

/**
 * Retrieves or opens the canvas database instance.
 *
 * @returns {Promise<import("@electric-sql/pglite").PGlite>} The active database reference.
 */
function initCanvasDB() {
  return initDB();
}

/**
 * Generates a simple pseudo-random alphanumeric string for local unique IDs.
 *
 * @returns {string} The unique ID string.
 */
function nanoId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/**
 * Retrieves all research canvas threads.
 *
 * @returns {Promise<Array<Object>>} The thread rows.
 */
async function canvasGetThreads() {
  const pg = await initCanvasDB();
  const r = await pg.query("SELECT * FROM canvas_threads ORDER BY created_at DESC");
  return r.rows;
}

/**
 * Creates a new research canvas thread.
 *
 * @param {Object} params - Thread configuration parameters.
 * @param {string} params.name - The descriptive label.
 * @returns {Promise<Object>} The new thread record.
 */
async function canvasCreateThread({ name }) {
  const pg = await initCanvasDB();
  const id = nanoId();
  await pg.query("INSERT INTO canvas_threads (id, name, created_at) VALUES ($1, $2, $3)", [id, name, Date.now()]);
  return { id, name, created_at: Date.now() };
}

/**
 * Deletes a canvas thread and all related nodes/edges.
 *
 * @param {Object} params - Deletion selector.
 * @param {string} params.threadId - Target thread.
 * @returns {Promise<void>}
 */
async function canvasDeleteThread({ threadId }) {
  const pg = await initCanvasDB();
  await pg.query("DELETE FROM canvas_threads WHERE id = $1", [threadId]);
}

/**
 * Renames a thread.
 *
 * @param {Object} params - Rename payload.
 * @param {string} params.threadId - Thread identifier.
 * @param {string} params.name - The new thread title.
 * @returns {Promise<void>}
 */
async function canvasRenameThread({ threadId, name }) {
  const pg = await initCanvasDB();
  await pg.query("UPDATE canvas_threads SET name = $1 WHERE id = $2", [name, threadId]);
}

let canvasNodeMutex = Promise.resolve();

/**
 * Creates a research node and automatically creates links to similar nodes.
 *
 * @param {Object} payload - Node options.
 * @param {string} [payload.threadId=null] - The container thread, or null if in the inbox.
 * @param {string} [payload.type="highlight"] - Node category.
 * @param {string} payload.text - Main text snippet.
 * @param {string} [payload.annotation=""] - Optional commentary.
 * @param {string} [payload.url=""] - Source page URL.
 * @param {string} [payload.title=""] - Source page title.
 * @param {string} [payload.xpath=""] - Text coordinates.
 * @param {string} [payload.contextBefore=""] - Preceding text window.
 * @param {string} [payload.contextAfter=""] - Following text window.
 * @param {number} [payload.posX=-9999] - Coordinate position.
 * @param {number} [payload.posY=-9999] - Coordinate position.
 * @returns {Promise<{node: Object, edges: Array<Object>}>} The node details and links created.
 */
async function canvasAddNode(payload) {
  let releaseLock;
  const lockPromise = new Promise(resolve => { releaseLock = resolve; });
  const currentLock = canvasNodeMutex;
  canvasNodeMutex = lockPromise;

  await currentLock;

  try {
    const pg = await initCanvasDB();
    const {
      threadId = null, type = "highlight",
      text, annotation = "",
      url = "", title = "",
      xpath = "",
      contextBefore = "", contextAfter = "",
      posX = -9999, posY = -9999,
    } = payload;

    const embedText = type === "highlight"
      ? (text + " " + contextBefore + " " + contextAfter).slice(0, 600)
      : text;
    const vec = await safeEmbed(embedText);
    const literal = vecToLiteral(vec);

    const id = nanoId();
    const now = Date.now();

    await pg.query(
      `INSERT INTO canvas_nodes
        (id, thread_id, type, text, annotation, url, title, xpath,
         context_before, context_after, pos_x, pos_y, created_at, embedding)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::vector)`,
      [id, threadId, type, text, annotation, url, title, xpath,
       contextBefore, contextAfter, posX, posY, now, literal]
    );

    const newEdges = [];
    
    if (threadId) {
      
      // Auto-linking: we query other nodes in the same thread with cosine similarity
      // above 0.50 to build connection candidates dynamically. We ignore inbox nodes (pos = -9999).
      const similar = await pg.query(
        `SELECT id, 1 - (embedding <=> $1::vector) AS score
         FROM canvas_nodes
         WHERE thread_id = $2 AND id != $3 AND embedding IS NOT NULL
           AND pos_x != -9999 AND pos_y != -9999
           AND 1 - (embedding <=> $1::vector) >= 0.50`,
        [literal, threadId, id]
      );

      for (const row of similar.rows) {
        const edgeId = nanoId();
        await pg.query(
          `INSERT INTO canvas_edges (id, thread_id, source_id, target_id, score, manual, label, created_at)
           VALUES ($1,$2,$3,$4,$5,false,'',$6)`,
          [edgeId, threadId, id, row.id, Number(row.score), now]
        );
        newEdges.push({ id: edgeId, sourceId: id, targetId: row.id, score: Number(row.score) });
      }
    }

    return {
      node: { id, threadId, type, text, annotation, url, title, xpath, contextBefore, contextAfter, posX, posY, createdAt: now },
      edges: newEdges,
    };
  } finally {
    releaseLock();
  }
}

/**
 * Queries nodes belonging to a thread or inbox.
 *
 * @param {Object} params - Selection params.
 * @param {string | null} params.threadId - Container thread, or null for inbox.
 * @param {number} [params.limit=200] - Result size.
 * @param {number} [params.offset=0] - Offset parameter.
 * @returns {Promise<Array<Object>>} Node list items.
 */
async function canvasGetNodes({ threadId, limit = 200, offset = 0 }) {
  const pg = await initCanvasDB();
  let r;
  
  if (threadId === null) {
    r = await pg.query(
      "SELECT * FROM canvas_nodes WHERE thread_id IS NULL ORDER BY created_at ASC LIMIT $1 OFFSET $2",
      [limit, offset]
    );
  } else {
    r = await pg.query(
      "SELECT * FROM canvas_nodes WHERE thread_id = $1 ORDER BY created_at ASC LIMIT $2 OFFSET $3",
      [threadId, limit, offset]
    );
  }
  
  return r.rows.map(n => ({
    id: n.id, threadId: n.thread_id, type: n.type,
    text: n.text, annotation: n.annotation,
    url: n.url, title: n.title, xpath: n.xpath,
    contextBefore: n.context_before, contextAfter: n.context_after,
    posX: n.pos_x, posY: n.pos_y, createdAt: Number(n.created_at),
  }));
}

/**
 * Queries all nodes originating from a specific URL.
 *
 * @param {Object} params - Query criteria.
 * @param {string} params.url - The source URL.
 * @returns {Promise<Array<Object>>} Match list.
 */
async function canvasGetNodesByUrl({ url }) {
  const pg = await initCanvasDB();
  const r = await pg.query("SELECT * FROM canvas_nodes WHERE url = $1 ORDER BY created_at ASC", [url]);
  return r.rows.map(n => ({
    id: n.id, threadId: n.thread_id, type: n.type,
    text: n.text, annotation: n.annotation,
    url: n.url, title: n.title, xpath: n.xpath,
    contextBefore: n.context_before, contextAfter: n.context_after,
    posX: n.pos_x, posY: n.pos_y, createdAt: Number(n.created_at),
  }));
}

/**
 * Deletes a node and cascades to delete all linked edges.
 *
 * @param {Object} params - Selection parameters.
 * @param {string} params.nodeId - The node ID to remove.
 * @returns {Promise<void>}
 */
async function canvasDeleteNode({ nodeId }) {
  const pg = await initCanvasDB();
  await pg.transaction(async (tx) => {
    await tx.query("DELETE FROM canvas_edges WHERE source_id=$1 OR target_id=$1", [nodeId]);
    await tx.query("DELETE FROM canvas_nodes WHERE id=$1", [nodeId]);
  });
}

/**
 * Updates properties of a research node.
 *
 * @param {Object} params - Update settings.
 * @param {string} params.nodeId - Target node.
 * @param {string} [params.threadId] - New thread association.
 * @param {number} [params.posX] - Coordinate offset.
 * @param {number} [params.posY] - Coordinate offset.
 * @param {string} [params.annotation] - Updated commentary.
 * @returns {Promise<void>}
 */
async function canvasUpdateNode({ nodeId, threadId, posX, posY, annotation }) {
  const pg = await initCanvasDB();

  const sets = [];
  const params = [];

  if (threadId   !== undefined) { sets.push(`thread_id  = $${params.length + 1}`); params.push(threadId); }
  if (posX       !== undefined) { sets.push(`pos_x      = $${params.length + 1}`); params.push(posX); }
  if (posY       !== undefined) { sets.push(`pos_y      = $${params.length + 1}`); params.push(posY); }
  if (annotation !== undefined) { sets.push(`annotation = $${params.length + 1}`); params.push(annotation); }

  if (sets.length === 0) return;

  params.push(nodeId);
  await pg.query(
    `UPDATE canvas_nodes SET ${sets.join(", ")} WHERE id = $${params.length}`,
    params
  );
}

/**
 * Queries edges belonging to a thread.
 *
 * @param {Object} params - Query criteria.
 * @param {string} params.threadId - Container thread.
 * @returns {Promise<Array<Object>>} Connection list.
 */
async function canvasGetEdges({ threadId }) {
  const pg = await initCanvasDB();
  const r = await pg.query("SELECT * FROM canvas_edges WHERE thread_id = $1 ORDER BY created_at ASC", [threadId]);
  return r.rows.map(e => ({
    id: e.id, threadId: e.thread_id,
    sourceId: e.source_id, targetId: e.target_id,
    score: e.score, manual: e.manual, label: e.label,
    createdAt: Number(e.created_at),
  }));
}

/**
 * Creates an edge connection between two nodes.
 *
 * @param {Object} params - Edge coordinates.
 * @param {string} params.threadId - Container thread.
 * @param {string} params.sourceId - Source node ID.
 * @param {string} params.targetId - Target node ID.
 * @returns {Promise<Object>} The edge data.
 */
async function canvasAddEdge({ threadId, sourceId, targetId }) {
  const pg = await initCanvasDB();
  const existing = await pg.query(
    `SELECT id FROM canvas_edges
     WHERE thread_id=$1 AND ((source_id=$2 AND target_id=$3) OR (source_id=$3 AND target_id=$2))`,
    [threadId, sourceId, targetId]
  );
  if (existing.rows.length > 0) return { id: existing.rows[0].id };

  const id = nanoId();
  await pg.query(
    `INSERT INTO canvas_edges (id, thread_id, source_id, target_id, score, manual, label, created_at)
     VALUES ($1,$2,$3,$4,1.0,true,'',$5)`,
    [id, threadId, sourceId, targetId, Date.now()]
  );
  return { id, sourceId, targetId, score: 1.0, manual: true, label: "" };
}

/**
 * Deletes an edge link.
 *
 * @param {Object} params - Deletion selector.
 * @param {string} params.edgeId - Target edge ID.
 * @returns {Promise<void>}
 */
async function canvasDeleteEdge({ edgeId }) {
  const pg = await initCanvasDB();
  await pg.query("DELETE FROM canvas_edges WHERE id = $1", [edgeId]);
}

/**
 * Assigns a text label to an edge.
 *
 * @param {Object} params - Label payload.
 * @param {string} params.edgeId - Target edge ID.
 * @param {string} params.label - The textual label.
 * @returns {Promise<void>}
 */
async function canvasLabelEdge({ edgeId, label }) {
  const pg = await initCanvasDB();
  await pg.query("UPDATE canvas_edges SET label=$1 WHERE id=$2", [label, edgeId]);
}

const MAX_CONCURRENT_INGESTS = 3;
const MAX_INGEST_QUEUE = 20;
let activeIngests = 0;
const ingestQueue = [];

/**
 * Processes queued ingestion requests within the concurrent worker threshold.
 *
 * @returns {Promise<void>}
 */
async function drainIngestQueue() {
  while (ingestQueue.length > 0 && activeIngests < MAX_CONCURRENT_INGESTS) {
    const { payload, resolve, reject } = ingestQueue.shift();
    activeIngests++;
    ingestPage(payload)
      .then((match) => resolve({ type: MSG.ACK, match }))
      .catch((e) => {
        console.error(`[DeepSurf:Offscreen] Queued ingest failed: ${payload.url}`, e);
        resolve({ type: MSG.ERROR, error: e.message });
      })
      .finally(() => {
        activeIngests--;
        drainIngestQueue();
      });
  }
}

/**
 * Adds an ingestion request to the queue, dropping older requests if limits are exceeded.
 *
 * @param {Object} payload - The page structure to ingest.
 * @returns {Promise<Object>} Response event packet.
 */
function enqueueIngest(payload) {
  return new Promise((resolve, reject) => {
    if (ingestQueue.length >= MAX_INGEST_QUEUE) {
      const dropped = ingestQueue.shift();
      console.warn(`[DeepSurf:Offscreen] Ingest queue full — dropping oldest: ${dropped.payload.url}`);
      dropped.resolve({ type: MSG.ACK, match: null });
    }
    ingestQueue.push({ payload, resolve, reject });
    drainIngestQueue();
  });
}

// Global message bus router: handles incoming requests from the background service worker
// or front-end sidepanel UI and maps them to sandbox functions.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== "offscreen") return false;

  if (msg.type === MSG.INGEST_PAGE) {
    enqueueIngest(msg.payload).then(sendResponse);
    return true;
  }

  const handle = async () => {
    console.log(`[DeepSurf] Offscreen processing message: ${msg.type}`);
    switch (msg.type) {
      case MSG.SEARCH_HYBRID:        return { type: MSG.ACK, results: await hybridSearch(msg.payload) };
      case MSG.CHAT_STREAM_START:    streamChat(msg.payload).catch((e) => { console.error("[DeepSurf:ERROR] streamChat failed:", e); }); return { type: MSG.ACK };
      case MSG.CHAT_STREAM_ABORT:    chatAborted = true; return { type: MSG.ACK };
      case MSG.UNLOAD_LLM:           await unloadLLM(); return { type: MSG.ACK };
      case MSG.GET_STATS:            return { type: MSG.ACK, stats: await getStats() };
      case MSG.GET_MODEL_STATUS:
        return {
          type: MSG.ACK,
          status: {
            embedder: embedder ? "ready" : embedderLoading ? "loading" : "idle",
            llm: llmEngine ? "ready" : llmUnsupported ? "unsupported" : llmLoading ? "loading" : "idle",
          },
        };
      case MSG.INIT_MODELS:          getEmbedder().catch((e)=>{ console.error("[DeepSurf:ERROR] Failed to init embedder:", e); }); getLLM().catch((e)=>{ console.error("[DeepSurf:ERROR] Failed to init LLM:", e); }); return { type: MSG.ACK };
      case MSG.GET_PAGES:            return { type: MSG.ACK, ...await getPages(msg.payload) };
      case MSG.DELETE_HISTORY:       await deleteHistory(msg.payload); return { type: MSG.ACK };
      case MSG.PRUNE_HISTORY:        await pruneHistory(msg.payload); return { type: MSG.ACK };
      case MSG.SYNC_HISTORY:         await syncHistory(msg.payload); return { type: MSG.ACK };

      case MSG.ANALYTICS_PULSE: {
        console.log(`[DeepSurf] Processing analytics pulse for domain: ${msg.payload.domain}`);
        const pgAnalytics = await initDB();
        await pgAnalytics.query(`
          INSERT INTO telemetry_pulses (
            id, session_id, domain, url, timestamp, active_seconds, 
            scroll_pixels_total, scroll_direction_changes, interaction_count, 
            mouse_distance_px, is_media_playing, has_text_selection
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        `, [
          msg.payload.id,
          msg.payload.sessionId,
          msg.payload.domain, 
          cleanUrlForDb(msg.payload.url), 
          msg.payload.timestamp, 
          msg.payload.activeSeconds, 
          msg.payload.scrollPixelsTotal, 
          msg.payload.scrollDirectionChanges,
          msg.payload.interactionCount,
          msg.payload.mouseDistancePx,
          msg.payload.isMediaPlaying,
          msg.payload.hasTextSelection
        ]);
        return { type: MSG.ACK };
      }

      case MSG.ANALYTICS_BATCH: {
        console.log(`[DeepSurf] Processing analytics batch (${msg.payload.length} pulses)`);
        const pgBatch = await initDB();
        if (msg.payload.length > 0) {
          const values = [];
          const params = [];
          for (let i = 0; i < msg.payload.length; i++) {
            const p = msg.payload[i];
            const offset = i * 12;
            values.push(`($${offset+1}, $${offset+2}, $${offset+3}, $${offset+4}, $${offset+5}, $${offset+6}, $${offset+7}, $${offset+8}, $${offset+9}, $${offset+10}, $${offset+11}, $${offset+12})`);
            params.push(
              p.id, p.sessionId, p.domain, cleanUrlForDb(p.url), p.timestamp, p.activeSeconds,
              p.scrollPixelsTotal, p.scrollDirectionChanges, p.interactionCount, p.mouseDistancePx,
              p.isMediaPlaying, p.hasTextSelection
            );
          }
          await pgBatch.query(`
            INSERT INTO telemetry_pulses (
              id, session_id, domain, url, timestamp, active_seconds, 
              scroll_pixels_total, scroll_direction_changes, interaction_count, 
              mouse_distance_px, is_media_playing, has_text_selection
            )
            VALUES ${values.join(", ")}
            ON CONFLICT (id) DO NOTHING
          `, params);
        }
        return { type: MSG.ACK };
      }

      case MSG.GET_BEHAVIORAL_STATS: {
        const pgStats = await initDB();

        const isDemoMode = msg.payload && msg.payload.isDemoMode ? true : false;

        const intervalDays = isDemoMode ? 91 : 30;
        const cutoffTime = Date.now() - intervalDays * 24 * 60 * 60 * 1000;
        
        console.log(`[DeepSurf] GET_BEHAVIORAL_STATS: querying last ${intervalDays} days (isDemoMode=${isDemoMode})`);
        
        const pulses = await pgStats.query(`
          SELECT * FROM telemetry_pulses 
          WHERE timestamp >= $1
          ORDER BY timestamp ASC
          LIMIT 5000
        `, [cutoffTime]);
        
        console.log(`[DeepSurf] GET_BEHAVIORAL_STATS: returning ${pulses.rows.length} rows`);
        return { type: MSG.ACK, data: pulses.rows };
      }

      case MSG.RESET_DEMO_DB:
        try {
          console.log("[DeepSurf] OFFSCREEN: RESET_DEMO_DB — truncating all tables...");
          const pgR = await initDB();
          const pgC = await initCanvasDB();
          await pgR.exec(`
            TRUNCATE TABLE telemetry_pulses;
            TRUNCATE TABLE pages CASCADE;
          `);
          await pgC.exec(`
            TRUNCATE TABLE canvas_edges;
            TRUNCATE TABLE canvas_nodes;
            TRUNCATE TABLE canvas_threads CASCADE;
          `);
          const afterReset = await Promise.all([
            pgR.query("SELECT COUNT(*) as c FROM telemetry_pulses"),
            pgR.query("SELECT COUNT(*) as c FROM pages"),
          ]);
          console.log("[DeepSurf] OFFSCREEN: Post-TRUNCATE counts:", {
            pulses: afterReset[0].rows[0].c,
            pages:  afterReset[1].rows[0].c,
          });
          return { type: MSG.ACK };
        } catch (err) {
          console.error("[DeepSurf] OFFSCREEN: RESET_DEMO_DB failed:", err);
          return { type: MSG.ERROR, error: err.message };
        }

      case MSG.INJECT_DEMO_PULSES:
        try {
          console.log("[DeepSurf] OFFSCREEN: Received payload", { pulses: msg.payload.pulses.length, pages: msg.payload.pages.length });
          const { pulses, pages, threads, nodes, edges } = msg.payload;

          const pgMain   = await initDB();
          const pgCanvas = await initCanvasDB();

          await pgMain.transaction(async (tx) => {
            console.log("[DeepSurf] OFFSCREEN: Start inserting pulses into main DB...");
            for (let i = 0; i < pulses.length; i++) {
              const p = pulses[i];
              await tx.query(
                `INSERT INTO telemetry_pulses (
                  id, session_id, domain, url, timestamp, active_seconds, 
                  scroll_pixels_total, scroll_direction_changes, interaction_count, 
                  mouse_distance_px, is_media_playing, has_text_selection
                ) 
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
                [
                  p.id,
                  p.sessionId,
                  p.domain, 
                  p.url || "", 
                  p.timestamp, 
                  Math.round(p.activeSeconds || 0),    
                  Math.round(p.scrollPixelsTotal || 0),
                  Math.round(p.scrollDirectionChanges || 0),
                  Math.round(p.interactionCount || 0),
                  Math.round(p.mouseDistancePx || 0),
                  p.isMediaPlaying || false,
                  p.hasTextSelection || false
                ]
              );
            }

            console.log("[DeepSurf] OFFSCREEN: Start inserting pages into main DB...");
            for (let i = 0; i < pages.length; i++) {
              const p = pages[i];
              await tx.query(
                `INSERT INTO pages (id, url, title, text, visited_at, embedding) 
                 VALUES ($1, $2, $3, $4, $5, $6::vector)
                 ON CONFLICT (url) DO UPDATE SET
                   title = EXCLUDED.title,
                   text = EXCLUDED.text,
                   visited_at = EXCLUDED.visited_at,
                   embedding = EXCLUDED.embedding`,
                [p.id, p.url, p.title || "", p.text || "", Math.round(p.visitedAt || Date.now()), p.embeddingLiteral]
              );
            }
          });

          const counts = await Promise.all([
            pgMain.query("SELECT COUNT(*) as count FROM telemetry_pulses"),
            pgMain.query("SELECT COUNT(*) as count FROM pages")
          ]);
          
          const pulseCount = Number(counts[0].rows[0].count);
          const pageCount = Number(counts[1].rows[0].count);
          
          console.log("[DeepSurf] OFFSCREEN: ACTUAL DB COUNTS AFTER INJECTION:", { pulses: pulseCount, pages: pageCount });

          if (pulseCount === 0 || pageCount === 0) {
             throw new Error(`Silent Transaction Rollback: Expected data but got Pulses: ${pulseCount}, Pages: ${pageCount}`);
          }

          await pgCanvas.transaction(async (tx) => {
            for (let i = 0; i < threads.length; i++) {
              const t = threads[i];
              await tx.query(
                `INSERT INTO canvas_threads (id, name, created_at) VALUES ($1, $2, $3)
                 ON CONFLICT (id) DO NOTHING`,
                [t.id, t.title, t.updatedAt]
              );
            }

            for (let i = 0; i < nodes.length; i++) {
              const n = nodes[i];
              await tx.query(
                `INSERT INTO canvas_nodes (id, thread_id, type, text, annotation, title, xpath, pos_x, pos_y, context_before, context_after, url, created_at, embedding) 
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NULL::vector)
                 ON CONFLICT (id) DO UPDATE SET text = EXCLUDED.text, pos_x = EXCLUDED.pos_x, pos_y = EXCLUDED.pos_y`,
                [
                  n.id, 
                  n.threadId || null, 
                  n.type || 'highlight', 
                  n.content || "", 
                  "", 
                  "", 
                  "", 
                  n.posX ?? -9999, 
                  n.posY ?? -9999, 
                  n.contextBefore || "", 
                  n.contextAfter || "", 
                  n.url || "", 
                  Date.now()
                ]
              );
            }

            for (let i = 0; i < edges.length; i++) {
              const edge = edges[i];
              const sourceNode = nodes.find(node => node.id === edge.sourceId);
              const edgeThreadId = sourceNode ? sourceNode.threadId : 'demo';
              await tx.query(
                `INSERT INTO canvas_edges (id, thread_id, source_id, target_id, score, manual, label, created_at) 
                 VALUES ($1, $2, $3, $4, $5, true, $6, $7)
                 ON CONFLICT (id) DO NOTHING`,
                [edge.id, edgeThreadId, edge.sourceId, edge.targetId, edge.score ?? 1.0, edge.label || "", Date.now()]
              );
            }
          });

          console.log("[DeepSurf] Demo State successfully written to PGlite.");
          await new Promise(resolve => setTimeout(resolve, 500));
          return { type: MSG.ACK };
          
        } catch (err) {
          console.error("[DeepSurf] Failed to inject demo state:", err);
          return { type: MSG.ERROR, error: err.message };
        }

      case MSG.CANVAS_GET_THREADS:   return { type: MSG.ACK, data: await canvasGetThreads() };
      case MSG.CANVAS_CREATE_THREAD: return { type: MSG.ACK, data: await canvasCreateThread(msg.payload) };
      case MSG.CANVAS_DELETE_THREAD: await canvasDeleteThread(msg.payload); return { type: MSG.ACK };
      case MSG.CANVAS_RENAME_THREAD: await canvasRenameThread(msg.payload); return { type: MSG.ACK };
      case MSG.CANVAS_GET_NODES:     return { type: MSG.ACK, data: await canvasGetNodes(msg.payload) };
      case MSG.CANVAS_GET_INBOX:      return { type: MSG.ACK, data: await canvasGetNodes({ threadId: null }) };
      case MSG.CANVAS_ADD_NODE:      return { type: MSG.ACK, data: await canvasAddNode(msg.payload) };
      case MSG.CANVAS_DELETE_NODE:   await canvasDeleteNode(msg.payload); return { type: MSG.ACK };
      case MSG.CANVAS_UPDATE_NODE:   await canvasUpdateNode(msg.payload); return { type: MSG.ACK };
      case MSG.CANVAS_GET_EDGES:     return { type: MSG.ACK, data: await canvasGetEdges(msg.payload) };
      case MSG.CANVAS_ADD_EDGE:      return { type: MSG.ACK, data: await canvasAddEdge(msg.payload) };
      case MSG.CANVAS_DELETE_EDGE:   await canvasDeleteEdge(msg.payload); return { type: MSG.ACK };
      case MSG.CANVAS_LABEL_EDGE:    await canvasLabelEdge(msg.payload); return { type: MSG.ACK };
      case MSG.GET_NODES_BY_URL:     return { type: MSG.ACK, data: await canvasGetNodesByUrl(msg.payload) };

      case MSG.KEEPALIVE: return { type: MSG.ACK };

      default:
        return { type: MSG.ERROR, error: `Unknown message type: ${msg.type}` };
    }
  };

  handle().then(sendResponse).catch((e) => sendResponse({ type: MSG.ERROR, error: e.message }));
  return true;
});

// Self-executing initialization routine: boots database connections, sends confirmation
// ready signals, and loads the embedder model defensively on startup.
(async () => {
  await initDB().catch((e) => { console.error("[DeepSurf:Offscreen] Failed to initialize database:", e); });
  chrome.runtime.sendMessage({ type: MSG.OFFSCREEN_READY_PING }).catch((e) => { console.error("[DeepSurf:Offscreen] Failed to send OFFSCREEN_READY_PING:", e); });
  console.log("[DeepSurf:Offscreen] Sending DB_READY ping.");
  chrome.runtime.sendMessage({ type: MSG.DB_READY }).catch(() => {});
  getEmbedder().catch((e) => { console.error("[DeepSurf:Offscreen] Failed to preload embedder on startup:", e); });
})();
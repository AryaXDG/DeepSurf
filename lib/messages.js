/**
 * @fileoverview Defines a frozen enumeration of Chrome extension IPC message types.
 *
 * Shared configuration imported by content scripts, offscreen documents, background workers, and front-end tabs to coordinate cross-context communication.
 */

/**
 * Frozen dictionary of inter-process communication (IPC) action type strings.
 * @type {Readonly<Object<string, string>>}
 */
export const MSG = Object.freeze({

  // We define life-cycle ping commands to verify offscreen document readiness and prevent service worker inactivation.
  OFFSCREEN_READY_PING: "OFFSCREEN_READY_PING",
  KEEPALIVE: "KEEPALIVE",
  DB_READY: "DB_READY",

  // We define page lifecycle messages to notify the extension when a page is read, rehydrated, or navigated.
  INGEST_PAGE: "INGEST_PAGE",
  SPA_NAVIGATION: "SPA_NAVIGATION",

  // We define search queries, chat operations, and LLM life-cycle parameters to coordinate model executions.
  SEARCH_HYBRID: "SEARCH_HYBRID",
  CHAT_STREAM_START: "CHAT_STREAM_START",
  CHAT_STREAM_ABORT: "CHAT_STREAM_ABORT",
  GET_STATS: "GET_STATS",
  GET_MODEL_STATUS: "GET_MODEL_STATUS",
  UNLOAD_LLM: "UNLOAD_LLM",
  SYNC_HISTORY: "SYNC_HISTORY",
  DELETE_HISTORY: "DELETE_HISTORY",
  GET_PAGES: "GET_PAGES",
  PRUNE_HISTORY: "PRUNE_HISTORY",
  SIMILARITY_MATCH: "SIMILARITY_MATCH",
  INIT_MODELS: "INIT_MODELS",

  // We define canvas-specific node and edge management events to persist research graph configurations.
  CANVAS_GET_THREADS: "CANVAS_GET_THREADS",
  CANVAS_CREATE_THREAD: "CANVAS_CREATE_THREAD",
  CANVAS_DELETE_THREAD: "CANVAS_DELETE_THREAD",
  CANVAS_RENAME_THREAD: "CANVAS_RENAME_THREAD",
  CANVAS_GET_NODES: "CANVAS_GET_NODES",
  CANVAS_GET_INBOX: "CANVAS_GET_INBOX",
  CANVAS_ADD_NODE: "CANVAS_ADD_NODE",
  CANVAS_DELETE_NODE: "CANVAS_DELETE_NODE",
  CANVAS_UPDATE_NODE: "CANVAS_UPDATE_NODE",
  GET_NODES_BY_URL: "GET_NODES_BY_URL",
  CANVAS_GET_EDGES: "CANVAS_GET_EDGES",
  CANVAS_ADD_EDGE: "CANVAS_ADD_EDGE",
  CANVAS_DELETE_EDGE: "CANVAS_DELETE_EDGE",
  CANVAS_LABEL_EDGE: "CANVAS_LABEL_EDGE",
  CANVAS_OPEN_PICKER: "CANVAS_OPEN_PICKER",
  GET_PENDING_HIGHLIGHT: "GET_PENDING_HIGHLIGHT",

  // We define behavioral analytics and demo database overrides to isolate test traffic from actual usage telemetry.
  ANALYTICS_PULSE: "ANALYTICS_PULSE",
  ANALYTICS_BATCH: "ANALYTICS_BATCH",
  GET_BEHAVIORAL_STATS: "GET_BEHAVIORAL_STATS",
  INJECT_DEMO_PULSES: "INJECT_DEMO_PULSES",
  RESET_DEMO_DB: "RESET_DEMO_DB",

  // We define response state parameters to stream model tokens or return processing errors to visual consumers.
  CHAT_TOKEN: "CHAT_TOKEN",
  CHAT_DONE: "CHAT_DONE",
  CHAT_ERROR: "CHAT_ERROR",
  MODEL_STATUS_UPDATE: "MODEL_STATUS_UPDATE",

  ACK: "ACK",
  ERROR: "ERROR",
});
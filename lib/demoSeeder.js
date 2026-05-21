/**
 * @fileoverview Generates a 90-day simulated dataset of user interactions, search indexes, and canvas structures to seed the local databases for user onboarding.
 *
 * Executed on-demand during extension onboarding or diagnostics setup to populate the client-side system offline. Clears all existing tables in the active PGlite/IndexedDB instances, updates Chrome storage states, and sends message requests to offscreen database endpoints.
 */

import { urlToId } from "./utils.js";
import { MSG } from "./messages.js";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const NOW = Date.now();
const NINETY_DAYS_AGO = NOW - 90 * 24 * 60 * 60 * 1000;

const DOMAIN_REGISTRY = {
  "github.com":              { cat: "work",        baseActive: 420, baseScroll: 600,  baseInteract: 15, mouseDist: 1200, scrollChanges: 3,  mediaProb: 0.0,  textSelProb: 0.6, urls: ["/pulls", "/issues", "/notifications", "/explore", "/settings"] },
  "stackoverflow.com":       { cat: "work",        baseActive: 360, baseScroll: 900,  baseInteract: 8,  mouseDist: 800,  scrollChanges: 4,  mediaProb: 0.0,  textSelProb: 0.7, urls: ["/questions", "/tags/javascript", "/tags/svelte", "/tags/typescript", "/search?q=pglite"] },
  "developer.mozilla.org":   { cat: "work",        baseActive: 300, baseScroll: 700,  baseInteract: 5,  mouseDist: 600,  scrollChanges: 2,  mediaProb: 0.0,  textSelProb: 0.8, urls: ["/en-US/docs/Web/JavaScript", "/en-US/docs/Web/API", "/en-US/docs/Web/CSS"] },
  "svelte.dev":              { cat: "work",        baseActive: 480, baseScroll: 1100, baseInteract: 12, mouseDist: 900,  scrollChanges: 5,  mediaProb: 0.0,  textSelProb: 0.65, urls: ["/docs", "/repl", "/docs/runes", "/docs/stores"] },
  "react.dev":               { cat: "work",        baseActive: 280, baseScroll: 750,  baseInteract: 7,  mouseDist: 700,  scrollChanges: 3,  mediaProb: 0.0,  textSelProb: 0.6, urls: ["/learn", "/reference/react", "/reference/react-dom"] },
  "vitejs.dev":              { cat: "work",        baseActive: 200, baseScroll: 500,  baseInteract: 5,  mouseDist: 450,  scrollChanges: 2,  mediaProb: 0.0,  textSelProb: 0.5, urls: ["/guide", "/config", "/plugins"] },
  "vercel.com":              { cat: "work",        baseActive: 180, baseScroll: 400,  baseInteract: 10, mouseDist: 900,  scrollChanges: 2,  mediaProb: 0.0,  textSelProb: 0.3, urls: ["/dashboard", "/docs", "/templates"] },
  "aws.amazon.com":          { cat: "work",        baseActive: 250, baseScroll: 600,  baseInteract: 14, mouseDist: 1100, scrollChanges: 4,  mediaProb: 0.0,  textSelProb: 0.4, urls: ["/ec2", "/s3", "/lambda", "/console"] },
  "typescriptlang.org":      { cat: "work",        baseActive: 240, baseScroll: 650,  baseInteract: 6,  mouseDist: 550,  scrollChanges: 2,  mediaProb: 0.0,  textSelProb: 0.75, urls: ["/docs/handbook", "/tsconfig", "/play"] },
  "tailwindcss.com":         { cat: "work",        baseActive: 160, baseScroll: 400,  baseInteract: 8,  mouseDist: 700,  scrollChanges: 2,  mediaProb: 0.0,  textSelProb: 0.45, urls: ["/docs", "/docs/flex", "/docs/grid"] },
  "supabase.com":            { cat: "work",        baseActive: 290, baseScroll: 700,  baseInteract: 11, mouseDist: 850,  scrollChanges: 3,  mediaProb: 0.0,  textSelProb: 0.55, urls: ["/docs", "/dashboard", "/blog/pglite"] },
  "nodejs.org":              { cat: "work",        baseActive: 200, baseScroll: 500,  baseInteract: 5,  mouseDist: 500,  scrollChanges: 2,  mediaProb: 0.0,  textSelProb: 0.6, urls: ["/en/docs", "/en/download"] },
  // ── AI / Research ──
  "arxiv.org":               { cat: "ai",          baseActive: 1800, baseScroll: 1200, baseInteract: 4,  mouseDist: 400,  scrollChanges: 2,  mediaProb: 0.0,  textSelProb: 0.85, urls: ["/abs/2405.01234", "/search/?query=llm+agents", "/abs/2312.00752", "/abs/2404.19756"] },
  "huggingface.co":          { cat: "ai",          baseActive: 360, baseScroll: 800,  baseInteract: 10, mouseDist: 750,  scrollChanges: 3,  mediaProb: 0.0,  textSelProb: 0.55, urls: ["/models", "/datasets", "/spaces", "/blog/smollm2"] },
  "anthropic.com":           { cat: "ai",          baseActive: 540, baseScroll: 900,  baseInteract: 8,  mouseDist: 700,  scrollChanges: 3,  mediaProb: 0.0,  textSelProb: 0.7, urls: ["/news", "/research", "/docs"] },
  "openai.com":              { cat: "ai",          baseActive: 480, baseScroll: 800,  baseInteract: 9,  mouseDist: 700,  scrollChanges: 3,  mediaProb: 0.0,  textSelProb: 0.65, urls: ["/blog", "/research", "/docs/api-reference"] },
  "paperswithcode.com":      { cat: "ai",          baseActive: 420, baseScroll: 1000, baseInteract: 7,  mouseDist: 600,  scrollChanges: 3,  mediaProb: 0.0,  textSelProb: 0.75, urls: ["/sota", "/methods", "/paper/attention-is-all-you-need"] },
  "replicate.com":           { cat: "ai",          baseActive: 240, baseScroll: 500,  baseInteract: 12, mouseDist: 900,  scrollChanges: 2,  mediaProb: 0.0,  textSelProb: 0.3, urls: ["/explore", "/docs", "/pricing"] },
  // ── Productivity ──
  "linear.app":              { cat: "productivity", baseActive: 540, baseScroll: 300,  baseInteract: 45, mouseDist: 2500, scrollChanges: 3,  mediaProb: 0.0,  textSelProb: 0.2, urls: ["/issues", "/projects", "/cycles", "/triage"] },
  "notion.so":               { cat: "productivity", baseActive: 720, baseScroll: 800,  baseInteract: 35, mouseDist: 1800, scrollChanges: 4,  mediaProb: 0.0,  textSelProb: 0.4, urls: ["/workspace", "/wiki", "/roadmap"] },
  "figma.com":               { cat: "productivity", baseActive: 900, baseScroll: 200,  baseInteract: 80, mouseDist: 5000, scrollChanges: 5,  mediaProb: 0.0,  textSelProb: 0.1, urls: ["/files/recent", "/file/demofile", "/community"] },
  "slack.com":               { cat: "productivity", baseActive: 300, baseScroll: 500,  baseInteract: 60, mouseDist: 2000, scrollChanges: 8,  mediaProb: 0.05, textSelProb: 0.2, urls: ["/app", "/channel/engineering", "/channel/general"] },
  "miro.com":                { cat: "productivity", baseActive: 600, baseScroll: 100,  baseInteract: 40, mouseDist: 4000, scrollChanges: 2,  mediaProb: 0.0,  textSelProb: 0.1, urls: ["/app/board", "/app/templates"] },
  // ── Distraction — Social ──
  "reddit.com":              { cat: "distraction",  baseActive: 420, baseScroll: 8000, baseInteract: 25, mouseDist: 3000, scrollChanges: 15, mediaProb: 0.1,  textSelProb: 0.15, urls: ["/r/programming", "/r/javascript", "/r/sveltejs", "/r/LocalLLaMA", "/r/cscareerquestions"] },
  "news.ycombinator.com":    { cat: "distraction",  baseActive: 300, baseScroll: 4000, baseInteract: 18, mouseDist: 1500, scrollChanges: 10, mediaProb: 0.0,  textSelProb: 0.25, urls: ["/news", "/newest", "/ask", "/show"] },
  "twitter.com":             { cat: "distraction",  baseActive: 360, baseScroll: 12000, baseInteract: 30, mouseDist: 4000, scrollChanges: 20, mediaProb: 0.2,  textSelProb: 0.1, urls: ["/home", "/notifications", "/i/bookmarks"] },
  // ── Distraction — Video ──
  "youtube.com":             { cat: "video",        baseActive: 2400, baseScroll: 100,  baseInteract: 8,  mouseDist: 800,  scrollChanges: 1,  mediaProb: 0.95, textSelProb: 0.05, urls: ["/watch?v=dQw4w9WgXcQ", "/feed/subscriptions", "/results?search_query=svelte+5+tutorial", "/watch?v=webgpu-intro"] },
  "netflix.com":             { cat: "video",        baseActive: 5400, baseScroll: 50,   baseInteract: 3,  mouseDist: 300,  scrollChanges: 0,  mediaProb: 0.98, textSelProb: 0.0,  urls: ["/browse", "/title/81040344"] },
  "twitch.tv":               { cat: "video",        baseActive: 3600, baseScroll: 200,  baseInteract: 15, mouseDist: 1200, scrollChanges: 2,  mediaProb: 0.92, textSelProb: 0.05, urls: ["/directory/game/Science%20%26%20Technology", "/theprimeagen", "/fireship_dev"] },
};

const DOMAIN_KEYS = Object.keys(DOMAIN_REGISTRY);

const PAGE_CONTENT = {
  "github.com": [
    { title: "sveltejs/svelte: Cybernetically enhanced web apps", text: "Svelte is a new way to build web applications. It's a compiler that takes your declarative components and converts them into efficient JavaScript that surgically updates the DOM. Learn about Svelte 5 runes, reactivity model, and migration guides from Svelte 4." },
    { title: "vercel/next.js: The React Framework for the Web", text: "Next.js enables you to create full-stack web applications by extending the latest React features. App router, server components, streaming, and the new Turbopack bundler are transforming how developers build production-grade applications." },
    { title: "PGlite: Lightweight WASM Postgres for browser", text: "PGlite is a WASM Postgres build packaged into a TypeScript client library that enables you to run Postgres in the browser, Node.js, Bun and Deno with no server required. It has grown to support pgvector for embedding storage and hybrid search." },
    { title: "biomejs/biome: Fast formatter for JavaScript, TypeScript", text: "Biome formats and lints JavaScript, TypeScript, JSX, TSX, JSON, CSS in milliseconds. It is designed to eventually replace Prettier and ESLint. Zero config, Rust-powered, with IDE integration and CI support baked in." },
  ],
  "stackoverflow.com": [
    { title: "How do I use $state and $derived runes in Svelte 5?", text: "In Svelte 5, reactivity is now explicit. Use $state() to declare reactive variables and $derived() to compute values from them. Unlike Svelte 4, reactive declarations no longer use $: label syntax. The new model aligns with signals-based reactivity found in frameworks like Solid." },
    { title: "TypeScript: Difference between type and interface", text: "Both type aliases and interfaces can describe object shapes in TypeScript, but they differ in key ways. Interfaces support declaration merging — you can declare the same interface multiple times and TypeScript merges them. Types support union and intersection types directly. In practice, prefer interfaces for public API shapes and types for unions." },
    { title: "Why is my useEffect running twice in React 18?", text: "React 18 StrictMode intentionally mounts components twice in development to help detect side effects. This is expected behavior. Your cleanup function will run between the two mounts. The double invocation does not happen in production builds. Ensure your effects return proper cleanup functions." },
  ],
  "arxiv.org": [
    { title: "Attention Is All You Need (Vaswani et al., 2017)", text: "The dominant sequence transduction models are based on complex recurrent or convolutional neural networks. We propose a new simple network architecture, the Transformer, based solely on attention mechanisms, dispensing with recurrence and convolutions entirely. On two machine translation tasks, these models are superior in quality while being more parallelizable." },
    { title: "LLM Agents: Survey of Autonomous Reasoning Systems", text: "Large language models have demonstrated remarkable capacity for tool use, planning, and multi-step reasoning. This survey covers ReAct, Reflexion, AutoGPT-style agents, multi-agent debate, and tree-of-thought prompting. We identify open challenges in grounding, memory retrieval, and failure recovery." },
    { title: "WebGPU-Accelerated Inference for On-Device LLMs", text: "Running inference on-device removes privacy risks and latency of cloud APIs. This paper evaluates WebGPU compute shaders for transformer inference in browser environments. We benchmark Mistral 7B and Llama 3 8B quantized with GGUF, achieving 12–18 tokens/second on consumer GPUs via WebGPU with MLC-LLM and WebLLM." },
    { title: "SmolLM2: Surprisingly Capable Small Language Models", text: "We present SmolLM2, a family of compact language models at 135M, 360M and 1.7B parameters, trained on a carefully curated 11 trillion token dataset. SmolLM2-1.7B outperforms Qwen2.5-1.5B and Llama-3.2-1B on diverse benchmarks. The models are designed for on-device use cases including browser extensions and edge deployments." },
  ],
  "huggingface.co": [
    { title: "SmolLM2 · Hugging Face Model Hub", text: "SmolLM2 is a family of compact language models in 135M, 360M, and 1.7B parameter sizes. They are designed for on-device inference, achieving strong performance on reasoning and instruction-following tasks. Available in base and instruct variants, with GGUF quantizations for llama.cpp and WebLLM." },
    { title: "Transformers.js: Run Hugging Face models in browser", text: "Transformers.js is a JavaScript port of the Hugging Face transformers library. It allows you to run pre-trained models directly in the browser or Node.js using ONNX Runtime. Supports text classification, NER, question answering, text generation, and embedding models — enabling semantic search without a backend." },
  ],
  "anthropic.com": [
    { title: "Claude 3.5 Sonnet: New capabilities overview", text: "Claude 3.5 Sonnet introduces computer use capabilities, enabling Claude to interact with desktop applications, take screenshots, and perform tasks autonomously. This represents a major step toward AI agents that can operate real-world software tools. The model also demonstrates improved coding and reasoning performance." },
    { title: "Constitutional AI: Harmlessness from AI Feedback", text: "Constitutional AI is a technique for training AI systems that are helpful, harmless, and honest using AI feedback rather than human labeling alone. A set of principles — the constitution — guides the model's self-critique and revision process, reducing reliance on human annotators for sensitive content judgments." },
  ],
  "reddit.com": [
    { title: "r/sveltejs: Svelte 5 is now stable — megathread", text: "Rich Harris just announced Svelte 5 is production-ready. The runes system, snippets, and the new event handler syntax are all in. Migration from Svelte 4 is mostly automated via the official migration tool. Discussion: is the learning curve worth it over React? Most replies say yes for new projects." },
    { title: "r/LocalLLaMA: Best models to run on 16GB VRAM?", text: "For 16GB VRAM, the community consensus is Mistral 7B Q8 or Llama 3.1 8B Q6_K giving best quality-per-VRAM. Qwen2.5-14B at Q4_K_M also fits and punches above its weight on coding tasks. Use llama.cpp with CUDA backend or Ollama for easiest setup." },
    { title: "r/programming: Why are browser extensions so painful to build?", text: "The manifest v3 migration removed background pages, requiring offscreen documents for persistent computation. This broke virtually every extension that relied on long-running background scripts. IndexedDB, WebAssembly, and service worker lifetime restrictions add complexity. The Chrome team's explanations have not satisfied the developer community." },
  ],
  "news.ycombinator.com": [
    { title: "Ask HN: What's your browser extension stack in 2025?", text: "Top answers: Plasmo framework for build tooling, WXT as an alternative with better HMR. Svelte or vanilla JS for UI due to bundle size constraints. PGlite for local-first SQLite/Postgres. The community is moving away from React in extensions due to overhead. Many recommend starting with the WXT + Svelte template." },
    { title: "Show HN: I built a local-first semantic search engine that runs in browser", text: "Uses PGlite with pgvector, transformers.js for embeddings (all-MiniLM-L6-v2), and a custom BM25 implementation in Postgres. Indexes pages as you browse. No backend, no data leaves your machine. Full hybrid search in under 200ms on 10,000 documents. Source on GitHub. Comments debate privacy trade-offs and battery impact." },
  ],
  "youtube.com": [
    { title: "Svelte 5 in 100 Seconds — Fireship", text: "Fireship's signature fast-paced overview of Svelte 5's runes system. Covers $state, $derived, $effect, $props in 100 seconds. Comments section debates whether runes make Svelte more or less beginner-friendly. 2.4M views." },
    { title: "I tried to run an LLM in a Chrome Extension — and it worked", text: "A developer documents running WebLLM with Phi-3 mini inside a Chrome extension using a service worker and shared memory. Performance is acceptable for short prompts. The video covers Manifest V3 limitations, SharedArrayBuffer CORS headers, and WASM memory constraints. 340K views." },
    { title: "Why I Switched from React to Svelte for My SaaS", text: "A founder documents their migration from Next.js to SvelteKit for a B2B SaaS product. Key reasons: smaller bundle, better DX, less boilerplate. Build times dropped 60%. The video goes deep on SSR strategy, form actions, and load functions. 180K views." },
  ],
  "linear.app": [
    { title: "DeepSurf — Sprint 7 Active Issues", text: "Current sprint covers: canvas edge persistence bug, analytics processor refactor for PGlite, demo mode data quality improvements, hybrid search ranking tuning. P0: fix embedding insertion on cold start. P1: session boundary detection in behavioral analytics." },
  ],
  "notion.so": [
    { title: "DeepSurf Product Roadmap — Q2 2025", text: "Phase 1: Core search quality (hybrid BM25 + vector). Phase 2: Behavioral analytics dashboard. Phase 3: Research canvas with semantic edge detection. Phase 4: Demo mode and onboarding polish. Open questions: monetization model, privacy policy, Chrome Web Store review process." },
    { title: "Architecture Notes: PGlite + pgvector in Offscreen Document", text: "The offscreen document pattern sidesteps service worker memory limits. PGlite runs in a hidden iframe-like context with persistent IndexedDB backing. pgvector HNSW index enables sub-100ms ANN search across 10K embeddings. Embedding model: all-MiniLM-L6-v2 via transformers.js, 384 dimensions." },
  ],
  "figma.com": [
    { title: "DeepSurf UI Kit — Sidepanel Components", text: "Design system for the DeepSurf Chrome Extension sidepanel. Includes: SearchBar, ResultCard, ChatMessage, ResearchCanvas, AnalyticsTab, ManageTab components. Uses CSS custom properties for theme compatibility. Dark mode first." },
  ],
};

const GENERIC_CONTENT = [
  "This page covers modern web development practices with a focus on developer experience and performance. Topics include build tooling, component architecture, state management, and deployment strategies.",
  "Technical documentation and reference material for developers building production applications. Includes API references, guides, and community-contributed examples.",
  "Research and discussion around machine learning, large language models, and AI-assisted developer tools. Covers both theoretical foundations and practical implementation details.",
  "A collection of insights, tutorials, and case studies from practitioners in software development, covering frontend engineering, backend systems, and infrastructure.",
];

/**
 * Generates a random, L2-normalized 384-dimensional floating-point array serialized to a Postgres pgvector literal.
 * @returns {string} The bracket-wrapped coordinates string (e.g. "[0.1,0.2,...]").
 */
function generateMockEmbedding() {
  const vec = new Float32Array(384);
  let sumSq = 0;
  for (let i = 0; i < 384; i++) {
    vec[i] = Math.random() * 2 - 1;
    sumSq += vec[i] * vec[i];
  }
  const norm = Math.sqrt(sumSq);
  for (let i = 0; i < 384; i++) vec[i] /= norm;
  return "[" + Array.from(vec).join(",") + "]";
}

/**
 * Generates a random value using a Gaussian (normal) distribution.
 * @param {number} mean - The center peak value of the distribution.
 * @param {number} stdDev - The standard deviation width coefficient.
 * @param {number} [min=0] - The lower bound clamp threshold.
 * @param {number} [max=Infinity] - The upper bound clamp threshold.
 * @returns {number} The generated random value clamped to the specified boundaries.
 */
function gaussian(mean, stdDev, min = 0, max = Infinity) {
  const u = 1 - Math.random();
  const v = Math.random();
  const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  return Math.max(min, Math.min(max, mean + z * stdDev));
}

/**
 * Applies a random percentage offset to a base number.
 * @param {number} base - The target number to shift.
 * @param {number} [fraction=0.3] - The maximum percentage range (+/-) of the shift.
 * @returns {number} The integer value after applying random variation.
 */
function jitter(base, fraction = 0.3) {
  return Math.round(base * (1 + (Math.random() - 0.5) * 2 * fraction));
}

/**
 * Picks a random key from a dictionary based on relative numerical weights.
 * @param {Object<string, number>} weightMap - A dictionary mapping choice labels to weight values.
 * @returns {string} The chosen dictionary key.
 */
function weightedPick(weightMap) {
  const total = Object.values(weightMap).reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (const [k, w] of Object.entries(weightMap)) {
    r -= w;
    if (r <= 0) return k;
  }
  return Object.keys(weightMap)[0];
}

/**
 * Returns a weight coefficient representing general user browsing activity likelihood based on the hour of the day.
 * @param {number} hour - The hour value (0 to 23).
 * @returns {number} Activity factor between 0.0 (inactive/sleeping) and 1.0 (peak working hour).
 */
function hourActivityMultiplier(hour) {
  const curve = [
    0.0, 0.0, 0.0, 0.0, 0.0, 0.0,  // 0–5 AM: sleeping
    0.1, 0.3, 0.7,                  // 6–8 AM: morning routine
    1.0, 1.0, 0.9,                  // 9–11 AM: deep work
    0.4, 0.2, 0.8,                  // 12–2 PM: lunch dip then back
    0.9, 0.9, 0.8,                  // 3–5 PM: afternoon work
    0.6, 0.3, 0.1,                  // 6–8 PM: wind-down / dinner
    0.5, 0.7, 0.5, 0.2,             // 9 PM–midnight: evening browsing
  ];
  return curve[Math.max(0, Math.min(23, hour))] || 0;
}


/**
 * Dynamically computes visit weight factors for host domains based on contextual factors like time of day and user focus state.
 * @param {Object} context - The current simulation context details.
 * @param {number} context.hour - Active hour of the day (0-23).
 * @param {boolean} context.isWeekend - Whether the current day is a weekend.
 * @param {number} context.distractionStreak - Count of consecutive distraction domain visits.
 * @param {number} context.deepWorkStreak - Count of consecutive productivity domain visits.
 * @returns {Object<string, number>} Dictionary mapping domain names to their computed relative selection weights.
 */
function buildDomainWeights({ hour, isWeekend, distractionStreak, deepWorkStreak }) {
  let weights = {};

  if (!isWeekend && hour >= 9 && hour < 12) {
    weights = { work: 55, ai: 20, productivity: 20, distraction: 3, video: 2 };
    if (deepWorkStreak > 3) weights.distraction += 5;
  } else if (!isWeekend && hour >= 12 && hour < 14) {
    weights = { work: 15, ai: 15, productivity: 10, distraction: 40, video: 20 };
  } else if (!isWeekend && hour >= 14 && hour < 18) {
    weights = { work: 45, ai: 25, productivity: 20, distraction: 7, video: 3 };
  } else if (!isWeekend && hour >= 18 && hour < 21) {
    weights = { work: 10, ai: 15, productivity: 5, distraction: 40, video: 30 };
  } else if (hour >= 21 || hour < 2) {
    weights = { work: 10, ai: 25, productivity: 5, distraction: 30, video: 30 };
  } else if (isWeekend && hour >= 10 && hour < 18) {
    weights = { work: 20, ai: 25, productivity: 5, distraction: 30, video: 20 };
  } else {
    weights = { work: 5, ai: 10, productivity: 5, distraction: 50, video: 30 };
  }

  if (distractionStreak > 2) {
    const boost = Math.min(25, distractionStreak * 5);
    weights.distraction = (weights.distraction || 0) + boost;
    weights.video = (weights.video || 0) + boost * 0.5;
  }

  const isFriday = !isWeekend;
  if (isFriday && hour >= 15) {
    weights.video = (weights.video || 0) + 15;
    weights.distraction = (weights.distraction || 0) + 10;
  }

  const categoryMembers = {
    work:         ["github.com", "stackoverflow.com", "developer.mozilla.org", "svelte.dev", "react.dev", "vitejs.dev", "vercel.com", "aws.amazon.com", "typescriptlang.org", "tailwindcss.com", "supabase.com", "nodejs.org"],
    ai:           ["arxiv.org", "huggingface.co", "anthropic.com", "openai.com", "paperswithcode.com", "replicate.com"],
    productivity: ["linear.app", "notion.so", "figma.com", "slack.com", "miro.com"],
    distraction:  ["reddit.com", "news.ycombinator.com", "twitter.com"],
    video:        ["youtube.com", "netflix.com", "twitch.tv"],
  };

  const result = {};
  for (const [cat, catWeight] of Object.entries(weights)) {
    const members = categoryMembers[cat] || [];
    for (const domain of members) {
      const affinity = ALEX_AFFINITY[domain] || 1.0;
      result[domain] = (catWeight / members.length) * affinity;
    }
  }
  return result;
}

const ALEX_AFFINITY = {
  "github.com":           2.5,
  "stackoverflow.com":    2.0,
  "svelte.dev":           2.0,
  "youtube.com":          2.2,
  "reddit.com":           1.8,
  "news.ycombinator.com": 1.8,
  "arxiv.org":            1.6,
  "anthropic.com":        1.4,
  "linear.app":           1.5,
  "figma.com":            1.3,
  "netflix.com":          0.5,
  "aws.amazon.com":       0.7,
  "miro.com":             0.6,
};

const PAGE_TEMPLATES = {
  "github.com":            (i) => `${["Pull Request #", "Issue #"][i%2]}${500+i} · ${["sveltejs/svelte","vercel/next.js","electric-sql/pglite","biomejs/biome"][i%4]}`,
  "stackoverflow.com":     (i) => `${["How to", "Why does", "Best practice for", "Difference between"][i%4]} ${["TypeScript generics", "Svelte 5 runes", "async/await in loops", "CSS grid auto-fill"][i%4]}?`,
  "developer.mozilla.org": (i) => `${["Array.prototype.flatMap","Promise.allSettled","CSS Container Queries","Web Workers API","Intersection Observer"][i%5]} — MDN Web Docs`,
  "arxiv.org":             (i) => `[${2024 + (i%2)}.${10000+i*37}] ${["Scaling Laws for","Emergent Abilities of","Constitutional AI:","Chain-of-Thought Prompting for"][i%4]} Language Models`,
  "youtube.com":           (i) => `${["Svelte 5 in 100 Seconds","I built X in Y hours","Why I quit React","The BEST way to"][i%4]} — ${["Fireship","Theo","ThePrimeagen","Computerphile"][i%4]}`,
  "reddit.com":            (i) => `r/${["sveltejs","LocalLLaMA","programming","javascript","webdev"][i%5]}: ${["Hot takes","Discussion","Show Reddit:","My experience with"][i%4]} ${["Svelte 5","local LLMs","Chrome extensions","TypeScript"][i%4]}`,
  "linear.app":            (i) => `DS-${100+i}: ${["Fix embedding cold start","Refactor analytics processor","Canvas edge persistence","Demo data quality"][i%4]}`,
  "notion.so":             (i) => `${["Architecture Notes","Product Roadmap","Sprint Planning","Tech Debt Log"][i%4]} — DeepSurf`,
};

/**
 * Formats a synthetic web page title for a host domain.
 * @param {string} domain - The host website name.
 * @param {number} index - Sequential page identifier index.
 * @returns {string} The generated page title.
 */
function getPageTitle(domain, index) {
  const tplFn = PAGE_TEMPLATES[domain];
  if (tplFn) return tplFn(index);
  const reg = DOMAIN_REGISTRY[domain];
  if (reg?.urls?.length) return `${domain}${reg.urls[index % reg.urls.length]}`;
  return `Resource ${index} — ${domain}`;
}

/**
 * Resolves a body text excerpt matching a domain to simulate parsed web contents.
 * @param {string} domain - The host website name.
 * @param {number} index - Sequential page identifier index.
 * @returns {string} The mock page text.
 */
function getPageText(domain, index) {
  const pool = PAGE_CONTENT[domain];
  if (pool?.length) return pool[index % pool.length].text;
  return GENERIC_CONTENT[index % GENERIC_CONTENT.length];
}

/**
 * Formats a valid web address for a simulated page.
 * @param {string} domain - The host website name.
 * @param {number} index - Sequential page identifier index.
 * @returns {string} The compiled URL string.
 */
function getPageUrl(domain, index) {
  const reg = DOMAIN_REGISTRY[domain];
  if (reg?.urls?.length) return `https://${domain}${reg.urls[index % reg.urls.length]}`;
  return `https://${domain}/page/${index}`;
}

const CANVAS_THREADS = [
  {
    id: "thread_svelte5_runes",
    title: "Svelte 5 Rune System Deep Dive",
    nodes: [
      { type: "note",      content: "Svelte 5 replaces reactive declarations ($:) with explicit runes: $state(), $derived(), $effect(), $props(). This is a breaking change but aligns Svelte with the broader signals ecosystem." },
      { type: "highlight", content: "Unlike Svelte 4's autosubscriptions, $state uses Proxy-based fine-grained reactivity. Only the specific properties that changed trigger updates.", contextBefore: "The Svelte team explains that", contextAfter: "This eliminates entire categories of over-rendering bugs." },
      { type: "url",       content: "Svelte 5 runes RFC discussion on GitHub", url: "https://github.com/sveltejs/rfcs/pull/50" },
      { type: "note",      content: "Snippets replace slots for component composition. #snippet blocks are reusable, typed, and can be passed as props. Far cleaner than slot fallbacks in Svelte 4." },
      { type: "url",       content: "Official Svelte 5 migration guide", url: "https://svelte.dev/docs/svelte/v5-migration-guide" },
      { type: "highlight", content: "$derived.by() accepts a function for complex derivations spanning multiple reactive sources. Equivalent to a memoized computed property.", contextBefore: "For cases where simple $derived expressions aren't enough,", contextAfter: "" },
      { type: "note",      content: "Breaking: event handlers are now standard DOM events. on:click becomes onclick. The old directive syntax is deprecated. Unlearn muscle memory." },
    ],
    edges: [
      { sourceIdx: 0, targetIdx: 1, label: "explains" },
      { sourceIdx: 0, targetIdx: 3, label: "related to" },
      { sourceIdx: 1, targetIdx: 5, label: "supports" },
      { sourceIdx: 2, targetIdx: 0, label: "related to" },
      { sourceIdx: 4, targetIdx: 6, label: "related to" },
      { sourceIdx: 3, targetIdx: 4, label: "supports" },
    ]
  },
  {
    id: "thread_local_llm_browser",
    title: "Running LLMs in Browser Extensions",
    nodes: [
      { type: "note",      content: "WebGPU enables GPU-accelerated compute in browser contexts. Combined with WASM, it's now feasible to run quantized LLMs (4-bit, 8-bit) at 10–20 tokens/sec on modern consumer GPUs." },
      { type: "url",       content: "WebLLM: In-browser LLM inference with WebGPU", url: "https://webllm.mlc.ai/" },
      { type: "highlight", content: "SharedArrayBuffer is required for multi-threaded WASM inference but demands CORP and COOP headers. Chrome extensions can set these via the declarativeNetRequest API.", contextBefore: "The key blocker for WASM threads in extensions is that", contextAfter: "This is non-trivial to configure correctly." },
      { type: "note",      content: "Offscreen documents (Manifest V3) are ideal for LLM inference — they persist longer than service workers and can access the full Web APIs including WebGPU." },
      { type: "url",       content: "MLC-LLM GGUF models on Hugging Face", url: "https://huggingface.co/mlc-ai" },
      { type: "highlight", content: "SmolLM2-1.7B-Instruct-q4f16_1 fits in ~1GB GPU memory and produces coherent summaries. Latency is ~500ms TTFT on an RTX 3070. Acceptable for async sidebar UX.", contextBefore: "For a production browser extension,", contextAfter: "" },
      { type: "note",      content: "Fallback strategy: if WebGPU unavailable, route to Claude API with user's key. Give users clear status via ModelStatus component. Never fail silently." },
    ],
    edges: [
      { sourceIdx: 0, targetIdx: 1, label: "enables" },
      { sourceIdx: 0, targetIdx: 3, label: "related to" },
      { sourceIdx: 2, targetIdx: 3, label: "supports" },
      { sourceIdx: 1, targetIdx: 4, label: "related to" },
      { sourceIdx: 4, targetIdx: 5, label: "supports" },
      { sourceIdx: 5, targetIdx: 6, label: "related to" },
    ]
  },
  {
    id: "thread_pglite_hybrid_search",
    title: "PGlite + pgvector Hybrid Search Architecture",
    nodes: [
      { type: "note",      content: "Hybrid search combines BM25 (lexical) and cosine similarity (semantic) scores. Neither alone is sufficient: BM25 misses paraphrases; pure vector search misses exact keyword matches." },
      { type: "highlight", content: "Reciprocal Rank Fusion (RRF) is the simplest effective fusion: score = Σ 1/(k + rank_i) for each result list. k=60 is the standard default.", contextBefore: "For combining BM25 and vector rankings without tuning weights,", contextAfter: "No learned weights needed — robust across domains." },
      { type: "url",       content: "PGlite with pgvector: HNSW index in browser", url: "https://pglite.dev/docs/extensions/pgvector" },
      { type: "note",      content: "all-MiniLM-L6-v2 produces 384-dim embeddings in ~15ms via transformers.js. The small size is critical — larger models (768-dim) are 3x slower and unnecessary for short web page snippets." },
      { type: "url",       content: "Postgres full-text search: tsvector and tsquery", url: "https://www.postgresql.org/docs/current/textsearch.html" },
      { type: "highlight", content: "GIN index on to_tsvector column enables fast BM25-equivalent search in Postgres. The index is built at INSERT time and updated incrementally on UPSERT.", contextBefore: "For the lexical side of hybrid search,", contextAfter: "Query time is typically under 5ms on 10K documents." },
      { type: "note",      content: "Bottleneck: embedding generation is the main cost (~15ms per page). Index updates are fast. Pre-compute and cache embeddings during page visit, not at query time." },
    ],
    edges: [
      { sourceIdx: 0, targetIdx: 1, label: "explains" },
      { sourceIdx: 0, targetIdx: 3, label: "related to" },
      { sourceIdx: 1, targetIdx: 2, label: "supports" },
      { sourceIdx: 3, targetIdx: 6, label: "supports" },
      { sourceIdx: 4, targetIdx: 5, label: "explains" },
      { sourceIdx: 5, targetIdx: 0, label: "supports" },
      { sourceIdx: 2, targetIdx: 4, label: "related to" },
    ]
  },
  {
    id: "thread_behavioral_analytics",
    title: "Behavioral Analytics: Attention & Distraction Science",
    nodes: [
      { type: "note",      content: "Gini coefficient applied to browsing: 0 = perfectly balanced attention across all sites. 1 = all time on a single site. Most users score 0.6–0.8, indicating high concentration on a few domains." },
      { type: "highlight", content: "Slot machine dynamics on social feeds: variable reward schedules produce the highest engagement. Scroll velocity spikes on platforms with infinite scroll and unpredictable post quality — Reddit, Twitter, TikTok.", contextBefore: "The core insight from behavioral economics applied to UX is that", contextAfter: "This is why infinite scroll is so effective and so dangerous." },
      { type: "url",       content: "Stolen Focus: Why You Can't Pay Attention — Johann Hari", url: "https://stolenfocusbook.com/" },
      { type: "note",      content: "Markov chains on domain transitions reveal habit loops. High-probability transitions like HN → GitHub → HN indicate a checking habit. Transitions like Reddit → YouTube → Netflix indicate a distraction spiral." },
      { type: "highlight", content: "Session survival analysis shows most browsing sessions end within 20 minutes of the first distraction-category visit. The transition from work to distraction is nearly irreversible within a session.", contextBefore: "Using Kaplan-Meier survival curves on browsing session data,", contextAfter: "This supports single-session focus strategies." },
      { type: "url",       content: "Deep Work — Cal Newport summary and highlights", url: "https://www.calnewport.com/books/deep-work/" },
      { type: "note",      content: "Dopamine velocity metric: (scroll_pixels + interactions) * erratic_multiplier / active_seconds. High velocity = skimming/seeking. Low velocity = sustained reading. Correlated with self-reported focus quality." },
    ],
    edges: [
      { sourceIdx: 0, targetIdx: 3, label: "related to" },
      { sourceIdx: 1, targetIdx: 4, label: "supports" },
      { sourceIdx: 1, targetIdx: 2, label: "related to" },
      { sourceIdx: 3, targetIdx: 0, label: "supports" },
      { sourceIdx: 4, targetIdx: 5, label: "related to" },
      { sourceIdx: 6, targetIdx: 1, label: "explains" },
      { sourceIdx: 6, targetIdx: 4, label: "supports" },
    ]
  },
  {
    id: "thread_extension_architecture",
    title: "Chrome Extension MV3 Architecture Patterns",
    nodes: [
      { type: "note",      content: "Manifest V3 replaced persistent background pages with service workers. Service workers are killed after ~30s of inactivity and cannot hold in-memory state across messages. This fundamentally changes extension architecture." },
      { type: "highlight", content: "The offscreen document pattern solves the service worker memory limit: spawn a hidden document that persists independently, communicate via chrome.runtime.sendMessage, and use it for computation-heavy tasks like WASM and WebGPU.", contextBefore: "For extensions requiring persistent state and heavy computation,", contextAfter: "The offscreen document acts as a durable worker thread." },
      { type: "url",       content: "Chrome Extensions: Offscreen Documents API", url: "https://developer.chrome.com/docs/extensions/reference/api/offscreen" },
      { type: "note",      content: "Content scripts run in page context with limited API access. Use them only for DOM observation and extraction. Pass data to background via sendMessage. Never do expensive processing in content scripts." },
      { type: "highlight", content: "The chrome.storage.local API persists ~10MB by default, unlimited with 'unlimitedStorage' permission. For larger datasets (browsing history, embeddings), use IndexedDB directly — PGlite wraps this transparently.", contextBefore: "Storage limits in extensions are often misunderstood:", contextAfter: "" },
      { type: "url",       content: "WXT Framework: Next-gen Web Extension Framework", url: "https://wxt.dev/" },
      { type: "note",      content: "Message bus design: define a canonical MSG registry (like messages.js) shared across all contexts. Type your payloads. Handle errors with { type: 'ERROR', error: string } pattern. Never assume messages arrive in order." },
    ],
    edges: [
      { sourceIdx: 0, targetIdx: 1, label: "explains" },
      { sourceIdx: 1, targetIdx: 2, label: "supports" },
      { sourceIdx: 0, targetIdx: 3, label: "related to" },
      { sourceIdx: 3, targetIdx: 6, label: "related to" },
      { sourceIdx: 4, targetIdx: 0, label: "related to" },
      { sourceIdx: 5, targetIdx: 0, label: "related to" },
      { sourceIdx: 6, targetIdx: 4, label: "supports" },
    ]
  }
];

/**
 * Coordinates the full generation and database insertion of the 90-day simulation dataset.
 * @returns {Promise<boolean>} Resolves to true if the reset and seeding process completes without errors.
 */
export async function injectDemoData() {
  console.log("[DeepSurf:DemoSeeder] ▶ Starting 90-day behavioral simulation for Alex...");

  const storageData = {
    isDemoMode: true,
    deepSurfFirstRun: NINETY_DAYS_AGO,
    accountCreationDate: NINETY_DAYS_AGO,
  };

  for (const domain of DOMAIN_KEYS) {
    storageData[`ad_${domain}`] = {
      totalVisits: 0,
      firstVisited: NINETY_DAYS_AGO + Math.random() * 5 * 24 * 60 * 60 * 1000,
      lastVisited: NINETY_DAYS_AGO,
      hourlyDistribution: {},
    };
  }

  const pulses = [];
  let currentTime = NINETY_DAYS_AGO;
  let distractionStreak = 0;
  let deepWorkStreak = 0;
  let prevDomain = "github.com";

  // We cap the total simulated pulses at 4000 records to prevent long generation pauses and memory overhead while maintaining data density.
  while (currentTime < NOW && pulses.length < 4000) {
    const dateObj = new Date(currentTime);
    const hour = dateObj.getHours();
    const dayOfWeek = dateObj.getDay();
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
    const isFriday = dayOfWeek === 5;

    const activityMult = hourActivityMultiplier(hour);

    // We skip browsing activities at random intervals matching the circadian multiplier curve to simulate realistic sleep patterns.
    if (activityMult < 0.1 || Math.random() > activityMult) {
      const skipMins = Math.floor(gaussian(45, 20, 15, 180));
      currentTime += skipMins * 60 * 1000;
      continue;
    }

    const weights = buildDomainWeights({ hour, isWeekend, distractionStreak, deepWorkStreak, isFriday });
    const domain = weightedPick(weights);
    const reg = DOMAIN_REGISTRY[domain] || {};
    const isDistraction = ["distraction", "video"].includes(reg.cat);
    const isWork = reg.cat === "work" || reg.cat === "ai";

    if (isDistraction) { distractionStreak++; deepWorkStreak = 0; }
    else if (isWork)    { deepWorkStreak++; distractionStreak = Math.max(0, distractionStreak - 1); }
    else                { distractionStreak = Math.max(0, distractionStreak - 1); }

    const base = reg;
    const activeSeconds   = Math.round(gaussian(base.baseActive || 180, base.baseActive * 0.4 || 70, 10, 7200));
    const scrollPixels    = jitter(base.baseScroll || 500);
    const interactCount   = jitter(base.baseInteract || 10);
    const mouseDist       = jitter(base.mouseDist || 1000);
    const scrollChanges   = jitter(base.scrollChanges || 3, 0.5);
    const isMedia         = Math.random() < (base.mediaProb || 0);
    const hasTextSel      = Math.random() < (base.textSelProb || 0.3);

    const urlPaths = base.urls || ["/"];
    const pagePath = urlPaths[Math.floor(Math.random() * urlPaths.length)];
    const pageUrl  = `https://${domain}${pagePath}`;

    const dayKey = `${DAYS[dayOfWeek]}_${hour}`;
    const ad = storageData[`ad_${domain}`];
    ad.totalVisits++;
    ad.lastVisited = currentTime;
    ad.hourlyDistribution[dayKey] = (ad.hourlyDistribution[dayKey] || 0) + 1;

    // We simulate immediate site-to-site transitions with a 12% probability to model user search click-through patterns.
    const isChainVisit = prevDomain !== domain && Math.random() < 0.12;

    pulses.push({
      id: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      domain,
      url: pageUrl,
      timestamp: currentTime,
      activeSeconds,
      scrollPixelsTotal: scrollPixels,
      scrollDirectionChanges: scrollChanges,
      interactionCount: interactCount,
      mouseDistancePx: mouseDist,
      isMediaPlaying: isMedia,
      hasTextSelection: hasTextSel,
    });

    prevDomain = domain;

    if (isChainVisit) {
      currentTime += Math.floor(gaussian(90, 30, 20, 300)) * 1000;
    } else {
      const basePause = activeSeconds * 1000;
      const intentGap = Math.floor(gaussian(12, 8, 2, 60)) * 60 * 1000;
      currentTime += basePause + intentGap;
    }
  }

  console.log(`[DeepSurf:DemoSeeder] Generated ${pulses.length} behavioral pulses.`);

  const PAGE_COUNT = 200;
  const pageTimeStep = (NOW - NINETY_DAYS_AGO) / PAGE_COUNT;
  const pages = [];

  // We duplicate domain options in the random pool based on affinity values to match Alex's primary site preferences in the generated history.
  const domainPool = DOMAIN_KEYS.flatMap(d => {
    const affinity = Math.round((ALEX_AFFINITY[d] || 1.0) * 3);
    return Array(affinity).fill(d);
  });

  for (let i = 0; i < PAGE_COUNT; i++) {
    const domain = domainPool[Math.floor(Math.random() * domainPool.length)];
    const url    = getPageUrl(domain, i);
    const id     = urlToId(url) + "_" + i;
    const title  = getPageTitle(domain, i);
    const text   = getPageText(domain, i);
    const visitedAt = Math.round(NINETY_DAYS_AGO + i * pageTimeStep + Math.random() * pageTimeStep);

    pages.push({
      id,
      url,
      title,
      text,
      visitedAt,
      embeddingLiteral: generateMockEmbedding(),
    });
  }

  console.log(`[DeepSurf:DemoSeeder] Generated ${pages.length} indexed pages.`);

  const threads = [];
  const nodes   = [];
  const edges   = [];
  let nodeIdCounter = 1;
  let edgeIdCounter = 1;

  for (const threadDef of CANVAS_THREADS) {
    const updatedAt = NOW - Math.floor(Math.random() * 7 * 24 * 60 * 60 * 1000);
    threads.push({ id: threadDef.id, title: threadDef.title, updatedAt });

    const threadNodeIds = [];
    const cols = 4;
    const colW = 200, rowH = 180;

    // We apply small random coordinate shifts to layout nodes to give the research canvas threads an organic, user-arranged appearance.
    for (let i = 0; i < threadDef.nodes.length; i++) {
      const nd = threadDef.nodes[i];
      const nodeId = `n${nodeIdCounter++}`;
      threadNodeIds.push(nodeId);

      const node = {
        id: nodeId,
        threadId: threadDef.id,
        type: nd.type,
        content: nd.content,
        posX: (i % cols) * colW + jitter(80, 0.5),
        posY: Math.floor(i / cols) * rowH + jitter(60, 0.5),
      };
      if (nd.type === "highlight") {
        node.contextBefore = nd.contextBefore || "";
        node.contextAfter  = nd.contextAfter  || "";
      }
      if (nd.type === "url") {
        node.url = nd.url || `https://example.com/thread-${threadDef.id}/node-${i}`;
      }
      nodes.push(node);
    }

    for (const edgeDef of threadDef.edges) {
      const src = threadNodeIds[edgeDef.sourceIdx];
      const tgt = threadNodeIds[edgeDef.targetIdx];
      if (src && tgt && src !== tgt) {
        edges.push({
          id: `e${edgeIdCounter++}`,
          sourceId: src,
          targetId: tgt,
          label: edgeDef.label,
        });
      }
    }
  }

  console.log(`[DeepSurf:DemoSeeder] Generated ${threads.length} threads, ${nodes.length} nodes, ${edges.length} edges.`);

  console.log("[DeepSurf:DemoSeeder] Sending RESET_DEMO_DB...");
  const resetResponse = await chrome.runtime.sendMessage({ type: MSG.RESET_DEMO_DB });
  if (resetResponse?.type === "ERROR") {
    console.error("[DeepSurf:DemoSeeder] RESET_DEMO_DB failed:", resetResponse.error);
    return false;
  }
  console.log("[DeepSurf:DemoSeeder] DB reset complete. Injecting...");

  const response = await chrome.runtime.sendMessage({
    type: MSG.INJECT_DEMO_PULSES,
    payload: { pulses, pages, threads, nodes, edges },
  });

  if (response?.type === "ERROR") {
    console.error("[DeepSurf:DemoSeeder] INJECT_DEMO_PULSES failed:", response.error);
    return false;
  }

  await chrome.storage.local.set(storageData);

  console.log(
    `[DeepSurf:DemoSeeder] ✓ Done! Injected:\n` +
    `  • ${pulses.length} behavioral pulses across ${DOMAIN_KEYS.length} domains\n` +
    `  • ${pages.length} indexed pages with embeddings\n` +
    `  • ${threads.length} research threads | ${nodes.length} nodes | ${edges.length} edges`
  );
  return true;
}
<script>
  /**
   * @fileoverview Renders data visualizations and calculations of the user's browsing patterns and cognitive behavior.
   *
   * Displayed as the Analytics Tab within the extension's side panel, pulling raw domain telemetry and behavioral pulse logs from local storage. Instantiates and registers multiple Chart.js chart objects, causing minor canvas and GPU memory allocations that are released when the tab changes.
   */

  import { onMount } from "svelte";
  import Chart from "chart.js/auto";
  import { TreemapController, TreemapElement } from "chartjs-chart-treemap";
  import { MatrixController, MatrixElement } from "chartjs-chart-matrix";
  import { MSG } from "../lib/messages.js";
  import { processTreemapData, processHeatmapData, processDiscoveryData } from "../lib/analyticsProcessor.js";
  import * as MathLab from "../lib/behavioralMath.js";

  Chart.register(TreemapController, TreemapElement, MatrixController, MatrixElement);

  Chart.defaults.color = '#71717a'; 
  Chart.defaults.font.family = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
  Chart.defaults.font.size = 10;
  Chart.defaults.plugins.tooltip.backgroundColor = 'rgba(9, 9, 11, 0.95)';
  Chart.defaults.plugins.tooltip.borderColor = 'rgba(63, 63, 70, 0.6)';
  Chart.defaults.plugins.tooltip.borderWidth = 1;
  Chart.defaults.plugins.tooltip.padding = 8;
  Chart.defaults.plugins.tooltip.titleFont = { size: 10, weight: '600' };
  Chart.defaults.plugins.tooltip.bodyFont = { size: 10 };

  const CATEGORY_COLORS = {
    "Development":         { bg: "rgba(139, 92, 246, 0.75)", border: "rgba(139, 92, 246, 1)" },
    "Social":              { bg: "rgba(249, 115, 22, 0.70)",  border: "rgba(249, 115, 22, 1)" },
    "Productivity":        { bg: "rgba(20, 184, 166, 0.70)",  border: "rgba(20, 184, 166, 1)" },
    "AI & Research":       { bg: "rgba(6, 182, 212, 0.70)",   border: "rgba(6, 182, 212, 1)" },
    "Media & Entertainment": { bg: "rgba(239, 68, 68, 0.70)",  border: "rgba(239, 68, 68, 1)" },
    "News & Media":        { bg: "rgba(59, 130, 246, 0.70)",  border: "rgba(59, 130, 246, 1)" },
    "Shopping":            { bg: "rgba(236, 72, 153, 0.70)",  border: "rgba(236, 72, 153, 1)" },
    "Finance":             { bg: "rgba(34, 197, 94, 0.70)",   border: "rgba(34, 197, 94, 1)" },
    "Reference":           { bg: "rgba(99, 102, 241, 0.65)",  border: "rgba(99, 102, 241, 1)" },
    "Travel & Navigation": { bg: "rgba(245, 158, 11, 0.65)",  border: "rgba(245, 158, 11, 1)" },
    "Food & Delivery":     { bg: "rgba(244, 63, 94, 0.70)",   border: "rgba(244, 63, 94, 1)" },
    "Health & Fitness":    { bg: "rgba(132, 204, 22, 0.70)",  border: "rgba(132, 204, 22, 1)" },
    "Search & Utilities":  { bg: "rgba(161, 161, 170, 0.60)", border: "rgba(161, 161, 170, 1)" },
    "General":             { bg: "rgba(63, 63, 70, 0.70)",    border: "rgba(113, 113, 122, 1)" },
  };

  /**
   * Retrieves the background or border color code associated with a specific website category.
   * @param {string} category - The domain category classification.
   * @param {string} [type="bg"] - The type of color to return, either "bg" or "border".
   * @returns {string} The RGBA color representation string.
   */
  function categoryColor(category, type = "bg") {
    return (CATEGORY_COLORS[category] || CATEGORY_COLORS["General"])[type];
  }

  let rawData        = $state({});
  let behavioralPulses = $state([]);
  let isLoading      = $state(true);
  let loadError      = $state(null);

  let stats = $state({
    gini: 0,
    medianAttention: 0,
    transitions: [],
    totalVisits: 0,
    totalDomains: 0,
    totalPulses: 0,
    daysSinceFirstVisit: 0,
    topDomain: "",
    topDomainVisits: 0,
  });

  let isFullyCalibrated = $derived(stats.daysSinceFirstVisit >= 21);
  let calibrationProgress = $derived(
    Math.min(100, Math.max(0, (stats.daysSinceFirstVisit / 21) * 100))
  );

  let giniLabel = $derived(
    stats.gini > 0.7 ? "Centralized" : stats.gini > 0.4 ? "Balanced" : "Diverse"
  );
  let giniInterpretation = $derived(
    stats.gini > 0.7
      ? "Attention is heavily concentrated. A few sources dominate your diet."
      : stats.gini > 0.4
      ? "Moderate source diversity with a clear primary cluster."
      : "Broad information diet. Attention is distributed across many sources."
  );
  let giniColor = $derived(
    stats.gini > 0.7 ? "text-orange-400" : stats.gini > 0.4 ? "text-yellow-400" : "text-emerald-400"
  );

  let focusLabel = $derived(
    stats.medianAttention < 5  ? "Fragmented" :
    stats.medianAttention < 15 ? "Moderate"   : "Sustained"
  );
  let focusInterpretation = $derived(
    stats.medianAttention < 5
      ? "High context switching. Sessions are short and scattered."
      : stats.medianAttention < 15
      ? "Average digital focus. Mix of deep reads and quick checks."
      : "Deep reading patterns. Sustained attention per session."
  );
  let focusColor = $derived(
    stats.medianAttention < 5  ? "text-red-400" :
    stats.medianAttention < 15 ? "text-yellow-400" : "text-emerald-400"
  );

  let treemapCanvas   = $state();
  let heatmapCanvas   = $state();
  let dopamineCanvas  = $state();
  let discoveryCanvas = $state();

  let charts = { treemap: null, heatmap: null, dopamine: null, discovery: null };

  onMount(async () => {
    console.log("[DeepSurf:Analytics] Mounted AnalyticsTab view.");
    try {

      // We fetch the entire storage object to filter out domain analytics records dynamically.
      const storage = await chrome.storage.local.get(null);
      const parsed = {};
      for (const [key, value] of Object.entries(storage)) {
        if (key.startsWith("ad_")) parsed[key.replace("ad_", "")] = value;
      }
      rawData = parsed;

      const res = await chrome.runtime.sendMessage({ type: MSG.GET_BEHAVIORAL_STATS });
      if (res?.data) {
        behavioralPulses = res.data;
      }

      computeMetrics();
    } catch (e) {
      console.error("[DeepSurf:Analytics] Load failed:", e);
      loadError = e?.message || "Unknown error loading analytics.";
    } finally {
      isLoading = false;

      // We defer the rendering using setTimeout to ensure the DOM elements are fully painted before Chart.js accesses the canvas contexts.
      setTimeout(renderAllCharts, 0);
    }
  });

  /**
   * Computes behavioral metrics like Gini coefficient and attention span from raw visit statistics.
   * @returns {void}
   */
  function computeMetrics() {
    const domainEntries = Object.entries(rawData);
    if (domainEntries.length === 0) return;

    const counts = domainEntries.map(([, d]) => d.totalVisits);
    const totalVisits = counts.reduce((a, b) => a + b, 0);

    const gini = parseFloat(MathLab.calculateGiniCoefficient(counts));

    const sessions = MathLab.sessionize(behavioralPulses);
    const medianSpan = parseFloat(MathLab.calculateMedianAttentionSpan(sessions).toFixed(1));

    const transitions = MathLab.calculateMarkovTransitions(behavioralPulses).slice(0, 4);

    let minFirstVisited = Date.now();
    for (const [, d] of domainEntries) {
      if (d.firstVisited && d.firstVisited < minFirstVisited) minFirstVisited = d.firstVisited;
    }
    const daysSinceFirstVisit = totalVisits > 0
      ? (Date.now() - minFirstVisited) / (1000 * 60 * 60 * 24)
      : 0;

    let topDomain = "", topDomainVisits = 0;
    for (const [domain, d] of domainEntries) {
      if (d.totalVisits > topDomainVisits) {
        topDomainVisits = d.totalVisits;
        topDomain = domain;
      }
    }

    stats = {
      gini,
      medianAttention: medianSpan,
      transitions,
      totalVisits,
      totalDomains: domainEntries.length,
      totalPulses: behavioralPulses.length,
      daysSinceFirstVisit,
      topDomain,
      topDomainVisits,
    };
  }

  /**
   * Destroys all active Chart.js instances to avoid memory leaks.
   * @returns {void}
   */
  function destroyAll() {
    for (const [k, c] of Object.entries(charts)) {
      if (c) { try { c.destroy(); } catch (_) {} }
      charts[k] = null;
    }
  }

  /**
   * Triggers the rendering of all active visual charts.
   * @returns {void}
   */
  function renderAllCharts() {
    if (isLoading || stats.totalVisits === 0) return;
    destroyAll();
    renderTreemap();
    renderHeatmap();
    renderDiscovery();
    if (isFullyCalibrated) renderDopamine();
  }

  /**
   * Renders the domain categories distribution treemap chart.
   * @returns {void}
   */
  function renderTreemap() {
    if (!treemapCanvas) return;
    try {
      charts.treemap = new Chart(treemapCanvas, {
        type: "treemap",
        data: {
          datasets: [{
            tree: processTreemapData(rawData),
            key: "value",
            groups: ["category", "name"],
            backgroundColor(ctx) {
              const cat = ctx.raw?._data?.category || "General";
              return categoryColor(cat, "bg");
            },
            borderColor(ctx) {
              const cat = ctx.raw?._data?.category || "General";
              return categoryColor(cat, "border");
            },
            borderWidth: 1,
            spacing: 1.5,
            labels: {
              display: true,
              align: "left",
              position: "top",
              color: "#d4d4d8",
              font: { size: 9, family: "ui-monospace, monospace", weight: "500" },
              formatter(ctx) {
                const d = ctx.raw?._data;
                if (!d) return "";
                return d.name || d.category || "";
              },
            },
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                title(items) {
                  const d = items[0]?.raw?._data;
                  return d?.name || d?.category || "";
                },
                label(item) {
                  const d = item.raw?._data;
                  const cat = d?.category || "";
                  const visits = item.raw?.v ?? item.raw?.value ?? 0;
                  return [`Category: ${cat}`, `Visits: ${visits}`];
                },
              },
            },
          },
        },
      });
    } catch (e) {
      console.error("[DeepSurf:Analytics] Treemap render failed:", e);
    }
  }

  const HEATMAP_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  /**
   * Renders the temporal hour-of-week activity density heatmap chart.
   * @returns {void}
   */
  function renderHeatmap() {
    if (!heatmapCanvas) return;
    try {
      const heatData = processHeatmapData(rawData);
      const maxV = Math.max(1, ...heatData.map(d => d.v));

      charts.heatmap = new Chart(heatmapCanvas, {
        type: "matrix",
        data: {
          datasets: [{
            data: heatData,
            backgroundColor(ctx) {
              const v = ctx.dataset.data[ctx.dataIndex]?.v ?? 0;
              if (v === 0) return "rgba(24, 24, 27, 0.4)";

              // We use a progressive opacity calculation to visually highlight peak activity hours while maintaining grid cell legibility.
              const alpha = Math.min(0.15 + (v / maxV) * 0.85, 1.0);
              return `rgba(139, 92, 246, ${alpha.toFixed(2)})`;
            },
            borderColor: "rgba(39, 39, 42, 0.6)",
            borderWidth: 1,
            width(ctx) {
              const w = ctx.chart.chartArea?.width;
              return w ? Math.max(1, (w / 24) - 1.5) : 12;
            },
            height(ctx) {
              const h = ctx.chart.chartArea?.height;
              return h ? Math.max(1, (h / 7) - 1.5) : 12;
            },
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            x: {
              type: "linear",
              min: -0.5,
              max: 23.5,
              offset: false,
              ticks: {
                stepSize: 6,
                callback: (v) => `${String(v).padStart(2, "0")}h`,
                maxRotation: 0,
              },
              grid: { display: false },
            },
            y: {
              type: "category",
              labels: HEATMAP_DAYS,
              offset: true,
              reverse: true,
              grid: { display: false },
              ticks: {
                font: { size: 9 },
              },
            },
          },
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                title(items) {
                  const d = items[0]?.raw;
                  if (!d) return "";
                  return `${d.y} at ${String(d.x).padStart(2, "0")}:00`;
                },
                label(item) {
                  const v = item.raw?.v ?? 0;
                  return `${v} visit${v !== 1 ? "s" : ""}`;
                },
              },
            },
          },
        },
      });
    } catch (e) {
      console.error("[DeepSurf:Analytics] Heatmap render failed:", e);
    }
  }

  /**
   * Renders the bar chart tracking daily discovery counts of new domains.
   * @returns {void}
   */
  function renderDiscovery() {
    if (!discoveryCanvas) return;
    try {
      const { labels, discoveries } = processDiscoveryData(rawData, 100);
      charts.discovery = new Chart(discoveryCanvas, {
        type: "bar",
        data: {
          labels,
          datasets: [{
            data: discoveries,
            backgroundColor: "rgba(139, 92, 246, 0.35)",
            borderColor: "rgba(139, 92, 246, 0.8)",
            borderWidth: 1,
            borderRadius: 2,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            x: {
              grid: { display: false },
              ticks: {
                maxTicksLimit: 8,
                maxRotation: 0,
                font: { size: 9 },
              },
            },
            y: {
              beginAtZero: true,
              grid: { color: "rgba(63, 63, 70, 0.3)" },
              ticks: {
                stepSize: 1,
                precision: 0,
                font: { size: 9 },
              },
            },
          },
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                title: (items) => items[0]?.label || "",
                label: (item) => `${item.raw} new domain${item.raw !== 1 ? "s" : ""}`,
              },
            },
          },
        },
      });
    } catch (e) {
      console.error("[DeepSurf:Analytics] Discovery chart render failed:", e);
    }
  }

  /**
   * Renders the interaction velocity line chart.
   * @returns {void}
   */
  function renderDopamine() {
    if (!dopamineCanvas || behavioralPulses.length === 0) return;
    try {
      const recentPulses = behavioralPulses.slice(-80);
      const velocities = recentPulses.map(p => MathLab.calculateDopamineVelocity(p));
      const avgVelocity = velocities.reduce((a, b) => a + b, 0) / velocities.length;

      charts.dopamine = new Chart(dopamineCanvas, {
        type: "line",
        data: {
          labels: recentPulses.map(p =>
            new Date(p.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
          ),
          datasets: [
            {
              data: velocities,
              borderColor: "rgba(52, 211, 153, 0.9)",
              backgroundColor: "rgba(52, 211, 153, 0.06)",
              borderWidth: 1.5,
              fill: true,
              tension: 0.35,
              pointRadius: 0,
              pointHoverRadius: 3,
            },
            {

              // A 5-point moving average is calculated to smooth out high-frequency noise and show the general trend of interaction.
              data: velocities.map((_, i, arr) => {
                const window = arr.slice(Math.max(0, i - 5), i + 1);
                return window.reduce((a, b) => a + b, 0) / window.length;
              }),
              borderColor: "rgba(167, 139, 250, 0.7)",
              borderWidth: 1,
              fill: false,
              tension: 0.5,
              pointRadius: 0,
              borderDash: [3, 2],
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            x: { display: false },
            y: {
              display: false,
              beginAtZero: true,
              suggestedMax: avgVelocity * 3,
            },
          },
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                title: (items) => items[0]?.label || "",
                label: (item) =>
                  item.datasetIndex === 0
                    ? `Velocity: ${item.raw?.toFixed(1)} u/min`
                    : `Avg: ${item.raw?.toFixed(1)} u/min`,
              },
            },
          },
          animation: { duration: 600 },
        },
      });
    } catch (e) {
      console.error("[DeepSurf:Analytics] Dopamine chart render failed:", e);
    }
  }

  $effect(() => {
    if (!isLoading && stats.totalVisits > 0) {
      setTimeout(renderAllCharts, 0);
    }
  });
</script>

<div class="h-full w-full flex flex-col bg-zinc-950 text-zinc-100 overflow-hidden">

  <div class="px-5 py-4 border-b border-zinc-800/60 shrink-0 bg-zinc-950/80 backdrop-blur-md z-10">
    <div class="flex items-center gap-3">
      <div class="w-8 h-8 rounded-xl bg-zinc-900 border border-zinc-800 flex items-center justify-center shadow-inner">
        <svg class="w-4 h-4 text-zinc-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
        </svg>
      </div>
      <div>
        <h2 class="text-sm font-medium text-zinc-100">Behavioral Insights</h2>
        <p class="text-[10px] text-zinc-500 font-mono tracking-wider mt-0.5 uppercase">Cognitive Pattern Mapping</p>
      </div>
    </div>
  </div>

  <div class="flex-1 overflow-y-auto p-4 pb-12 space-y-3 scrollbar-thin">

    {#if isLoading}
      <div class="py-20 flex flex-col items-center justify-center gap-4">
        <div class="w-4 h-4 border-[1.5px] border-zinc-700 border-t-zinc-400 rounded-full animate-spin"></div>
        <span class="text-[10px] font-mono tracking-widest text-zinc-500 uppercase">Compiling Vectors...</span>
      </div>

    {:else if loadError}
      <div class="py-16 flex flex-col items-center text-center px-6 gap-3">
        <div class="w-10 h-10 rounded-full bg-red-950/40 border border-red-900/50 flex items-center justify-center">
          <svg class="w-4 h-4 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 9v2m0 4h.01M5.07 19H19a2 2 0 001.73-3L13.73 4a2 2 0 00-3.46 0L3.34 16a2 2 0 001.73 3z" />
          </svg>
        </div>
        <p class="text-xs font-medium text-red-400">Failed to load analytics</p>
        <p class="text-[10px] text-zinc-500 font-mono">{loadError}</p>
      </div>

    {:else if stats.totalVisits === 0}
      <div class="py-20 flex flex-col items-center text-center px-6">
        <div class="w-12 h-12 rounded-full bg-zinc-900 border border-zinc-800 flex items-center justify-center mb-4">
          <svg class="w-5 h-5 text-zinc-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
        </div>
        <p class="text-sm font-medium text-zinc-300">Awaiting Telemetry</p>
        <p class="text-xs text-zinc-500 mt-2 leading-relaxed">Begin browsing. DeepSurf maps your digital environment after initial activity.</p>
      </div>

    {:else}

      {#if !isFullyCalibrated}
        <div class="bg-zinc-900/50 border border-zinc-800 rounded-xl p-4">
          <div class="flex justify-between items-end mb-2">
            <div>
              <p class="text-[10px] font-mono tracking-widest text-zinc-400 uppercase">Engine Calibration</p>
              <p class="text-[10px] text-zinc-500 mt-0.5">Mapping baseline behavioral patterns</p>
            </div>
            <span class="text-[10px] font-mono text-zinc-400">{Math.round(calibrationProgress)}%</span>
          </div>
          <div class="h-1 w-full bg-zinc-950 rounded-full overflow-hidden border border-zinc-800/60">
            <div class="h-full bg-violet-500/80 rounded-full transition-all duration-700" style="width: {calibrationProgress}%"></div>
          </div>
          <p class="text-[10px] text-zinc-600 mt-3 flex items-center gap-1.5">
            <svg class="w-3 h-3 text-zinc-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
            21 days required to unlock gated insights. Currently {Math.round(stats.daysSinceFirstVisit)} day{stats.daysSinceFirstVisit !== 1 ? "s" : ""} tracked.
          </p>
        </div>
      {/if}

      <div class="grid grid-cols-3 gap-2">
        <div class="bg-zinc-900/30 border border-zinc-800/60 rounded-xl px-3 py-3 flex flex-col gap-0.5">
          <span class="text-[8px] font-mono text-zinc-500 uppercase tracking-widest">Domains</span>
          <span class="text-lg font-light text-zinc-200">{stats.totalDomains}</span>
        </div>
        <div class="bg-zinc-900/30 border border-zinc-800/60 rounded-xl px-3 py-3 flex flex-col gap-0.5">
          <span class="text-[8px] font-mono text-zinc-500 uppercase tracking-widest">Visits</span>
          <span class="text-lg font-light text-zinc-200">{stats.totalVisits.toLocaleString()}</span>
        </div>
        <div class="bg-zinc-900/30 border border-zinc-800/60 rounded-xl px-3 py-3 flex flex-col gap-0.5">
          <span class="text-[8px] font-mono text-zinc-500 uppercase tracking-widest">Pulses</span>
          <span class="text-lg font-light text-zinc-200">{stats.totalPulses.toLocaleString()}</span>
        </div>
      </div>

      {#if stats.topDomain}
        <div class="bg-zinc-900/30 border border-zinc-800/60 rounded-xl px-4 py-3 flex items-center justify-between">
          <div>
            <p class="text-[9px] font-mono text-zinc-500 uppercase tracking-widest mb-1">Top Domain</p>
            <p class="text-xs font-medium text-zinc-200 font-mono">{stats.topDomain}</p>
          </div>
          <div class="text-right">
            <p class="text-[9px] font-mono text-zinc-500 uppercase tracking-widest mb-1">Visits</p>
            <p class="text-xs font-medium text-violet-400 font-mono">{stats.topDomainVisits}</p>
          </div>
        </div>
      {/if}

      <div class="bg-zinc-900/30 border border-zinc-800/60 rounded-xl p-4 flex flex-col" style="min-height: 230px;">
        <div class="mb-3 shrink-0">
          <h3 class="text-[10px] font-mono text-zinc-400 tracking-widest uppercase">Digital Footprint</h3>
          <p class="text-[10px] text-zinc-500 mt-0.5">Volume & hierarchy of visited domains</p>
        </div>
        <div class="flex flex-wrap gap-x-3 gap-y-1 mb-3 shrink-0">
          {#each Object.entries(CATEGORY_COLORS) as [cat, colors]}
            <div class="flex items-center gap-1">
              <div class="w-2 h-2 rounded-sm shrink-0" style="background: {colors.bg}; border: 1px solid {colors.border}"></div>
              <span class="text-[8px] font-mono text-zinc-500">{cat}</span>
            </div>
          {/each}
        </div>
        <div class="flex-1 relative min-h-[140px]">
          <canvas bind:this={treemapCanvas}></canvas>
        </div>
      </div>

      <div class="bg-zinc-900/30 border border-zinc-800/60 rounded-xl p-4 flex flex-col" style="height: 240px;">
        <div class="mb-3 shrink-0">
          <h3 class="text-[10px] font-mono text-zinc-400 tracking-widest uppercase">Temporal Rhythms</h3>
          <p class="text-[10px] text-zinc-500 mt-0.5">24-hour activity density by day of week</p>
        </div>
        <div class="flex-1 relative overflow-hidden">
          <canvas bind:this={heatmapCanvas}></canvas>
        </div>
        <div class="flex justify-between mt-1.5 px-1 shrink-0">
          <span class="text-[8px] text-zinc-600 font-mono">00:00</span>
          <span class="text-[8px] text-zinc-600 font-mono">06:00</span>
          <span class="text-[8px] text-zinc-600 font-mono">12:00</span>
          <span class="text-[8px] text-zinc-600 font-mono">18:00</span>
          <span class="text-[8px] text-zinc-600 font-mono">23:59</span>
        </div>
      </div>

      <div class="grid grid-cols-2 gap-3">

        <div class="bg-zinc-900/30 border border-zinc-800/60 rounded-xl p-4 relative overflow-hidden flex flex-col justify-between min-h-[130px]">
          {#if !isFullyCalibrated}
            <div class="absolute inset-0 bg-zinc-950/85 backdrop-blur-[2px] flex flex-col items-center justify-center z-10 rounded-xl">
              <svg class="w-4 h-4 text-zinc-600 mb-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
              <span class="text-[9px] font-mono text-zinc-500 uppercase">Unlocks at 21d</span>
            </div>
          {/if}
          <div>
            <h3 class="text-[9px] font-mono text-zinc-400 tracking-widest uppercase">Information Diet</h3>
            <div class="flex items-end gap-1.5 mt-2">
              <span class="text-2xl font-light text-zinc-200">{stats.gini}</span>
              <span class="text-[9px] text-zinc-500 font-mono mb-0.5">GINI</span>
            </div>
            <span class="text-[9px] font-mono {giniColor} mt-0.5">{giniLabel}</span>
          </div>
          <p class="text-[10px] text-zinc-500 leading-snug mt-3 border-t border-zinc-800/50 pt-2">{giniInterpretation}</p>
        </div>

        <div class="bg-zinc-900/30 border border-zinc-800/60 rounded-xl p-4 relative overflow-hidden flex flex-col justify-between min-h-[130px]">
          {#if !isFullyCalibrated}
            <div class="absolute inset-0 bg-zinc-950/85 backdrop-blur-[2px] flex flex-col items-center justify-center z-10 rounded-xl">
              <svg class="w-4 h-4 text-zinc-600 mb-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
              <span class="text-[9px] font-mono text-zinc-500 uppercase">Unlocks at 21d</span>
            </div>
          {/if}
          <div>
            <h3 class="text-[9px] font-mono text-zinc-400 tracking-widest uppercase">Attention Span</h3>
            <div class="flex items-end gap-1.5 mt-2">
              <span class="text-2xl font-light text-zinc-200">{Math.round(stats.medianAttention)}</span>
              <span class="text-[9px] text-zinc-500 font-mono mb-0.5">MIN MEDIAN</span>
            </div>
            <span class="text-[9px] font-mono {focusColor} mt-0.5">{focusLabel}</span>
          </div>
          <p class="text-[10px] text-zinc-500 leading-snug mt-3 border-t border-zinc-800/50 pt-2">{focusInterpretation}</p>
        </div>

      </div>

      <div class="bg-zinc-900/30 border border-zinc-800/60 rounded-xl p-4 relative overflow-hidden">
        {#if !isFullyCalibrated}
          <div class="absolute inset-0 bg-zinc-950/85 backdrop-blur-[2px] flex flex-col items-center justify-center z-10 rounded-xl">
            <svg class="w-4 h-4 text-zinc-600 mb-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
            <span class="text-[9px] font-mono text-zinc-500 uppercase">Habit Triggers</span>
          </div>
        {/if}
        <h3 class="text-[10px] font-mono text-zinc-400 tracking-widest uppercase mb-1">Neurological Loops</h3>
        <p class="text-[10px] text-zinc-500 mb-4">Highest-probability micro-transitions between domains</p>

        <div class="space-y-2">
          {#each stats.transitions as loop, i}
            <div class="flex items-center gap-3 bg-zinc-950/50 border border-zinc-800/40 p-2.5 rounded-lg">
              <span class="text-[10px] text-zinc-400 truncate w-[90px] text-right font-mono shrink-0">{loop.source}</span>
              <div class="flex-1 relative flex items-center">
                <div class="absolute inset-y-0 left-0 rounded-sm bg-violet-500/10" style="width: {Math.round(loop.probability * 100)}%"></div>
                <div class="relative w-full h-px bg-zinc-800"></div>
                <div class="absolute inset-0 flex items-center justify-center">
                  <span class="bg-zinc-900 border border-zinc-800 rounded-sm px-1 text-[8px] font-mono text-violet-400">
                    {Math.round(loop.probability * 100)}%
                  </span>
                </div>
              </div>
              <span class="text-[10px] text-zinc-200 truncate w-[90px] font-mono shrink-0">{loop.target}</span>
            </div>
          {:else}
            <p class="text-[10px] text-zinc-600 font-mono italic">Accumulating transition data...</p>
          {/each}
        </div>
      </div>

      <div class="bg-zinc-900/30 border border-zinc-800/60 rounded-xl p-4 flex flex-col" style="min-height: 160px;">
        <div class="mb-3 shrink-0">
          <h3 class="text-[10px] font-mono text-zinc-400 tracking-widest uppercase">Horizon Expansion</h3>
          <p class="text-[10px] text-zinc-500 mt-0.5">New domains discovered per day — last 30 days</p>
        </div>
        <div class="flex-1 relative min-h-[100px]">
          <canvas bind:this={discoveryCanvas}></canvas>
        </div>
      </div>

      <div class="bg-zinc-900/30 border border-zinc-800/60 rounded-xl p-4 relative overflow-hidden flex flex-col">
        {#if !isFullyCalibrated}
          <div class="absolute inset-0 bg-zinc-950/85 backdrop-blur-[2px] flex flex-col items-center justify-center z-10 rounded-xl">
            <svg class="w-4 h-4 text-zinc-600 mb-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
            <span class="text-[9px] font-mono text-zinc-500 uppercase">Interaction Velocity</span>
          </div>
        {/if}
        <div class="flex items-start justify-between mb-3 shrink-0">
          <div>
            <h3 class="text-[10px] font-mono text-zinc-400 tracking-widest uppercase">Interaction Density</h3>
            <p class="text-[10px] text-zinc-500 mt-0.5">Slot machine effect vs. deep reading signal</p>
          </div>
          <div class="flex items-center gap-3 shrink-0">
            <div class="flex items-center gap-1">
              <div class="w-3 h-px bg-emerald-400"></div>
              <span class="text-[8px] font-mono text-zinc-500">velocity</span>
            </div>
            <div class="flex items-center gap-1">
              <div class="w-3 h-px border-t border-violet-400/70 border-dashed"></div>
              <span class="text-[8px] font-mono text-zinc-500">avg</span>
            </div>
            <div class="flex items-center gap-1">
              <div class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></div>
              <span class="text-[8px] font-mono text-emerald-500">live</span>
            </div>
          </div>
        </div>
        <div class="h-20 w-full relative">
          <canvas bind:this={dopamineCanvas}></canvas>
        </div>
      </div>

    {/if}
  </div>
</div>

<style>
  canvas {
    width: 100% !important;
    height: 100% !important;
  }

  .scrollbar-thin {
    scrollbar-width: thin;
    scrollbar-color: rgba(63, 63, 70, 0.6) transparent;
  }
  .scrollbar-thin::-webkit-scrollbar { width: 4px; }
  .scrollbar-thin::-webkit-scrollbar-track { background: transparent; }
  .scrollbar-thin::-webkit-scrollbar-thumb {
    background: rgba(63, 63, 70, 0.6);
    border-radius: 2px;
  }
</style>
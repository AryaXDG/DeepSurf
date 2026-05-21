<script>
  /**
   * @fileoverview Provides an interactive visual workspace (canvas) where users can map, link, and organize research highlights.
   *
   * Integrates with the Side Panel UI, receiving drag-and-drop nodes from the Inbox or direct highlights via chrome message routing. Reads and writes nodes, edges, and positions to the offscreen PGlite database, and triggers periodic requestAnimationFrame loops for physics simulation.
   */

  import { onMount, onDestroy, tick } from "svelte";
  import { MSG } from "../lib/messages.js";
  import { createHighlightUrl } from "../lib/utils.js";

  let { pendingHighlight = null, onHighlightConsumed = () => {} } = $props();

  let threads = $state([]);
  let activeThreadId = $state(null);
  let nodes = $state([]);
  let edges = $state([]);

  let showThreadMenu = $state(false);
  let showInbox = $state(false);
  let newThreadName = $state("");
  let creatingThread = $state(false);

  let canvasEl = $state(null);
  let svgEl = $state(null);
  let canvasW = $state(700);
  let canvasH = $state(500);
  let viewOffsetX = $state(0);
  let viewOffsetY = $state(0);
  let scale = $state(1);

  let draggingNodeId = $state(null);
  let dragStartX = $state(0);
  let dragStartY = $state(0);
  let dragNodeOrigX = $state(0);
  let dragNodeOrigY = $state(0);

  let panning = $state(false);
  let panStartX = $state(0);
  let panStartY = $state(0);
  let panStartOX = $state(0);
  let panStartOY = $state(0);

  let edgeDrawing = $state(false);
  let edgeSourceId = $state(null);
  let edgeTempX = $state(0);
  let edgeTempY = $state(0);

  let hoveredNodeId = $state(null);
  let expandedNodeId = $state(null);

  let editingEdgeId = $state(null);
  let editingEdgeLabel = $state("");

  let showPicker = $state(false);
  let pickerHighlight = $state(null);
  let pickerAnnotation = $state("");
  let pickerThreadId = $state(null);
  let addingNode = $state(false);

  let showManualInput = $state(false);
  let manualText = $state("");
  let manualClickX = $state(300);
  let manualClickY = $state(250);

  let animFrame = null;
  let simRunning = $state(false);

  let ghostPaths = $state([]);
  let hoveredInboxId = $state(null);

  let inboxNodes = $derived(nodes.filter(n => n.posX === -9999 && n.posY === -9999));
  let canvasNodes = $derived(nodes.filter(n => n.posX !== -9999 || n.posY !== -9999));

  /**
   * Sends a message to the extension service worker.
   * @param {string} type - The message type identifier.
   * @param {Object} [payload={}] - The message payload.
   * @returns {Promise<any>} The response from the service worker.
   */
  function msg(type, payload = {}) {
    return chrome.runtime.sendMessage({ type, payload });
  }

  /**
   * Opens the source URL of a node in a new browser tab, automatically highlighting the node's text.
   * @param {string} url - The target URL.
   * @param {string} text - The text quote to highlight.
   * @param {MouseEvent} [e] - Optional click event to stop propagation.
   * @returns {void}
   */
  function openSource(url, text, e) {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    if (!url) return;
    const highlightUrl = createHighlightUrl(url, text);
    chrome.tabs.create({ url: highlightUrl });
  }

  /**
   * Loads the list of available research canvases from the database.
   * @returns {Promise<void>}
   */
  async function loadThreads() {
    const res = await msg(MSG.CANVAS_GET_THREADS);
    threads = res?.data ?? [];
  }

  /**
   * Loads the nodes and edges associated with a specific canvas thread.
   * @param {string} threadId - The unique identifier of the canvas thread.
   * @returns {Promise<void>}
   */
  async function loadCanvas(threadId) {
    if (!threadId) return;
    const [nodesRes, edgesRes] = await Promise.all([
      msg(MSG.CANVAS_GET_NODES, { threadId }),
      msg(MSG.CANVAS_GET_EDGES, { threadId }),
    ]);

    const activeNodes = nodesRes?.data ?? [];
    nodes = [...inboxNodes, ...activeNodes];
    edges = edgesRes?.data ?? [];

    // We trigger the physics layout immediately after loading to resolve overlapping nodes.
    runForceLayout(80); 
  }

  /**
   * Loads bookmarks and highlights that have not yet been assigned to any canvas thread.
   * @returns {Promise<void>}
   */
  async function loadInbox() {
    const res = await msg(MSG.CANVAS_GET_INBOX); 
    if (res?.data) {
      const freshInbox = res.data.map(n => ({ ...n, posX: -9999, posY: -9999 }));
      nodes = [...canvasNodes, ...freshInbox];
    }
  }

  /**
   * Sets the active canvas thread and loads its contents.
   * @param {string} id - The ID of the canvas thread.
   * @returns {Promise<void>}
   */
  async function selectThread(id) {
    activeThreadId = id;
    showThreadMenu = false;
    await loadCanvas(id);
  }

  /**
   * Creates a new canvas thread.
   * @param {string} [nameOverride] - Optional name for the new thread.
   * @returns {Promise<string|null>} The ID of the created thread, or null if creation failed.
   */
  async function createThread(nameOverride) {
    const name = nameOverride || newThreadName.trim();
    if (!name) return null;
    creatingThread = true;
    const res = await msg(MSG.CANVAS_CREATE_THREAD, { name });
    creatingThread = false;
    newThreadName = "";
    await loadThreads();
    if (res?.data?.id) await selectThread(res.data.id);
    return res?.data?.id;
  }

  /**
   * Deletes a canvas thread along with all its nodes and edges after confirmation.
   * @param {string} threadId - The ID of the thread to delete.
   * @param {MouseEvent} e - The click event.
   * @returns {Promise<void>}
   */
  async function deleteThread(threadId, e) {
    e.stopPropagation();
    if (!confirm("Delete this canvas and all its nodes?")) return;
    await msg(MSG.CANVAS_DELETE_THREAD, { threadId });
    if (activeThreadId === threadId) { activeThreadId = null; nodes = [...inboxNodes]; edges = []; }
    await loadThreads();
  }

  /**
   * Positions all nodes in a grid pattern to clean up the canvas.
   * @returns {void}
   */
  function tidyLayout() {
    let cols = Math.ceil(Math.sqrt(canvasNodes.length));
    canvasNodes.forEach((n, i) => {
      const targetX = 150 + (i % cols) * 220;
      const targetY = 150 + Math.floor(i / cols) * 220;
      persistNodePos(n.id, targetX, targetY);
      n.posX = targetX;
      n.posY = targetY;
    });
    nodes = [...nodes];

    // We re-run the layout simulation to smooth out node placement after auto-positioning.
    runForceLayout(40);
  }

  /**
   * Adds a new highlight node to the canvas or inbox.
   * @param {Object} highlight - The highlight data.
   * @param {string|null} threadId - The ID of the canvas, or null if saving to the inbox.
   * @param {string} annotation - An optional note to associate with the highlight.
   * @returns {Promise<Object>} The response containing the created node.
   */
  async function addHighlightNode(highlight, threadId, annotation) {
    addingNode = true;
    const posX = threadId ? (canvasNodes.length > 0 ? Math.max(...canvasNodes.map(n => n.posX)) + 120 + Math.random() * 60 : 100) : -9999;
    const posY = threadId ? (150 + Math.random() * 200) : -9999;

    const res = await msg(MSG.CANVAS_ADD_NODE, {
      threadId,
      type: "highlight",
      text: highlight.text,
      annotation: annotation || "",
      url: highlight.url,
      title: highlight.title,
      xpath: highlight.xpath || "",
      contextBefore: highlight.contextBefore || "",
      contextAfter: highlight.contextAfter || "",
      posX, posY,
    });
    
    addingNode = false;

    if (res?.data?.node) {
      nodes = [...nodes, res.data.node];
      edges = [...edges, ...(res.data.edges ?? [])];
      if (threadId) runForceLayout(60);
    }
    return res?.data;
  }

  /**
   * Creates a manual note node at the specified coordinates.
   * @param {string} text - The contents of the note.
   * @param {number} posX - The horizontal coordinate.
   * @param {number} posY - The vertical coordinate.
   * @returns {Promise<void>}
   */
  async function addManualNode(text, posX, posY) {
    if (!activeThreadId || !text.trim()) return;
    const res = await msg(MSG.CANVAS_ADD_NODE, {
      threadId: activeThreadId,
      type: "manual",
      text: text.trim(),
      posX, posY,
    });
    if (res?.data?.node) {
      nodes = [...nodes, res.data.node];
      edges = [...edges, ...(res.data.edges ?? [])];
      runForceLayout(60);
    }
  }

  /**
   * Deletes a node and any connected edges from the database and updates local state.
   * @param {string} nodeId - The ID of the node to delete.
   * @param {MouseEvent} [e] - Optional click event to stop propagation.
   * @returns {Promise<void>}
   */
  async function deleteNode(nodeId, e) {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    await msg(MSG.CANVAS_DELETE_NODE, { nodeId });
    nodes = nodes.filter(n => n.id !== nodeId);
    edges = edges.filter(e => e.sourceId !== nodeId && e.targetId !== nodeId);
    if (expandedNodeId === nodeId) expandedNodeId = null;
  }

  /**
   * Deletes an edge link between two nodes.
   * @param {string} edgeId - The ID of the edge to delete.
   * @param {MouseEvent} [e] - Optional click event to stop propagation.
   * @returns {Promise<void>}
   */
  async function deleteEdge(edgeId, e) {
    e?.stopPropagation();
    await msg(MSG.CANVAS_DELETE_EDGE, { edgeId });
    edges = edges.filter(e => e.id !== edgeId);
    editingEdgeId = null;
  }

  /**
   * Saves a user-defined text label on an edge.
   * @param {string} edgeId - The ID of the edge being labeled.
   * @returns {Promise<void>}
   */
  async function finishEdgeLabel(edgeId) {
    await msg(MSG.CANVAS_LABEL_EDGE, { edgeId, label: editingEdgeLabel });
    edges = edges.map(e => e.id === edgeId ? { ...e, label: editingEdgeLabel } : e);
    editingEdgeId = null;
    editingEdgeLabel = "";

    // We re-run physics with fewer iterations to snap nodes back to balance after a label change.
    runForceLayout(40); 
  }

  /**
   * Updates the coordinates of a node in the database.
   * @param {string} nodeId - The ID of the node.
   * @param {number} posX - The new horizontal coordinate.
   * @param {number} posY - The new vertical coordinate.
   * @returns {Promise<void>}
   */
  async function persistNodePos(nodeId, posX, posY) {
    await msg(MSG.CANVAS_UPDATE_NODE, { nodeId, threadId: activeThreadId, posX, posY });
  }

  /**
   * Prepares the drag data when a node is dragged out of the inbox.
   * @param {DragEvent} e - The drag event.
   * @param {Object} node - The node being dragged.
   * @returns {void}
   */
  function onDragStartInbox(e, node) {
    e.dataTransfer.setData("text/plain", node.id);
    e.dataTransfer.effectAllowed = "move";
    hoveredInboxId = null;
    ghostPaths = [];
  }

  /**
   * Allows dropping items onto the canvas area by preventing the default event.
   * @param {DragEvent} e - The dragover event.
   * @returns {void}
   */
  function onCanvasDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }

  /**
   * Handles dropping an inbox node onto the canvas, placing it at the release coordinates.
   * @param {DragEvent} e - The drop event.
   * @returns {Promise<void>}
   */
  async function onCanvasDrop(e) {
    e.preventDefault();
    const nodeId = e.dataTransfer.getData("text/plain");
    if (!nodeId || !activeThreadId) return;

    const { x, y } = svgCoords(e);

    nodes = nodes.map(n => n.id === nodeId ? { ...n, posX: x, posY: y, threadId: activeThreadId } : n);
    await msg(MSG.CANVAS_UPDATE_NODE, { nodeId, threadId: activeThreadId, posX: x, posY: y });

    const droppedNode = nodes.find(n => n.id === nodeId);
    if (droppedNode) {
       const searchRes = await msg(MSG.SEARCH_HYBRID, { query: droppedNode.text, limit: 5 });
       if (searchRes?.results) {
          for (const result of searchRes.results) {
             const targetNode = canvasNodes.find(n => n.url === result.url && n.id !== nodeId);
             if (targetNode && result.score >= 0.50) {
                await executeEdgeCreation(nodeId, targetNode.id);
             }
          }
       }
    }
    runForceLayout(60);
  }

  /**
   * Runs a semantic similarity search when an inbox item is hovered to highlight potential connections on the canvas.
   * @param {Object} node - The hovered inbox node.
   * @returns {Promise<void>}
   */
  async function onInboxHover(node) {
    hoveredInboxId = node.id;
    if (!activeThreadId || canvasNodes.length === 0) return;

    const searchRes = await msg(MSG.SEARCH_HYBRID, { query: node.text, limit: 4 });

    // A check is needed here to prevent updating ghost paths if the user hovered away during the async database query.
    if (searchRes?.results && hoveredInboxId === node.id) {
      const targets = [];
      for (const result of searchRes.results) {
        const targetNode = canvasNodes.find(n => n.url === result.url);
        if (targetNode && result.score >= 0.45) targets.push(targetNode);
      }
      ghostPaths = targets;
    }
  }

  /**
   * Cleans up semantic search previews and ghost paths when the mouse leaves an inbox item.
   * @returns {void}
   */
  function onInboxLeave() {
    hoveredInboxId = null;
    ghostPaths = [];
  }

  /**
   * Starts or resumes the force-directed layout simulation loop.
   * @param {number} [iterations=100] - The number of simulation steps to run.
   * @returns {void}
   */
  function runForceLayout(iterations = 100) {
    if (simRunning) return;
    simRunning = true;
    let iter = 0;
    const tick = () => {
      if (iter++ >= iterations || canvasNodes.length < 2) { simRunning = false; return; }
      simulateStep();
      animFrame = requestAnimationFrame(tick);
    };
    animFrame = requestAnimationFrame(tick);
  }

  /**
   * Computes electrostatic repulsion and spring tension forces for one step of the layout simulation.
   * @returns {void}
   */
  function simulateStep() {

    // The spring rest length k and repulsion values are tuned experimentally to accommodate 200px-wide expanded node cards.
    const k = 260; 
    const repulsion = 30000; 
    const damping = 0.65; 

    const forces = new Map(canvasNodes.map(n => [n.id, { fx: 0, fy: 0 }]));

    const MAX_DIST_SQ = 80000;
    const CELL_SIZE = Math.sqrt(MAX_DIST_SQ);
    const grid = new Map();

    for (const node of canvasNodes) {
      const cx = Math.floor(node.posX / CELL_SIZE);
      const cy = Math.floor(node.posY / CELL_SIZE);
      const key = `${cx},${cy}`;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(node);
    }

    const processed = new Set();

    for (const node of canvasNodes) {
      const cx = Math.floor(node.posX / CELL_SIZE);
      const cy = Math.floor(node.posY / CELL_SIZE);

      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const neighborKey = `${cx + dx},${cy + dy}`;
          const bucket = grid.get(neighborKey);
          if (!bucket) continue;

          for (const other of bucket) {
            if (other.id === node.id) continue;

            const pairKey = node.id < other.id
              ? `${node.id}|${other.id}`
              : `${other.id}|${node.id}`;
            if (processed.has(pairKey)) continue;
            processed.add(pairKey);

            const ddx = other.posX - node.posX || 0.01;
            const ddy = other.posY - node.posY || 0.01;
            const d2 = ddx * ddx + ddy * ddy;
            if (d2 < MAX_DIST_SQ) {
              const f = repulsion / d2;
              const dist = Math.sqrt(d2);
              const fx = f * ddx / dist;
              const fy = f * ddy / dist;
              forces.get(node.id).fx -= fx;
              forces.get(node.id).fy -= fy;
              forces.get(other.id).fx += fx;
              forces.get(other.id).fy += fy;
            }
          }
        }
      }
    }

    for (const edge of edges) {
      const src = canvasNodes.find(n => n.id === edge.sourceId);
      const tgt = canvasNodes.find(n => n.id === edge.targetId);
      if (!src || !tgt) continue;
      const dx = tgt.posX - src.posX;
      const dy = tgt.posY - src.posY;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = (d - k) * 0.15; 
      const fx = f * dx / d;
      const fy = f * dy / d;
      forces.get(src.id).fx += fx;
      forces.get(src.id).fy += fy;
      forces.get(tgt.id).fx -= fx;
      forces.get(tgt.id).fy -= fy;
    }

    nodes = nodes.map(n => {

      // Inbox nodes (positioned at -9999) and the currently dragged node must not be affected by simulation forces.
      if (n.posX === -9999 || draggingNodeId === n.id) return n; 
      const f = forces.get(n.id);
      return {
        ...n,
        posX: Math.max(40, Math.min(canvasW - 40, n.posX + f.fx * damping)),
        posY: Math.max(40, Math.min(canvasH - 40, n.posY + f.fy * damping)),
      };
    });
  }

  /**
   * Converts client viewport coordinates into zoom-and-pan adjusted SVG canvas coordinates.
   * @param {MouseEvent} e - The mouse event containing viewport client coordinates.
   * @returns {{x: number, y: number}} The calculated SVG coordinates.
   */
  function svgCoords(e) {
    const rect = svgEl?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: (e.clientX - rect.left - viewOffsetX) / scale,
      y: (e.clientY - rect.top - viewOffsetY) / scale,
    };
  }

  /**
   * Initiates canvas panning or closes node details depending on the click target.
   * @param {MouseEvent} e - The mouse down event.
   * @returns {void}
   */
  function onSvgMousedown(e) {
    if (e.target === svgEl || e.target.tagName === "svg" || e.target.tagName === "rect") {
      panning = true;
      panStartX = e.clientX;
      panStartY = e.clientY;
      panStartOX = viewOffsetX;
      panStartOY = viewOffsetY;
      expandedNodeId = null;
    }
  }

  /**
   * Updates coordinates during active panning, node dragging, or edge drawing.
   * @param {MouseEvent} e - The mouse move event.
   * @returns {void}
   */
  function onSvgMousemove(e) {
    if (panning) {
      viewOffsetX = panStartOX + (e.clientX - panStartX);
      viewOffsetY = panStartOY + (e.clientY - panStartY);
    }
    if (draggingNodeId) {
      const { x, y } = svgCoords(e);
      nodes = nodes.map(n =>
        n.id === draggingNodeId
          ? { ...n, posX: x + dragNodeOrigX - dragStartX, posY: y + dragNodeOrigY - dragStartY }
          : n
      );
    }
    if (edgeDrawing) {
      const { x, y } = svgCoords(e);
      edgeTempX = x; edgeTempY = y;
    }
  }

  /**
   * Concludes active panning, node dragging, or edge drawing operations.
   * @param {MouseEvent} e - The mouse up event.
   * @returns {void}
   */
  function onSvgMouseup(e) {
    if (panning) panning = false;
    if (draggingNodeId) {
      const node = nodes.find(n => n.id === draggingNodeId);
      if (node) persistNodePos(node.id, node.posX, node.posY);
      draggingNodeId = null;
      runForceLayout(40); 
    }
    if (edgeDrawing) {
      edgeDrawing = false;
      edgeSourceId = null;
    }
  }

  /**
   * Displays the text input popup to create a manual note node at the double-click location.
   * @param {MouseEvent} e - The double-click event.
   * @returns {void}
   */
  function onSvgDblclick(e) {
    if (!activeThreadId) return;
    if (e.target === svgEl || e.target.tagName === "svg" || e.target.tagName === "rect") {
      const { x, y } = svgCoords(e);
      manualClickX = x;
      manualClickY = y;
      showManualInput = true;
      manualText = "";
      tick().then(() => document.getElementById("manual-node-input")?.focus());
    }
  }

  /**
   * Adjusts the canvas zoom scale and panning offset relative to the mouse cursor position.
   * @param {WheelEvent} e - The mouse wheel event.
   * @returns {void}
   */
  function onSvgWheel(e) {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    const rect = svgEl?.getBoundingClientRect();
    if (!rect) return;
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    viewOffsetX = mx - (mx - viewOffsetX) * delta;
    viewOffsetY = my - (my - viewOffsetY) * delta;
    scale = Math.max(0.15, Math.min(3, scale * delta));
  }

  /**
   * Registers initial node position and cursor coordinates when dragging begins.
   * @param {MouseEvent} e - The mouse down event.
   * @param {Object} node - The node object being dragged.
   * @returns {void}
   */
  function startNodeDrag(e, node) {
    e.stopPropagation();
    const { x, y } = svgCoords(e);
    draggingNodeId = node.id;
    dragStartX = x;
    dragStartY = y;
    dragNodeOrigX = node.posX;
    dragNodeOrigY = node.posY;
  }

  /**
   * Starts drawing a temporary manual link line from a source node.
   * @param {MouseEvent} e - The mouse down event.
   * @param {string} nodeId - The ID of the source node.
   * @returns {void}
   */
  function startEdgeDraw(e, nodeId) {
    e.stopPropagation();
    edgeDrawing = true;
    edgeSourceId = nodeId;
    const { x, y } = svgCoords(e);
    edgeTempX = x; edgeTempY = y;
  }

  /**
   * Requests the database to create an edge between two nodes and updates local state.
   * @param {string} sourceId - The ID of the source node.
   * @param {string} targetId - The ID of the target node.
   * @returns {Promise<void>}
   */
  async function executeEdgeCreation(sourceId, targetId) {
    const res = await msg(MSG.CANVAS_ADD_EDGE, { threadId: activeThreadId, sourceId, targetId });
    if (res?.data?.id && !edges.find(e => e.id === res.data.id)) {
      edges = [...edges, { id: res.data.id, sourceId, targetId, score: 1.0, manual: true, label: "" }];
    }
  }

  /**
   * Finalizes the creation of a connection if the temporary link line is released over a target node.
   * @param {MouseEvent} e - The mouse up event.
   * @param {string} targetNodeId - The ID of the target node.
   * @returns {Promise<void>}
   */
  async function finishEdgeDrop(e, targetNodeId) {
    if (!edgeDrawing || !edgeSourceId || edgeSourceId === targetNodeId) return;
    edgeDrawing = false;
    await executeEdgeCreation(edgeSourceId, targetNodeId);
    edgeSourceId = null;
    runForceLayout(50);
  }

  /**
   * Displays the edge label editor at the click coordinates.
   * @param {MouseEvent} e - The click event.
   * @param {Object} edge - The edge object.
   * @returns {void}
   */
  function onClickEdge(e, edge) {
    e.stopPropagation();
    editingEdgeId = edge.id;
    editingEdgeLabel = edge.label || "";
  }

  /**
   * Computes the line thickness for an edge based on its semantic similarity score.
   * @param {number} score - The similarity score (typically between 0 and 1).
   * @returns {number} The thickness in pixels.
   */
  function edgeStrokeWidth(score) {
    if (score >= 0.86) return 4;
    if (score >= 0.66) return 2.5;
    return 1.5;
  }

  /**
   * Determines the stroke color of an edge, highlighting manual links and higher similarity scores.
   * @param {number} score - The similarity score.
   * @param {boolean} manual - Whether the connection was created manually by the user.
   * @returns {string} The RGBA color string.
   */
  function edgeStrokeColor(score, manual) {
    if (manual) return "rgba(168,85,247,0.9)";
    if (score >= 0.8) return "rgba(139,92,246,0.9)";
    if (score >= 0.6) return "rgba(139,92,246,0.7)";
    return "rgba(139,92,246,0.5)";
  }

  /**
   * Calculates the midpoint between the source and target nodes of an edge.
   * @param {Object} edge - The edge object.
   * @returns {{x: number, y: number}} The midpoint coordinates.
   */
  function edgeMid(edge) {
    const src = canvasNodes.find(n => n.id === edge.sourceId);
    const tgt = canvasNodes.find(n => n.id === edge.targetId);
    if (!src || !tgt) return { x: 0, y: 0 };
    return { x: (src.posX + tgt.posX) / 2, y: (src.posY + tgt.posY) / 2 };
  }

  /**
   * Opens the picker modal to assign an incoming highlight to a canvas.
   * @param {Object} highlight - The highlight data.
   * @returns {Promise<void>}
   */
  async function openPickerFor(highlight) {
    pickerHighlight = highlight;
    pickerAnnotation = "";
    pickerThreadId = activeThreadId ?? (threads[0]?.id ?? null);
    await loadThreads();
    if (threads.length === 0) {
      pickerThreadId = null;
    } else {
      pickerThreadId = activeThreadId ?? (threads[0]?.id ?? null);
    }
    showPicker = true;
  }

  /**
   * Saves the picker's highlight and comments to the chosen canvas.
   * @returns {Promise<void>}
   */
  async function confirmPicker() {
    if (!pickerHighlight || !pickerThreadId) return;
    if (pickerThreadId !== activeThreadId) {
      await selectThread(pickerThreadId);
    }
    await addHighlightNode(pickerHighlight, pickerThreadId, pickerAnnotation);
    showPicker = false;
    pickerHighlight = null;
  }

  $effect(() => {
    if (pendingHighlight) {
      const hl = pendingHighlight;
      const mode = pendingHighlight.mode;
      
      onHighlightConsumed(); 

      if (mode === "pick") {
        openPickerFor(hl);
      } else if (mode === "quick") {

        // Quick Save is handled by the background worker directly to the DB, so we simply need to refresh the inbox view.
        setTimeout(() => loadInbox(), 500); 
      }
    }
  });

  let resizeObserver = null;

  onMount(async () => {
    console.log("[DeepSurf:Canvas] Mounted ResearchCanvas view.");
    await loadThreads();

    // We preload standalone highlights from the inbox so that they are instantly available for placement.
    await loadInbox();
    if (threads.length > 0) await selectThread(threads[0].id);

    if (canvasEl) {
      resizeObserver = new ResizeObserver(entries => {
        const e = entries[0];
        canvasW = e.contentRect.width || 700;
        canvasH = e.contentRect.height || 500;
      });
      resizeObserver.observe(canvasEl);
    }
    if (svgEl) svgEl.addEventListener("wheel", onSvgWheel, { passive: false });
  });

  onDestroy(() => {
    if (animFrame) cancelAnimationFrame(animFrame);
    if (svgEl) svgEl.removeEventListener("wheel", onSvgWheel);

    // Disconnect the ResizeObserver to prevent memory leaks when navigating away from this tab.
    if (resizeObserver) resizeObserver.disconnect();
  });
</script>

{#if showPicker}
  <div class="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[9999]" aria-label="Close picker modal" role="button" tabindex="0" onclick={() => { showPicker = false; pickerHighlight = null; }} onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showPicker = false; pickerHighlight = null; } }}>
    <div class="bg-zinc-900 border border-violet-500/50 rounded-xl p-5 w-[320px] shadow-[0_25px_50px_-12px_rgba(0,0,0,0.8)]" aria-label="Picker modal" role="button" tabindex="0" onclick={(e) => e.stopPropagation()} onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); } }}>
      <div class="text-sm font-semibold text-violet-400 mb-4 flex items-center gap-2">
        <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/>
        </svg>
        <span>Add to Canvas</span>
      </div>

      <div class="bg-violet-600/10 border border-violet-500/25 rounded-lg p-3 mb-4">
        <div class="text-xs text-zinc-200 leading-relaxed italic">"{pickerHighlight?.text?.slice(0, 140)}{(pickerHighlight?.text?.length ?? 0) > 140 ? "…" : ""}"</div>
        <div class="text-[10px] text-violet-400 mt-2 truncate">{pickerHighlight?.title || pickerHighlight?.url}</div>
      </div>

      <label class="text-[10px] font-semibold text-zinc-400 uppercase tracking-wide mb-2 block" for="canvas-thread-select">Canvas Thread</label>
      <div id="canvas-thread-select" class="flex flex-col gap-1 mb-4 max-h-[150px] overflow-y-auto scrollbar-thin">
        {#each threads as t}
          <button type="button" class="flex items-center gap-2 px-3 py-2 rounded-lg border border-transparent text-xs text-zinc-300 cursor-pointer transition-colors hover:bg-violet-600/15 {pickerThreadId === t.id ? 'bg-violet-600/25 border-violet-500/40 text-violet-400 font-semibold' : ''}" onclick={() => pickerThreadId = t.id}>
            <div class="w-1.5 h-1.5 rounded-full bg-currentColor"></div><span>{t.name}</span>
          </button>
        {/each}
        <button type="button" class="flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-violet-400 italic cursor-pointer transition-colors hover:bg-violet-600/15" onclick={() => {
          const name = prompt("New canvas name:");
          if (name?.trim()) createThread(name.trim()).then(id => pickerThreadId = id);
        }}>
          <svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 4v16m8-8H4"/></svg>
          <span>New canvas…</span>
        </button>
      </div>

      <label class="text-[10px] font-semibold text-zinc-400 uppercase tracking-wide mb-2 block" for="picker-annotation-input">Note <span class="lowercase font-normal opacity-70">(optional)</span></label>
      <input id="picker-annotation-input" class="w-full bg-zinc-950 border border-zinc-800 focus:border-violet-500 rounded-lg px-3 py-2 text-zinc-200 text-xs outline-none mb-4" type="text" maxlength="60" placeholder="Type a connection..." bind:value={pickerAnnotation} onkeydown={e => e.key === "Enter" && confirmPicker()}/>

      <div class="flex items-center gap-2 mt-2">
        <button class="text-[11px] text-zinc-400 hover:text-zinc-200 bg-transparent border-none cursor-pointer px-2 py-1 rounded-md transition-colors" onclick={() => { showPicker = false; pickerHighlight = null; }}>Cancel</button>
        <button class="text-[11px] text-white bg-violet-600 hover:bg-violet-700 disabled:opacity-50 border-none rounded-lg px-3 py-1.5 font-semibold ml-auto transition-colors" onclick={confirmPicker} disabled={!pickerThreadId || addingNode}>
          {addingNode ? "Adding…" : "Add to Canvas"}
        </button>
      </div>
    </div>
  </div>
{/if}

<div class="flex flex-col h-full bg-zinc-950 relative overflow-hidden">

  <div class="flex items-center gap-2 px-5 py-3 border-b border-zinc-800/60 shrink-0 bg-zinc-950/80 backdrop-blur-md z-20">
    <div class="relative">
      <button type="button" class="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-violet-600/10 hover:bg-violet-600/20 border border-violet-500/30 text-violet-400 text-xs font-semibold cursor-pointer transition-colors" onclick={() => showThreadMenu = !showThreadMenu}>
        <svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h7"/></svg>
        <span class="max-w-[120px] truncate">{threads.find(t => t.id === activeThreadId)?.name ?? "Select Canvas"}</span>
      </button>

      {#if showThreadMenu}
        <div class="absolute top-[calc(100%+6px)] left-0 min-w-[200px] bg-zinc-900 border border-violet-500/40 rounded-xl p-1.5 z-50 shadow-2xl" aria-label="Thread menu" role="button" tabindex="0" onclick={(e) => e.stopPropagation()} onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); } }}>
          {#each threads as t}
            <div class="flex items-center gap-1.5 px-2.5 py-2 rounded-lg text-xs text-zinc-400 cursor-pointer transition-colors hover:bg-violet-600/10 hover:text-zinc-200 {t.id === activeThreadId ? 'bg-violet-600/20 text-violet-400 font-semibold' : ''}" aria-label="Select thread {t.name}" role="button" tabindex="0" onclick={() => selectThread(t.id)} onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectThread(t.id); } }}>
              <span class="flex-1 truncate">{t.name}</span>
              <button type="button" class="text-zinc-600 hover:text-red-400 px-1" onclick={e => deleteThread(t.id, e)}>✕</button>
            </div>
          {/each}
          <div class="border-t border-zinc-800/50 my-1.5"></div>
          <div class="flex items-center gap-1.5 p-1">
            <input class="flex-1 bg-zinc-950 border border-zinc-800 focus:border-violet-500 rounded-lg px-2 py-1.5 text-xs text-zinc-200 outline-none" type="text" maxlength="40" placeholder="New canvas..." bind:value={newThreadName} onkeydown={e => { if (e.key === "Enter" && newThreadName.trim()) { e.stopPropagation(); createThread(); } }} />
            <button class="w-7 h-7 rounded-lg bg-violet-600 hover:bg-violet-700 text-white disabled:opacity-50 flex items-center justify-center text-lg transition-colors" onclick={(e) => { e.stopPropagation(); createThread(); }} disabled={creatingThread || !newThreadName.trim()}>+</button>
          </div>
        </div>
      {/if}
    </div>

    <button class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl border text-xs font-semibold cursor-pointer transition-colors {showInbox ? 'bg-zinc-800 border-zinc-600 text-zinc-200' : 'bg-transparent border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600'}" onclick={() => showInbox = !showInbox}>
      Inbox
      {#if inboxNodes.length > 0}
        <span class="bg-violet-600 text-white text-[9px] px-1.5 py-0.5 rounded-full">{inboxNodes.length}</span>
      {/if}
    </button>

    <div class="ml-auto flex gap-2 text-[10px] text-zinc-500 font-mono">
      <span>Dbl-click = thought</span><span>·</span><span>Drag + = connect</span>
    </div>

    <div class="flex items-center gap-1.5 bg-zinc-900 border border-zinc-800 rounded-xl px-2 py-1">
      <button class="text-zinc-400 hover:text-violet-400 flex items-center p-0.5 transition-colors" onclick={tidyLayout} title="Auto-organize canvas layout">
        <svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" /></svg>
      </button>
      <div class="w-px h-3.5 bg-zinc-700 mx-0.5"></div>
      <button class="text-zinc-400 hover:text-violet-400 p-0.5 transition-colors text-sm leading-none" onclick={() => scale = Math.min(3, scale * 1.2)}>+</button>
      <span class="text-[10px] text-zinc-500 font-mono w-8 text-center">{Math.round(scale * 100)}%</span>
      <button class="text-zinc-400 hover:text-violet-400 p-0.5 transition-colors text-sm leading-none" onclick={() => scale = Math.max(0.15, scale * 0.8)}>−</button>
    </div>
  </div>

  <div class="flex flex-1 overflow-hidden relative">
    
    {#if showInbox}
      <div class="w-[260px] bg-zinc-950 border-r border-zinc-800 flex flex-col overflow-hidden z-10 shrink-0">
        <div class="p-3 text-xs font-semibold text-zinc-200 border-b border-zinc-800 flex flex-col gap-0.5">Quick Saves<span class="text-[10px] text-zinc-500 font-normal">Threadless discoveries</span></div>
        <div class="flex-1 overflow-y-auto p-2 flex flex-col gap-2 scrollbar-thin">
          {#if inboxNodes.length === 0}
            <div class="text-[11px] text-zinc-500 text-center py-5 leading-relaxed">No unplaced items.</div>
          {:else}
            {#each inboxNodes as node}
              <div class="bg-zinc-900 border {hoveredInboxId === node.id ? 'border-violet-400 shadow-[0_0_15px_-3px_rgba(139,92,246,0.4)]' : 'border-zinc-700 hover:border-violet-500 hover:-translate-y-0.5 hover:shadow-lg'} rounded-xl cursor-grab active:cursor-grabbing active:scale-[0.98] flex flex-col overflow-hidden transition-all duration-200" 
                   aria-label="Draggable inbox item"
                   role="button"
                   tabindex="0"
                   draggable="true" 
                   ondragstart={(e) => onDragStartInbox(e, node)}
                   onmouseenter={() => onInboxHover(node)}
                   onmouseleave={onInboxLeave}
                   onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onDragStartInbox(e, node); } }}>
                   
                <div class="flex gap-2 p-2.5 bg-violet-600/5">
                  <div class="text-violet-400 shrink-0 mt-0.5">
                    <svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z"/></svg>
                  </div>
                  <div class="text-[11px] text-zinc-200 leading-snug italic">"{node.text.slice(0, 60)}..."</div>
                </div>
                
                <div class="px-2.5 pb-2.5 pt-0 border-t border-zinc-800/50 bg-zinc-900">
                  <div class="text-[9px] text-zinc-500 mt-2 whitespace-nowrap overflow-hidden text-ellipsis font-semibold uppercase tracking-wider">{node.title}</div>
                  <div class="flex gap-1.5 mt-2">
                    {#if node.url}
                      <button class="text-[10px] px-2 py-1 rounded-md font-semibold transition-colors bg-violet-600/20 text-violet-400 hover:bg-violet-600/30 border border-violet-500/30" onmousedown={(e) => openSource(node.url, node.text, e)}>↗ Source</button>
                    {/if}
                    <button class="text-[10px] px-2 py-1 rounded-md font-semibold transition-colors bg-red-500/15 text-red-400 hover:bg-red-500/25 border border-red-500/30" onmousedown={(e) => deleteNode(node.id, e)}>Delete</button>
                  </div>
                </div>
              </div>
            {/each}
          {/if}
        </div>
      </div>
    {/if}

    <div class="canvas-area flex-1 relative w-full h-full" bind:this={canvasEl} role="region" aria-label="Research Canvas" ondragover={onCanvasDragOver} ondrop={onCanvasDrop}>
      {#if !activeThreadId}
        <div class="absolute inset-0 flex flex-col items-center justify-center text-center px-6 pointer-events-none z-10">
          <div class="w-12 h-12 rounded-full bg-zinc-900 border border-zinc-800 flex items-center justify-center mb-4">
            <svg class="w-5 h-5 text-zinc-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"/></svg>
          </div>
          <p class="text-sm font-medium text-zinc-300">No canvas selected</p>
          <p class="text-xs text-zinc-500 mt-2 leading-relaxed max-w-[250px]">Create a canvas above, then highlight text on any page and click <strong>Add to Thread</strong> to start mapping your research.</p>
          <button class="mt-4 px-4 py-2 bg-violet-600 hover:bg-violet-700 text-white rounded-xl text-xs font-semibold pointer-events-auto transition-colors" onclick={() => { newThreadName = "My Research"; showThreadMenu = true; }}>Create Canvas</button>
        </div>
      {:else}
        <svg bind:this={svgEl} aria-label="Interactive research canvas" class="canvas-svg w-full h-full absolute inset-0 {panning ? 'panning' : ''} {edgeDrawing ? 'drawing' : ''}" role="button" tabindex="0" onmousedown={onSvgMousedown} onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSvgMousedown(e); } }} onmousemove={onSvgMousemove} onmouseup={onSvgMouseup} ondblclick={onSvgDblclick} onwheel={onSvgWheel}>
          <defs>
            <marker id="arrowhead" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="rgba(139,92,246,0.6)"/></marker>
          </defs>

          <g transform="translate({viewOffsetX},{viewOffsetY}) scale({scale})">
            <rect width={canvasW * 4} height={canvasH * 4} x={-canvasW} y={-canvasH} fill="transparent" stroke="none"/>

            <g class="layer-ghosts">
              {#each ghostPaths as target}
                <line x1={-viewOffsetX/scale} y1={target.posY} x2={target.posX - 25} y2={target.posY} 
                      stroke="rgba(168,85,247,0.5)" stroke-width="2" stroke-dasharray="8,6" 
                      class="ghost-link" stroke-linecap="round" />
                <circle cx={target.posX} cy={target.posY} r="35" fill="none" stroke="rgba(168,85,247,0.6)" stroke-width="2" stroke-dasharray="4,4" class="pulse-ring" />
              {/each}
            </g>

            <g class="layer-edges">
              {#each edges as edge (edge.id)}
                {@const src = canvasNodes.find(n => n.id === edge.sourceId)}
                {@const tgt = canvasNodes.find(n => n.id === edge.targetId)}
                {#if src && tgt}
                  <g aria-label="Edge connection" onclick={e => onClickEdge(e, edge)} onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClickEdge(e, edge); } }} role="button" tabindex="0" class="edge-group">
                    <line x1={src.posX} y1={src.posY} x2={tgt.posX} y2={tgt.posY} stroke="transparent" stroke-width="15" style="cursor:pointer" />
                    <line x1={src.posX} y1={src.posY} x2={tgt.posX} y2={tgt.posY} stroke={edgeStrokeColor(edge.score, edge.manual)} stroke-width={edgeStrokeWidth(edge.score)} stroke-linecap="round" />
                  </g>
                {/if}
              {/each}

              {#if edgeDrawing && edgeSourceId}
                {@const src = canvasNodes.find(n => n.id === edgeSourceId)}
                {#if src}
                  <line x1={src.posX} y1={src.posY} x2={edgeTempX} y2={edgeTempY} stroke="rgba(168,85,247,0.8)" stroke-width="3" stroke-dasharray="6,4" />
                {/if}
              {/if}
            </g>

            <g class="layer-nodes">
              {#each canvasNodes as node (node.id)}
                {@const isExpanded = expandedNodeId === node.id}
                {@const isHovered = hoveredNodeId === node.id}
                {@const isHighlight = node.type === "highlight"}
                {@const r = 24}
                
                <g class="node-group {isExpanded ? 'expanded' : ''}" transform="translate({node.posX},{node.posY})"
                   aria-label="Draggable node" role="button" tabindex="0" onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); startNodeDrag(e, node); } }}
                   onmousedown={e => startNodeDrag(e, node)}
                   onmouseup={e => { finishEdgeDrop(e, node.id); }}
                   onmouseenter={() => hoveredNodeId = node.id}
                   onmouseleave={() => hoveredNodeId = null}>
                  
                  {#if edgeDrawing && edgeSourceId !== node.id}
                    <circle r={r + 10} fill="rgba(168,85,247,0.15)" stroke="rgba(168,85,247,0.5)" stroke-width="2" stroke-dasharray="4,4"/>
                  {/if}

                  {#if isExpanded}
                    {@const cardW = 220}
                    {@const cardH = Math.min(160, 60 + Math.ceil(node.text.length / 28) * 14)}
                    <g transform="translate({-cardW/2}, {-cardH/2})" aria-label="Expanded node card" role="button" tabindex="0" onmousedown={e => e.stopPropagation()} onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); } }}>
                      <rect width={cardW} height={cardH} rx="12" fill="#18181b" stroke={isHighlight ? "#8b5cf6" : "#f59e0b"} stroke-width="2" class="node-card-bg shadow-drop" />
                      
                      <g transform="translate({cardW - 20}, 10)" aria-label="Close node" style="cursor:pointer;" role="button" tabindex="0" onmousedown={(e) => { e.stopPropagation(); expandedNodeId = null; }} onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); expandedNodeId = null; } }}>
                        <circle r="8" cx="4" cy="4" fill="rgba(255,255,255,0.1)"/>
                        <text x="4" y="7.5" font-size="10" fill="#a1a1aa" text-anchor="middle">✕</text>
                      </g>

                      <foreignObject x="12" y="12" width={cardW - 30} height={cardH - 45}>
                        <div xmlns="http://www.w3.org/1999/xhtml" class="node-expanded-text">
                          "{node.text.slice(0, 300)}{node.text.length > 300 ? "..." : ""}"
                        </div>
                      </foreignObject>

                      <g transform="translate(12, {cardH - 20})">
                        {#if isHighlight && node.url}
                          <text aria-label="Open source" font-size="10" font-weight="600" fill="#a78bfa" style="cursor:pointer;" role="button" tabindex="0" onmousedown={(e) => openSource(node.url, node.text, e)} onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSource(node.url, node.text, e); } }}>↗ Source</text>
                        {/if}
                        <text aria-label="Delete node" x={cardW - 60} font-size="10" font-weight="600" fill="#f87171" style="cursor:pointer;" role="button" tabindex="0" onmousedown={e => deleteNode(node.id, e)} onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); deleteNode(node.id, e); } }}>Delete</text>
                      </g>
                    </g>
                  {:else}
                    <circle r={r} fill="#18181b" stroke={isHighlight ? "#8b5cf6" : "#f59e0b"} stroke-width={isHovered ? 3 : 2} class="node-circle" />
                    
                    <g transform="translate(-10, -10)" class="transition-all duration-200 {isHovered ? 'brightness-125 drop-shadow-[0_0_4px_rgba(167,139,250,0.6)]' : 'brightness-100'}">
                      {#if isHighlight}
                        <svg width="20" height="20" fill="none" stroke="#a78bfa" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"/><path d="M9 9h1.5m-1.5 4h6m-6 4h6"/></svg>
                      {:else}
                        <svg width="20" height="20" fill="none" stroke="#fbbf24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/></svg>
                      {/if}
                    </g>

                    <g transform="translate({r - 6}, {r - 6})" aria-label="Expand node" style="cursor:pointer;" role="button" tabindex="0" onmousedown={e => { e.stopPropagation(); expandedNodeId = node.id; }} onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); expandedNodeId = node.id; } }}>
                      <circle r="9" fill="#27272a" stroke="#52525b" stroke-width="1.5" class="expand-btn"/>
                      <path d="M-3,-3 L-3,-1 M-3,-3 L-1,-3 M3,3 L3,1 M3,3 L1,3" stroke="#a1a1aa" stroke-width="1.5" fill="none" stroke-linecap="round"/>
                    </g>

                    {#if isHovered && !edgeDrawing}
                      <g transform="translate({r + 4}, {-r + 6})" aria-label="Start edge connection" style="cursor:crosshair;" role="button" tabindex="0" onmousedown={e => { e.stopPropagation(); startEdgeDraw(e, node.id); }} onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); startEdgeDraw(e, node.id); } }}>
                        <circle r="9" fill="#27272a" stroke="#8b5cf6" stroke-width="1.5" class="expand-btn"/>
                        <path d="M-4,0 L4,0 M0,-4 L0,4" stroke="#c084fc" stroke-width="1.5" fill="none" stroke-linecap="round"/>
                      </g>
                    {/if}

                    <text y={r + 16} text-anchor="middle" font-size="9" fill="#a1a1aa" font-family="system-ui,sans-serif" style="pointer-events:none;">{node.title.slice(0, 16)}{node.title.length > 16 ? "..." : ""}</text>
                    {#if node.annotation}
                      <text y={r + 28} text-anchor="middle" font-size="8.5" fill="#a78bfa" font-family="system-ui,sans-serif" style="pointer-events:none;">{node.annotation.slice(0, 20)}{node.annotation.length > 20 ? "..." : ""}</text>
                    {/if}
                  {/if}
                </g>
              {/each}
            </g>

            <g class="layer-labels">
              {#each edges as edge}
                {#if edge.label}
                  {@const src = canvasNodes.find(n => n.id === edge.sourceId)}
                  {@const tgt = canvasNodes.find(n => n.id === edge.targetId)}
                  {#if src && tgt}
                    {@const mid = edgeMid(edge)}
                    <g aria-label="Edit edge label" onclick={e => onClickEdge(e, edge)} style="cursor:pointer;" role="button" tabindex="0" onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClickEdge(e, edge); } }}>
                      <rect x={mid.x - edge.label.length * 3.2} y={mid.y - 8} width={edge.label.length * 6.4 + 8} height={16} rx="4" fill="#18181b" stroke="rgba(139,92,246,0.8)" stroke-width="1"/>
                      <text x={mid.x} y={mid.y + 4.5} text-anchor="middle" font-size="9" fill="#c084fc" font-family="system-ui,sans-serif">{edge.label}</text>
                    </g>
                  {/if}
                {/if}
              {/each}
            </g>
          </g>
        </svg>
      {/if}
    </div>
  </div>

  {#if showManualInput}
    <div class="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[100]" aria-label="Close manual input" role="button" tabindex="0" onmousedown={() => showManualInput = false} onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showManualInput = false; } }}>
      <div class="bg-zinc-900 border border-violet-500/50 rounded-xl p-4 w-[280px] shadow-[0_20px_40px_-10px_rgba(0,0,0,0.8)]" aria-label="Manual input form" role="button" tabindex="0" onmousedown={(e) => e.stopPropagation()} onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); } }}>
        <div class="text-[13px] font-semibold text-violet-400 mb-3 flex items-center gap-2">Add a thought</div>
        <textarea id="manual-node-input" class="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2.5 text-zinc-200 text-xs resize-none outline-none h-20 focus:border-violet-500" maxlength="150" placeholder="Synthesize a connection or add an idea..." bind:value={manualText} onkeydown={async e => { if (e.key === "Enter" && !e.shiftKey && manualText.trim()) { e.preventDefault(); await addManualNode(manualText.trim(), manualClickX, manualClickY); showManualInput = false; } if (e.key === "Escape") showManualInput = false; }}></textarea>
        <div class="flex items-center gap-2 mt-3">
          <span class="text-[10px] text-zinc-500">{manualText.length}/150</span>
          <button class="text-[11px] text-zinc-400 hover:text-zinc-200 bg-transparent border-none cursor-pointer px-2 py-1 rounded-md transition-colors" onclick={() => showManualInput = false}>Cancel</button>
          <button class="text-[11px] text-white bg-violet-600 hover:bg-violet-700 disabled:opacity-50 border-none rounded-lg px-3 py-1.5 font-semibold ml-auto transition-colors" onclick={async () => { if (manualText.trim()) { await addManualNode(manualText.trim(), manualClickX, manualClickY); showManualInput = false; }}}>Add Node</button>
        </div>
      </div>
    </div>
  {/if}

  {#if editingEdgeId}
    {@const edge = edges.find(e => e.id === editingEdgeId)}
    {#if edge}
      {@const mid = edgeMid(edge)}
      <div class="absolute bg-zinc-900 border border-violet-500/50 rounded-xl p-2.5 z-[60] min-w-[200px] -translate-x-1/2 shadow-[0_10px_25px_-5px_rgba(0,0,0,0.8)]" style="left:{mid.x * scale + viewOffsetX}px;top:{mid.y * scale + viewOffsetY - 60}px;" aria-label="Edge label editor" role="button" tabindex="0" onmousedown={(e) => e.stopPropagation()} onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); } }}>
        <input class="w-full bg-zinc-950 border border-zinc-800 focus:border-violet-500 rounded-lg px-2.5 py-1.5 text-zinc-200 text-xs outline-none" type="text" maxlength="40" placeholder="Label connection..." bind:value={editingEdgeLabel} onkeydown={e => { if (e.key === "Enter") finishEdgeLabel(editingEdgeId); if (e.key === "Escape") editingEdgeId = null; }} use:focus />
        <div class="flex items-center gap-1.5 mt-2">
          <button class="text-[11px] text-zinc-400 hover:text-zinc-200 bg-transparent border-none cursor-pointer px-2 py-1 rounded-md transition-colors" onclick={() => editingEdgeId = null}>✕</button>
          <button class="text-[11px] text-red-400 bg-red-500/15 hover:bg-red-500/25 border border-red-500/30 rounded-md px-2.5 py-1 transition-colors" onclick={e => deleteEdge(editingEdgeId, e)}>Unlink</button>
          <button class="text-[11px] text-white bg-violet-600 hover:bg-violet-700 border-none rounded-lg px-3 py-1.5 font-semibold ml-auto transition-colors" onclick={() => finishEdgeLabel(editingEdgeId)}>Save</button>
        </div>
      </div>
    {/if}
  {/if}

  <div class="flex items-center gap-3 px-3 py-1.5 border-t border-zinc-800 text-[10px] text-zinc-500 font-mono bg-zinc-900 z-20 shrink-0">
    <span>{canvasNodes.length} nodes · {edges.length} connections</span>
    {#if simRunning}
      <span class="text-violet-500 animate-pulse">⚙ Physics Active</span>
    {/if}
  </div>
</div>

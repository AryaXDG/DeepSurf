/**
 * @fileoverview Rehydrates and highlights previously saved text clips on the active webpage using fuzzy matching.
 *
 * Runs isolated inside the user's active webpage (host DOM) as a content script, and must locate and wrap text nodes without causing layout shifting or layout cycles. Appends CSS stylesheets to the head, mutates text node trees by inserting custom HTML `<mark>` tags, and queries local highlight records from the background.
 */

import { MSG } from "../lib/messages.js";

const HIGHLIGHT_CLASS = "deepsurf-active-highlight";
const STYLE_ID = "deepsurf-highlight-styles";

/**
 * Injects CSS styling rules for the highlight mark elements into the document header.
 * @returns {void}
 */
function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
        .${HIGHLIGHT_CLASS} {
            background-color: rgba(139, 92, 246, 0.3) !important;
            border-bottom: 2px solid rgba(139, 92, 246, 0.6) !important;
            border-radius: 2px !important;
            transition: background-color 0.3s !important;
            cursor: pointer !important;
        }
        .${HIGHLIGHT_CLASS}:hover {
            background-color: rgba(139, 92, 246, 0.5) !important;
        }
    `;
    document.head.appendChild(style);
}

/**
 * Flat-maps the entire DOM tree into a unified text representation and records text offsets to their originating DOM nodes.
 * @param {HTMLElement} [root=document.body] - The root node of the DOM subtree to evaluate.
 * @returns {Object} An object containing 'fullText' (string) and 'map' (Array of text offsets mapping to nodes).
 */
function createTextMap(root = document.body) {
    let fullText = "";
    const map = []; 

    if (!root) return { fullText, map };

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
    let node;
    while ((node = walker.nextNode())) {
        const parent = node.parentElement;

        // We exclude scripting, style, and metadata nodes because their inner text is not visible to users on the page.
        if (parent && ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(parent.tagName)) continue;
        
        const text = node.textContent;
        if (!text.trim()) {
            fullText += text;
            continue;
        }
        
        map.push({ node, start: fullText.length, end: fullText.length + text.length });
        fullText += text;
    }
    return { fullText, map };
}

/**
 * Translates a flat text character index back into its corresponding DOM node and relative character offset.
 * @param {Array<Object>} map - The compiled index map of DOM text offsets.
 * @param {number} textIndex - The absolute character index in the flat text string.
 * @returns {Object|null} Node and offset coordinate descriptor, or null if not found.
 */
function getDomPosition(map, textIndex) {
    for (const item of map) {
        if (textIndex >= item.start && textIndex < item.end) {
            return { node: item.node, offset: textIndex - item.start };
        }
    }
    if (map.length > 0 && textIndex >= map[map.length - 1].end) {
        const last = map[map.length - 1];
        return { node: last.node, offset: last.end - last.start };
    }
    return null;
}

/**
 * Escapes regular expression control characters within a search string.
 * @param {string} str - The raw search input text.
 * @returns {string} The escaped string safe for RegExp compilation.
 */
function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compiles a flexible regular expression that allows variable spacing between words.
 * @param {string} text - The words query to match.
 * @returns {RegExp} The compiled global regular expression pattern.
 */
function createFlexibleRegex(text) {
    const words = text.trim().split(/\s+/).filter(Boolean).map(escapeRegex);
    return new RegExp(words.join('\\s+'), 'gi');
}

/**
 * Identifies candidate match positions within a text body when an exact match fails using a word-by-word sliding window score.
 * @param {string} targetText - The text query to search for.
 * @param {string} fullText - The flat page text to search within.
 * @returns {Object|null} Descriptor containing match indexes and similarity score, or null.
 */
function fuzzySearch(targetText, fullText) {
    const targetWords = targetText.toLowerCase().match(/\b\w+\b/g);
    if (!targetWords || targetWords.length < 3) return null;

    const wordsRegex = /\b\w+\b/g;
    const domWords = [];
    const lowerFullText = fullText.toLowerCase(); 
    
    let m;
    while ((m = wordsRegex.exec(lowerFullText)) !== null) {
        domWords.push({ word: m[0], index: m.index, end: m.index + m[0].length });
    }

    let bestScore = 0;
    let bestMatch = null;
    const windowSize = targetWords.length + 5; 

    for (let i = 0; i < domWords.length; i++) {

        // We skip window checks unless the current word matches either of the first two words in our target query to optimize loop throughput.
        if (domWords[i].word !== targetWords[0] && domWords[i].word !== targetWords[1]) continue; 
        
        const windowEnd = Math.min(i + windowSize, domWords.length);
        let matchCount = 0;
        let tIdx = 0;
        let lastMatchedDomIdx = i;

        for (let j = i; j < windowEnd && tIdx < targetWords.length; j++) {
            if (domWords[j].word === targetWords[tIdx]) {
                matchCount++; tIdx++; lastMatchedDomIdx = j;
            } else if (tIdx + 1 < targetWords.length && domWords[j].word === targetWords[tIdx + 1]) {
                matchCount++; tIdx += 2; lastMatchedDomIdx = j;
            }
        }

        const score = matchCount / targetWords.length;

        // We apply a strict 70% match threshold to avoid rendering highlight marks over incorrect content when pages change slightly.
        if (score > bestScore && score > 0.70) { 
            bestScore = score;
            bestMatch = {
                startIdx: domWords[i].index,
                endIdx: domWords[lastMatchedDomIdx].end,
                score: score * 100 - 10, 
            };
        }
    }
    return bestMatch;
}

/**
 * Finds the best match candidate for a highlight query using exact flexible matching or sliding-window fuzzy search.
 * @param {Object} highlight - The highlight object containing text and context properties.
 * @param {Object} textMapObj - The flat text map descriptor.
 * @returns {Object|null} The winning match candidate descriptor.
 */
function findBestMatch(highlight, textMapObj) {
    const { fullText } = textMapObj;
    let candidates = [];

    const regex = createFlexibleRegex(highlight.text);
    let m;
    while ((m = regex.exec(fullText)) !== null) {
        candidates.push({ startIdx: m.index, endIdx: m.index + m[0].length, score: 100 });
        if (m.index === regex.lastIndex) regex.lastIndex++;
    }

    if (candidates.length === 0) {
        const fuzzy = fuzzySearch(highlight.text, fullText);
        if (fuzzy) candidates.push(fuzzy);
    }

    if (candidates.length === 0) return null;

    candidates.forEach(cand => {
        const surroundingBefore = fullText.slice(Math.max(0, cand.startIdx - 100), cand.startIdx);
        const surroundingAfter = fullText.slice(cand.endIdx, cand.endIdx + 100);


        // We use surrounding context prefixes and suffixes to resolve matching ambiguities when the identical phrase appears multiple times on the same page.
        if (highlight.contextBefore && surroundingBefore.includes(highlight.contextBefore.trim().slice(-30))) {
            cand.score += 50;
        }
        if (highlight.contextAfter && surroundingAfter.includes(highlight.contextAfter.trim().slice(0, 30))) {
            cand.score += 50;
        }
    });

    candidates.sort((a, b) => b.score - a.score);
    return candidates[0];
}

/**
 * Wraps a range of DOM nodes safely with mark wrappers, splitting text nodes if the highlight boundary is partial.
 * @param {Node} startNode - The starting DOM node boundary.
 * @param {number} startOffset - Relative character offset inside the start node.
 * @param {Node} endNode - The ending DOM node boundary.
 * @param {number} endOffset - Relative character offset inside the end node.
 * @returns {void}
 */
function safeHighlightRange(startNode, startOffset, endNode, endOffset) {
    const range = document.createRange();
    try {
        range.setStart(startNode, startOffset);
        range.setEnd(endNode, endOffset);
    } catch (e) {
        console.warn("[DeepSurf:Rehydrator] Failed to set highlight range:", e);
        return; 
    }

    if (startNode === endNode) {
        const mark = document.createElement('mark');
        mark.className = HIGHLIGHT_CLASS;
        try {
            range.surroundContents(mark);
        } catch (e) {
            console.warn("[DeepSurf:Rehydrator] Failed to surround single node:", e);
        }
        return;
    }

    const walker = document.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_TEXT, null, false);
    const nodesToWrap = [];
    let inRange = false;
    let node;
    
    while ((node = walker.nextNode())) {
        if (node === startNode) inRange = true;
        if (inRange && node.textContent.trim() !== '') nodesToWrap.push(node);
        if (node === endNode) break;
    }

    nodesToWrap.forEach(textNode => {
        if (!textNode.parentNode) return; 
        
        const isStart = textNode === startNode;
        const isEnd = textNode === endNode;
        
        let sOff = isStart ? startOffset : 0;
        let eOff = isEnd ? endOffset : textNode.length;
        
        if (sOff >= eOff) return;

        try {
            const mark = document.createElement('mark');
            mark.className = HIGHLIGHT_CLASS;
            
            const middle = textNode.splitText(sOff);

            // We restrict split offsets to the node's text length to prevent index out of bounds exceptions on dynamic page modifications.
            const safeEndLength = Math.min(eOff - sOff, middle.length); 
            middle.splitText(safeEndLength);
            
            middle.parentNode.insertBefore(mark, middle);
            mark.appendChild(middle);
        } catch (e) {
            console.warn("[DeepSurf:Rehydrator] Fragment wrapping failed for node:", e);
        }
    });
}

/**
 * Main orchestrator pulling page highlights from the database and injecting mark elements at matches.
 * @returns {Promise<void>}
 */
async function rehydrate() {
    console.log(`[DeepSurf:Rehydrator] Rehydrating highlights for: ${window.location.href}`);
    const cleanUrl = window.location.href.split('#:~:text=')[0].split(':~:text=')[0];

    const response = await chrome.runtime.sendMessage({ 
        type: MSG.GET_NODES_BY_URL, 
        payload: { url: cleanUrl } 
    });

    if (!response || !response.data || response.data.length === 0) return;

    injectStyles();

    for (const highlight of response.data) {
        const textMapObj = createTextMap(); 
        
        const bestMatch = findBestMatch(highlight, textMapObj);
        
        if (bestMatch) {
            const startPos = getDomPosition(textMapObj.map, bestMatch.startIdx);
            const endPos = getDomPosition(textMapObj.map, bestMatch.endIdx);
            
            if (startPos && endPos) {
                safeHighlightRange(startPos.node, startPos.offset, endPos.node, endPos.offset);
            }
        } else {
            console.log(`[DeepSurf:Rehydrator] Text changed too drastically to recover: "${highlight.text.slice(0, 30)}..."`);
        }
    }
}

if (document.readyState === "complete" || document.readyState === "interactive") {
    rehydrate();
} else {
    window.addEventListener("DOMContentLoaded", rehydrate, { once: true });
}

let lastUrl = location.href;

/**
 * Triggers a delayed highlights rehydration pass when client-side navigation changes the active URL path.
 * @returns {void}
 */
function onUrlChange() {
  const url = location.href;
  if (url !== lastUrl) {
    lastUrl = url;
    setTimeout(rehydrate, 1000);
  }
}

window.addEventListener("popstate", onUrlChange);
window.addEventListener("hashchange", onUrlChange);

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === MSG.SPA_NAVIGATION) {
    console.log("[DeepSurf:Rehydrator] Received SPA_NAVIGATION — scheduling re-hydration.");
    setTimeout(onUrlChange, 600);
  }
});
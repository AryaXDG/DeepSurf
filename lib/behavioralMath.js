/**
 * @fileoverview Computes mathematical metrics representing user attention spans, site inequalities, habit triggers, and behavioral velocity.
 *
 * Used by background analytics workers and stats visualization dashboards to process historical database records.
 */

/**
 * Computes transition probabilities between different browsing domains using a Markov chain model.
 * @param {Array<{domain:string, timestamp:number}>} visits - Chronologically sorted array of domain visits.
 * @param {number} [thresholdMinutes=10] - The maximum duration in minutes between visits to consider them part of the same transition chain.
 * @returns {Array<{source:string, target:string, probability:number, weight:number}>} Array of transition paths sorted by absolute weight in descending order.
 */
export function calculateMarkovTransitions(visits, thresholdMinutes = 10) {
  console.log("[DeepSurf:BehavioralMath] Calculating Markov habit transitions...");
  const transitions = {};
  const thresholdMs = thresholdMinutes * 60 * 1000;

  for (let i = 0; i < visits.length - 1; i++) {
    const current = visits[i];
    const next = visits[i + 1];

    const gap = next.timestamp - current.timestamp;
    if (gap > 0 && gap < thresholdMs) {
      if (!transitions[current.domain]) transitions[current.domain] = {};
      transitions[current.domain][next.domain] = (transitions[current.domain][next.domain] || 0) + 1;
    }
  }

  const probabilities = [];
  for (const [source, targets] of Object.entries(transitions)) {
    const totalTransitionsFromSource = Object.values(targets).reduce((a, b) => a + b, 0);
    
    for (const [target, count] of Object.entries(targets)) {
      const probability = (count / totalTransitionsFromSource).toFixed(2);

      // We ignore domain self-transitions and low-probability connections (<= 10%) to highlight actual cross-site habit paths rather than site-internal loop cycles.
      if (probability > 0.10 && source !== target) {
        probabilities.push({ source, target, probability: parseFloat(probability), weight: count });
      }
    }
  }

  return probabilities.sort((a, b) => b.weight - a.weight);
}

/**
 * Computes the Gini coefficient to measure the inequality of attention distributed across different websites.
 * @param {number[]} visitCounts - Array of visit counts representing different domains.
 * @returns {number|string} The Gini coefficient value between 0.0 (equal attention) and 1.0 (single site concentration), formatted to 3 decimal places.
 */
export function calculateGiniCoefficient(visitCounts) {
  console.log("[DeepSurf:BehavioralMath] Calculating Attention Gini coefficient...");
  if (visitCounts.length < 2) return 0;
  
  const sorted = [...visitCounts].sort((a, b) => a - b);
  const n = sorted.length;
  let cumulativeSum = 0;
  let weightedSum = 0;

  for (let i = 0; i < n; i++) {
    cumulativeSum += sorted[i];
    weightedSum += (i + 1) * sorted[i];
  }

  const mean = cumulativeSum / n;
  if (mean === 0) return 0;

  const gini = (2 * weightedSum) / (n * cumulativeSum) - (n + 1) / n;

  // We clamp the output range to [0.0, 1.0] defensively to catch float rounding errors or negative bounds resulting from division offsets.
  return Math.max(0, Math.min(1, gini)).toFixed(3);
}

/**
 * Groups consecutive engagement telemetry pulses into discrete browsing sessions.
 * @param {Array<{domain:string, timestamp:number, active_seconds:number, session_id:string}>} pulses - Chronologically sorted array of heartbeat telemetry records.
 * @param {number} [gapThresholdMinutes=20] - Inactivity duration in minutes required to divide pulses into separate sessions.
 * @returns {Array<{id:string, start:number, end:number, domains:Set<string>, totalActiveTime:number, pulseCount:number}>} Array of aggregated session objects.
 */
export function sessionize(pulses, gapThresholdMinutes = 20) {
  console.log(`[DeepSurf:BehavioralMath] Sessionizing ${pulses.length} pulses...`);
  if (!pulses.length) return [];
  
  const thresholdMs = gapThresholdMinutes * 60 * 1000;
  const sessions = [];
  let currentSession = {
    id: pulses[0].session_id,
    start: pulses[0].timestamp,
    end: pulses[0].timestamp,
    domains: new Set([pulses[0].domain]),
    totalActiveTime: pulses[0].active_seconds || 0,
    pulseCount: 1
  };

  for (let i = 1; i < pulses.length; i++) {
    const pulse = pulses[i];
    const gap = pulse.timestamp - currentSession.end;
    const sameSessionId = pulse.session_id === currentSession.id;


    // We merge consecutive telemetry pulses if they share the same browser-generated session id and the time gap is smaller than our threshold.
    if (sameSessionId && gap < thresholdMs) {
      currentSession.end = pulse.timestamp;
      currentSession.domains.add(pulse.domain);
      currentSession.totalActiveTime += pulse.active_seconds || 0;
      currentSession.pulseCount += 1;
    } else {
      sessions.push(currentSession);
      currentSession = {
        id: pulse.session_id,
        start: pulse.timestamp,
        end: pulse.timestamp,
        domains: new Set([pulse.domain]),
        totalActiveTime: pulse.active_seconds || 0,
        pulseCount: 1
      };
    }
  }
  sessions.push(currentSession);
  return sessions;
}

/**
 * Calculates the median duration in minutes of compiled browsing sessions.
 * @param {Array<{start:number, end:number}>} sessions - Array of session objects containing start and end timestamps.
 * @returns {number} The median session duration in minutes.
 */
export function calculateMedianAttentionSpan(sessions) {
  console.log("[DeepSurf:BehavioralMath] Calculating median attention span...");
  if (!sessions.length) return 0;
  const lengths = sessions.map(s => (s.end - s.start) / 1000 / 60); 
  lengths.sort((a, b) => a - b);
  const mid = Math.floor(lengths.length / 2);
  return lengths.length % 2 !== 0 ? lengths[mid] : (lengths[mid - 1] + lengths[mid]) / 2;
}

/**
 * Computes a behavioral velocity score measuring scroll speed, click rates, and mouse directional changes per minute.
 * @param {Object} pulse - A raw heartbeat telemetry record.
 * @param {number} [pulse.scroll_pixels_total] - Total pixels scrolled during the pulse interval.
 * @param {number} [pulse.interaction_count] - Combined mouse click and keyboard events.
 * @param {number} [pulse.active_seconds] - Total active duration the tab was focused during the pulse.
 * @param {number} [pulse.mouse_distance_px] - Total mouse path length in pixels.
 * @param {number} [pulse.scroll_direction_changes] - Frequency of scroll direction reversals.
 * @returns {number} The computed behavioral velocity score representing physical interaction events per minute.
 */
export function calculateDopamineVelocity(pulse) {
  const { 
    scroll_pixels_total, 
    interaction_count, 
    active_seconds, 
    mouse_distance_px, 
    scroll_direction_changes 
  } = pulse;
  
  if (!active_seconds) return 0;
  
  const baseUnits = ((scroll_pixels_total || 0) / 1000) + (interaction_count || 0);

  // We apply a multiplier representing erratic behaviors such as rapid mouse wandering and scroll directional swaps to highlight stress or hyper-engagement.
  const erraticMultiplier = 1 + ((scroll_direction_changes || 0) * 0.5) + ((mouse_distance_px || 0) / 5000);
  
  const interactionUnits = baseUnits * erraticMultiplier;
  const velocity = interactionUnits / (active_seconds / 60);
  
  return parseFloat(velocity.toFixed(2));
}
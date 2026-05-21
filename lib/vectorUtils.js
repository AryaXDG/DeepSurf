/**
 * @fileoverview Provides vector math, serialization, and rank fusion utilities for hybrid search ranking.
 *
 * Invoked by background service workers to process vector queries and blend multi-modal search scores.
 */

/**
 * Computes the cosine similarity value between two L2-normalized float32 vectors.
 * @param {number[]|Float32Array} a - A 384-dimension vector embedding array.
 * @param {number[]|Float32Array} b - A 384-dimension vector embedding array.
 * @returns {number} The similarity score ranging from -1.0 to 1.0, where 1.0 represents exact match direction.
 */
export function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  // We compute full norms defensively even though our model outputs are unit-normalized to prevent math errors if raw unnormalized embeddings are passed in.
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Serializes a numeric array or Float32Array into a Postgres-compatible string representation.
 * @param {Float32Array|number[]} vec - The source vector array containing numeric coordinates.
 * @returns {string} The formatted vector literal string matching pgvector syntax (e.g. "[0.1,0.2,...]").
 */
export function vecToLiteral(vec) {
  return "[" + Array.from(vec).join(",") + "]";
}

/**
 * Deserializes a Postgres pgvector literal string back into a standard Float32Array.
 * @param {string} literal - The raw bracket-wrapped vector string from the database.
 * @returns {Float32Array} The parsed float array representation.
 */
export function literalToVec(literal) {
  return new Float32Array(
    literal
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map(Number)
  );
}

/**
 * Blends lexical and vector search results using Reciprocal Rank Fusion (RRF).
 * @param {Array<{url:string, score:number}>} vectorResults - Ordered results returned by vector similarity.
 * @param {Array<{url:string, score:number}>} lexicalResults - Ordered results returned by full-text lexical matches.
 * @param {number} [vectorWeight=0.6] - Scaling coefficient for vector ranks, where lexical weight defaults to 1.0 minus this value.
 * @returns {Map<string, number>} A Map mapping URLs to fused search relevance ranks.
 */
export function reciprocalRankFusion(vectorResults, lexicalResults, vectorWeight = 0.6) {

  // We set K to 60 because it is the standard empirical constant that prevents outlier rankings from disproportionately skewing the blended results.
  const K = 60;
  const scores = new Map();

  const applyRank = (results, weight) => {
    results.forEach(({ url }, rank) => {
      const rrf = weight * (1 / (K + rank + 1));
      scores.set(url, (scores.get(url) ?? 0) + rrf);
    });
  };

  applyRank(vectorResults, vectorWeight);
  applyRank(lexicalResults, 1 - vectorWeight);
  return scores;
}

/**
 * Scales an array of raw scores to fit within a bounded range of [0.0, 1.0] using min-max normalization.
 * @param {number[]} scores - The array of raw search scores to scale.
 * @returns {number[]} A new array containing the normalized scores.
 */
export function minMaxNormalize(scores) {
  if (scores.length === 0) return [];
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const range = max - min;
  if (range === 0) return scores.map(() => 1);
  return scores.map((s) => (s - min) / range);
}

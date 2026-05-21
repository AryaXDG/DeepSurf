/**
 * @fileoverview Tailwind CSS design tokens and theme extensions for the DeepSurf extension.
 *
 * This configuration defines font families, custom dark colors, and slow-pulse transitions
 * to match modern visual aesthetics.
 */

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./sidepanel/**/*.{svelte,js,html}",
    "./components/**/*.svelte",
    "./offscreen/**/*.html",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["'DM Sans'", "system-ui", "sans-serif"],
        mono: ["'JetBrains Mono'", "'Fira Code'", "monospace"],
      },
      colors: {
        
        // Deep dark mode theme palette: we use specific off-black shades (zinc-950)
        // and translucent violet/fuchsia accents to construct sleek dark UI containers.
        zinc: {
          950: "#09090b",
        },
        "bg-main": "#09090b",
        "bg-surface": "#18181b",
        "bg-surface-alt": "rgba(39, 39, 42, 0.5)",
        "border-muted": "rgba(39, 39, 42, 0.6)",
        "accent-primary": "rgb(124 58 237)", 
        "accent-secondary": "rgb(217 70 239)", 
      },
      animation: {
        
        // Slow-pulse animation modifier: we override standard pulse timers
        // to prevent jarring brightness shifts when indicating model status loading states.
        "pulse-slow": "pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite",
      },
    },
  },
  plugins: [],
};

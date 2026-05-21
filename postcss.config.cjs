/**
 * PostCSS Processing Configuration
 *
 * Orchestrates the CSS transformation pipeline for the extension's UI styling.
 * This file connects Tailwind CSS (for the atomic utility framework) and 
 * Autoprefixer (to ensure UI consistency across Chrome, Firefox, and Safari targets).
 */

/**
 * @type {import('postcss').ProcessOptions}
 * Defines the active PostCSS plugins and their execution order.
 */
module.exports = {
  plugins: {

    // Tailwind is injected at the PostCSS layer rather than directly inside Vite.
    // This guarantees that all Svelte component styles and global CSS files are 
    // parsed and compiled uniformly before the final bundle generation.
    tailwindcss: {},

    // We include Autoprefixer because extension environments (especially older 
    // Firefox ESR or Safari builds) may still require specific vendor prefixes 
    // for modern CSS features like grid layouts or backdrop-filters.
    autoprefixer: {},
  },
};
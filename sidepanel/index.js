/**
 * @fileoverview Direct entry point mounting the Svelte 5 application into the sidepanel DOM.
 *
 * This script imports global styles, mounts the root App component to the #app element,
 * and exports the application instance.
 */

import { mount } from "svelte";
import App from "./index.svelte";
import "../styles/global.css";

// Front-end mounting: we link the compiled Svelte component hierarchy
// to the static element defined in index.html.
const app = mount(App, { target: document.getElementById("app") });

export default app;

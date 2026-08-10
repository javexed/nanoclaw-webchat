// Bundle entry. Phase 0 of the UI modularisation: the extracted modules plus
// the not-yet-split monolith. legacy.js shrinks as modules are carved out of
// it; when it is empty this file becomes the real composition root.
import './legacy.js';

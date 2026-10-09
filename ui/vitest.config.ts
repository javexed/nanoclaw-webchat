// Unit tests for the UI's pure logic: decisions, derivations, formatting. Node,
// not a browser — anything that needs the DOM is the browser probes' job
// (boot order, role matrix, first open, …), driven by Playwright.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});

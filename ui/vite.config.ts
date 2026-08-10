import { defineConfig } from 'vite';

// The bundle REPLACES app/public/webchat/app.js in place — same path, same
// filename, no content hash. Three things depend on that and none of them are
// worth changing for a build step:
//   - index.html loads `<script src="/app.js" type="module">` (so: format 'es')
//   - sw.js precaches '/app.js' by name
//   - the server stamps the SW cache version by hashing publicDir, so a changed
//     bundle already invalidates the cache without hashed filenames
// The output is committed and CI re-builds + diffs it (bundle-drift guard), so
// a hand-edit or a forgotten build fails the PR instead of shipping.
export default defineConfig({
  root: import.meta.dirname,
  build: {
    outDir: '../app/public/webchat',
    emptyOutDir: false,          // index.html, style.css, sw.js, icons live there
    target: 'es2022',
    minify: false,               // the bundle is committed and read in diffs
    sourcemap: false,
    rollupOptions: {
      input: 'src/main.ts',
      // Vendored libs are served from the web root and precached by sw.js
      // (/marked.min.js, /dompurify.min.js). Keep them EXTERNAL so the emitted
      // import is unchanged: bundling them would duplicate ~100KB the service
      // worker already caches and silently change what ships.
      // Explicit list, not a predicate: Rollup also passes RESOLVED filesystem
      // paths here, which likewise start with '/' and end with '.js' — a
      // pattern match externalised legacy.js itself and emitted a 0.02 kB
      // bundle that "built" fine. An allowlist fails loudly on a new vendored
      // import instead of silently dropping real code.
      external: ['/marked.min.js', '/dompurify.min.js'],
      output: {
        format: 'es',
        entryFileNames: 'app.js',
        // One file: index.html has a single <script> tag and no import map.
        codeSplitting: false,
      },
    },
  },
});

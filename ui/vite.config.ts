import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

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
  plugins: [vue()],
  resolve: {
    // `import { shallowReactive } from 'vue'` has to emit an import of the
    // VENDORED runtime, not pull Vue into the bundle. The alias rewrites the
    // bare specifier to the web-root path, and the external list below then
    // leaves it alone — the same shape marked and dompurify already use.
    //
    // Runtime-only build on purpose: @vitejs/plugin-vue compiles every SFC
    // template to a render function at build time, so the template compiler
    // (60KB more) is never needed in the browser. Importing a build WITH the
    // compiler would work and silently ship dead weight, which is why this
    // points at an exact filename rather than the package.
    alias: { vue: '/vue.runtime.min.js' },
  },
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
      external: ['/marked.min.js', '/dompurify.min.js', '/vue.runtime.min.js'],
      output: {
        format: 'es',
        entryFileNames: 'app.js',
        // One file: index.html has a single <script> tag and no import map.
        codeSplitting: false,
      },
    },
  },
});

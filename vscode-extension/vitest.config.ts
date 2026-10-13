// Many tests here drive real git in throwaway repos; on a CI runner shared by
// several jobs a few take seconds, and vitest's 5 s default turned load into
// failures (5037 ms on a busy runner). Nothing here is slow by design.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 20_000,
  },
});

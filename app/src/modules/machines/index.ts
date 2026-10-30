// Agent machines: VMs built by NanoClaw for its agents on pluggable backends.
// Registers the `ncl machines` commands and the reconcile loop, and starts the
// machine listener (machines joining NanoClaw; off unless NANOCLAW_MACHINE_PORT).
import { registerModuleSweep } from '../../module-sweep.js';
import './cli.js';
import { startMachineListener } from './listener.js';
import { reconcileAll } from './reconcile.js';
import { machinesReady } from './store.js';

registerModuleSweep('machines-reconcile', async () => {
  if (await machinesReady()) await reconcileAll();
});

// After startup (env loaded); later sweeps are no-ops once it is up.
registerModuleSweep('machines-listener', async () => startMachineListener(), 10_000);

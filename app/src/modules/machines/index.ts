// Agent machines: VMs built by NanoClaw for its agents on pluggable backends.
// Registers the `ncl machines` commands and the reconcile loop.
import { registerModuleSweep } from '../../module-sweep.js';
import './cli.js';
import { reconcileAll } from './reconcile.js';
import { machinesReady } from './store.js';

registerModuleSweep('machines-reconcile', async () => {
  if (await machinesReady()) await reconcileAll();
});

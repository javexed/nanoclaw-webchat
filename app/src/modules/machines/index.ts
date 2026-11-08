// Machines that join NanoClaw (docs/webchat/scaling.md): starts the machine
// listener (off unless NANOCLAW_MACHINE_PORT). Workers keep a lasting link to
// it and run the workload stacks placed on them.
import { registerModuleSweep } from '../../module-sweep.js';
import { startMachineListener } from './listener.js';

// After startup (env loaded); later sweeps are no-ops once it is up.
registerModuleSweep('machines-listener', async () => startMachineListener(), 10_000);

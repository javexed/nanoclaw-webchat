// Backend drivers by name. A new backend is a new entry here and nothing else.
import type { MachineDriver } from '../types.js';
import { fakeDriver } from './fake.js';

const drivers = new Map<string, MachineDriver>([[fakeDriver.backend, fakeDriver]]);

export function registerDriver(d: MachineDriver): void {
  drivers.set(d.backend, d);
}

export function driverFor(backend: string): MachineDriver {
  const d = drivers.get(backend);
  if (!d) throw new Error(`no machine backend "${backend}" is installed`);
  return d;
}

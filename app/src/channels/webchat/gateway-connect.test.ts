/**
 * Central reaching the credential gateway: the container's name for the host
 * is translated to central's own, and an unsafe CONNECT target is refused
 * before anything is dialled.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../onecli-settings.js', () => ({
  onecliSettings: () => ({ gateway: 'onecli', url: 'http://172.17.0.1:10254', apiKey: '' }),
}));

import { connectThroughGateway, gatewayHostForCentral } from './gateway-connect.js';

describe('gatewayHostForCentral', () => {
  it("translates the container's name for the gateway host into central's own", () => {
    expect(gatewayHostForCentral('host.docker.internal')).toBe('172.17.0.1');
    expect(gatewayHostForCentral('host.containers.internal')).toBe('172.17.0.1');
    expect(gatewayHostForCentral('proxy.corp.example')).toBe('proxy.corp.example');
  });
});

describe('connectThroughGateway', () => {
  it('refuses an unsafe target before dialling the gateway', async () => {
    const target = { host: '127.0.0.1', port: 1, username: 'x', password: 'y' };
    await expect(connectThroughGateway(target, 'a.example\r\nX: y', 443)).rejects.toThrow('unsafe CONNECT target');
    await expect(connectThroughGateway(target, 'a.example', 0)).rejects.toThrow('unsafe CONNECT target');
  });
});

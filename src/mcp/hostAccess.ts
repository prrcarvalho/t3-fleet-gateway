import type { GatewayConfig, HostConfig } from '../config.ts';
import { GatewayError } from '../errors.ts';
import { permits } from '../oauth/scopes.ts';
import type { ToolContext } from './tools.ts';

/**
 * The host a read tool names, if the agent may read it. An unknown host and one the grant cannot read are the
 * same generic `not_found`, raised before the registry, a cache or T3 is touched, so nothing about the host leaks.
 */
export function readableHost(config: GatewayConfig, context: ToolContext, hostId: string): HostConfig {
  const host = config.hosts.find((candidate) => candidate.id === hostId);
  if (!host || !permits(context.scopes, 'read', host.id)) throw new GatewayError('not_found', `No host "${hostId}". fleet_status lists the hosts you can use.`);
  return host;
}

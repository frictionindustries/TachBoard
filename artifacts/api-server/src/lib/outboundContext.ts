import { AsyncLocalStorage } from "node:async_hooks";

// Request-local, not an Axios default: concurrent accounts must never inherit
// the owner's LAN permission. Background work without an identity fails closed.
export const outboundContext = new AsyncLocalStorage<{ allowPrivate: boolean }>();

export function publicOnlyOutboundRequired(): boolean {
  return outboundContext.getStore()?.allowPrivate !== true;
}
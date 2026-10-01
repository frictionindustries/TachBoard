import { userStmts } from "./db.js";
import { outboundContext } from "./outboundContext.js";

// Follow the existing legacy-connection ownership convention: the earliest
// account owns the instance. No token claim or request parameter grants LAN
// access. This lookup also denies deleted/nonexistent accounts.
export function runAsOutboundUser<T>(userId: number, callback: () => T): T {
  const owner = userStmts.findFirst.get();
  const allowPrivate = Number.isSafeInteger(userId) && owner?.id === userId;
  return outboundContext.run({ allowPrivate }, callback);
}
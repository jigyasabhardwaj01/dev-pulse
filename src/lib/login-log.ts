import { randomBytes } from "node:crypto";
/** A unique key for one failed-attempt record (auth_tokens is used as the attempt log; no link is ever issued). */
export const newNonceForLog = () => randomBytes(18).toString("base64url");

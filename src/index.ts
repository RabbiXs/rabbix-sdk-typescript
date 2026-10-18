import pkg from "../package.json" with { type: "json" };

/** Sent as `User-Agent` on every request (see README: what this SDK sends). */
export const userAgent = `rabbix-sdk-typescript/${pkg.version}`;

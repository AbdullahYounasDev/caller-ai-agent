import { gatewayPort } from "./config";

/**
 * Where the BROWSER reaches the voice gateway — used by every Next.js route that hands
 * the console a gateway address (session tickets, voice previews), so they can never
 * point at two different places.
 *
 * VOICE_GATEWAY_PUBLIC_URL when the gateway sits behind its own hostname or a proxy;
 * otherwise the same host as this app, on the gateway's port — right for local
 * development.
 *
 * @param {import("next/server").NextRequest} request
 * @returns {{ url: string, healthUrl: string, previewUrl: string }}
 */
export function gatewayUrls(request, env = process.env) {
  const configured = env.VOICE_GATEWAY_PUBLIC_URL?.replace(/\/+$/, "");
  const base =
    configured ||
    `${request.nextUrl.protocol === "https:" ? "https:" : "http:"}//${request.nextUrl.hostname}:${gatewayPort(env)}`;
  return {
    url: `${base.replace(/^http/, "ws")}/call`,
    healthUrl: `${base}/health`,
    previewUrl: `${base}/voices/preview`,
  };
}

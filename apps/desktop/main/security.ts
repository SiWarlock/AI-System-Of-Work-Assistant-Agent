import type { Session } from "electron";

// ── Content-Security-Policy (§5 Electron security, REQ-S-004) ────────────────
// The renderer is an unprivileged consumer. Production locks it to same-origin
// code + the loopback worker API only; dev additionally allows Vite's HMR client
// (inline/eval + its dev-server websocket). The loopback worker binds an
// ephemeral 127.0.0.1 port, so connect-src uses a loopback wildcard port.
const LOOPBACK_CONNECT = "http://127.0.0.1:* ws://127.0.0.1:*";

export function cspHeader(isDev: boolean): string {
  const scriptSrc = isDev ? "'self' 'unsafe-inline' 'unsafe-eval'" : "'self'";
  // Vite's dev server + HMR socket also live on localhost.
  const connectSrc = isDev
    ? `'self' ${LOOPBACK_CONNECT} http://localhost:* ws://localhost:*`
    : `'self' ${LOOPBACK_CONNECT}`;
  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src ${connectSrc}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

// Attach the CSP to every response the renderer session receives.
export function installCsp(session: Session, isDev: boolean): void {
  const policy = cspHeader(isDev);
  session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [policy],
      },
    });
  });
}

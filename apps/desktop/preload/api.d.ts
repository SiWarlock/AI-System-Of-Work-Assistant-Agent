import type { SowBridge } from "./bridge";

// The renderer sees the privileged bridge only through this typed global.
declare global {
  interface Window {
    readonly sow: SowBridge;
  }
}

export {};

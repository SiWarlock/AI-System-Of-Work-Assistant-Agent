import { contextBridge, ipcRenderer } from "electron";
import { buildSowBridge } from "./bridge";

// Expose the narrow typed bridge on `window.sow`. contextIsolation is on, so
// this is the ONLY channel between the unprivileged renderer and main.
contextBridge.exposeInMainWorld("sow", buildSowBridge(ipcRenderer.invoke.bind(ipcRenderer)));

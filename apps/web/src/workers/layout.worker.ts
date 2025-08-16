// Layout worker (LLD §10), exposed with Comlink: runs the layout engine off the main thread.
//
// ELK itself runs in a nested worker of its own (elk-worker.min.js, through elk-api's
// workerFactory). Its bundled build cannot run inside this worker: in any worker context it
// takes over `self.onmessage` instead of running in-thread, which would swallow Comlink's messages.
import * as Comlink from "comlink";
import ELK from "elkjs/lib/elk-api.js";
import elkWorkerUrl from "elkjs/lib/elk-worker.min.js?url";
import { LayoutEngine } from "./layout.engine.ts";
import type { LayoutApi, LayoutInput, LayoutRegistry } from "./layout.types.ts";

let engine: LayoutEngine | undefined;

const api: LayoutApi = {
  async init(registry: LayoutRegistry) {
    engine = new LayoutEngine(registry, new ELK({ workerUrl: elkWorkerUrl, workerFactory: (url) => new Worker(url!) }));
  },
  async layout(input: LayoutInput) {
    if (!engine) throw new Error("layout worker: init() first");
    return engine.layout(input);
  },
};

Comlink.expose(api);

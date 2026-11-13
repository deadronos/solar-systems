/// <reference lib="webworker" />
/**
 * Web Worker entry: runs the logistics economy off the main thread.
 * Protocol and logic live in `economy.ts` (`createEconomyServer`).
 */
import { createEconomyServer, type ToEconomy } from './economy.ts';

declare const self: DedicatedWorkerGlobalScope;

// Yield between slices with a MessageChannel: unlike nested setTimeout it isn't clamped to
// 4 ms, and new targets from the main thread are handled in between.
const channel = new MessageChannel();
let next: (() => void) | null = null;
channel.port1.addEventListener('message', () => {
  const fn = next;
  next = null;
  fn?.();
});
channel.port1.start();

const handle = createEconomyServer(
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- worker scope
  (msg) => self.postMessage(msg),
  (fn) => {
    next = fn;
    channel.port2.postMessage(0);
  },
);

self.addEventListener('message', (e: MessageEvent<ToEconomy>) => handle(e.data));

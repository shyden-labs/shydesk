/**
 * The few WebdriverIO calls the harness makes, typed here. The WebdriverIO
 * runner puts `browser` on the global object of every test worker; its own
 * type declarations do not check cleanly under this repository's strict
 * compiler settings with library checks on, so they are not loaded.
 */

/** A W3C element reference, as WebDriver returns an element from a page script. */
export type ElementReference = Record<'element-6066-11e4-a52e-4f735466cecf', string>;

export interface Element {
  click(): Promise<void>;
  addValue(value: string): Promise<void>;
  getText(): Promise<string>;
  waitForExist(options: { timeout: number; timeoutMsg: string }): Promise<true>;
  isExisting(): Promise<boolean>;
  /** In the native layer: the element's top-left corner, in device pixels. */
  getLocation(): Promise<{ x: number; y: number }>;
  /** In the native layer: the element's size, in device pixels. */
  getSize(): Promise<{ width: number; height: number }>;
}

/** A W3C pointer action sequence, sent as one real input. */
export interface PointerAction {
  move(to: { x: number; y: number; duration?: number }): PointerAction;
  down(): PointerAction;
  pause(ms: number): PointerAction;
  up(): PointerAction;
  perform(): Promise<void>;
}

/** A W3C wheel action sequence, sent as one real input. */
export interface WheelAction {
  scroll(scroll: { x: number; y: number; deltaX: number; deltaY: number; duration: number }): WheelAction;
  perform(): Promise<void>;
}

export interface Driver {
  capabilities: Record<string, unknown>;
  url(path: string): Promise<void>;
  getContext(): Promise<string | { id: string }>;
  switchContext(name: string): Promise<void>;
  keys(keys: string[]): Promise<void>;
  /** Runs `script` in the page with `args` (elements arrive as DOM elements); reads only, never input. */
  execute<T>(script: string, ...args: unknown[]): Promise<T>;
  action(type: 'pointer', options: { parameters: { pointerType: 'touch' | 'mouse' } }): PointerAction;
  action(type: 'wheel'): WheelAction;
  /** A lazy handle; awaiting it resolves the element, as a page script needs. */
  $(selector: string | ElementReference): Element & PromiseLike<Element>;
  /** The browser's own accessible name for the element (W3C Get Computed Label). */
  getElementComputedLabel(elementId: string): Promise<string>;
  waitUntil(condition: () => Promise<boolean>, options: { timeout: number; timeoutMsg: string }): Promise<true>;
}

/** The test worker's WebDriver session. */
export function driver(): Driver {
  const session = (globalThis as { browser?: Driver }).browser;
  if (session === undefined) throw new Error('no WebDriver session: run this through `npm run test:e2e`');
  return session;
}

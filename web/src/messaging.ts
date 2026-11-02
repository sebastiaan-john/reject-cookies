import browser from './browser';
import type { ExtensionRequest, ResponseTo } from './protocol';

/** Sends a request to the background script and returns its typed reply. */
export function request<R extends ExtensionRequest>(message: R): Promise<ResponseTo<R>> {
  return browser.runtime.sendMessage(message) as Promise<ResponseTo<R>>;
}

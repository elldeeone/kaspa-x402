import { parseSompiString } from "@kaspa-x402/core";
import type { ChannelLookupScope, ChannelStore, DirectModeChannel } from "./types.js";

export class MemoryChannelStore implements ChannelStore {
  readonly #channels = new Map<string, DirectModeChannel>();

  constructor(channels: readonly DirectModeChannel[] = []) {
    for (const channel of channels) {
      this.#channels.set(channel.id, cloneChannel(channel));
    }
  }

  async loadChannels(scope: ChannelLookupScope): Promise<DirectModeChannel[]> {
    return Array.from(this.#channels.values())
      .filter((channel) => matchesScope(channel, scope))
      .map(cloneChannel);
  }

  async saveChannel(channel: DirectModeChannel): Promise<void> {
    this.#channels.set(channel.id, cloneChannel(channel));
  }

  async retireChannel(channelId: string): Promise<void> {
    const channel = this.#channels.get(channelId);
    if (!channel) return;
    this.#channels.set(channelId, { ...channel, status: "retired" });
  }

  async deleteChannel(channelId: string): Promise<void> {
    this.#channels.delete(channelId);
  }

  async listRefundableChannels(nowDaa?: string): Promise<DirectModeChannel[]> {
    return Array.from(this.#channels.values())
      .filter((channel) => isRefundable(channel, nowDaa))
      .map(cloneChannel);
  }
}

function matchesScope(channel: DirectModeChannel, scope: ChannelLookupScope): boolean {
  if (scope.origin && channel.origin !== scope.origin) return false;
  if (scope.resourceUrl && channel.resourceUrl !== scope.resourceUrl) return false;
  if (scope.network && channel.config.network !== scope.network) return false;
  if (scope.status && channel.status !== scope.status) return false;
  return true;
}

function isRefundable(channel: DirectModeChannel, nowDaa?: string): boolean {
  if (!["active", "retired", "refundable"].includes(channel.status)) return false;
  return nowDaa === undefined || parseSompiString(nowDaa) > parseSompiString(channel.refundTimeoutDaa);
}

function cloneChannel(channel: DirectModeChannel): DirectModeChannel {
  return structuredClone(channel);
}

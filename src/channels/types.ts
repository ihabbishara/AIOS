export interface InboundMessage {
  channel: string;
  chatId: string;
  text: string;
  /** Who sent it (display name / platform username) — used by group-bound agents. */
  sender?: { name?: string; username?: string };
}

export type MessageHandler = (msg: InboundMessage) => Promise<void>;

export interface ChannelAdapter {
  readonly name: string;
  start(onMessage: MessageHandler): Promise<void>;
  send(chatId: string, text: string): Promise<void>;
  sendFile(chatId: string, filePath: string, caption?: string): Promise<void>;
  stop(): Promise<void>;
}

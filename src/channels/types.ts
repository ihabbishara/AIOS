export interface InboundMessage {
  channel: string;
  chatId: string;
  text: string;
}

export type MessageHandler = (msg: InboundMessage) => Promise<void>;

export interface ChannelAdapter {
  readonly name: string;
  start(onMessage: MessageHandler): Promise<void>;
  send(chatId: string, text: string): Promise<void>;
  stop(): Promise<void>;
}

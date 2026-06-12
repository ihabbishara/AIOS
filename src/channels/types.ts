export interface InboundMessage {
  channel: string;
  chatId: string;
  text: string;
  /** Who sent it (display name / platform username) — used by group-bound agents. */
  sender?: { name?: string; username?: string };
  /** Files attached to the message, already downloaded to local paths. */
  attachments?: Array<{ path: string; fileName: string }>;
  /** True when the text came from voice transcription — replies mirror back as voice. */
  voiceIn?: boolean;
}

export type MessageHandler = (msg: InboundMessage) => Promise<void>;

export interface ChannelAdapter {
  readonly name: string;
  start(onMessage: MessageHandler): Promise<void>;
  send(chatId: string, text: string): Promise<void>;
  sendFile(chatId: string, filePath: string, caption?: string): Promise<void>;
  stop(): Promise<void>;
  /** Rich approval request (e.g. inline buttons). Channels without it get a plain-text fallback. */
  sendApprovalRequest?(chatId: string, approval: { id: string; type: string; preview: string }): Promise<void>;
  /** Wire the verdict callback (button taps). Returns the user-facing outcome line. */
  setVerdictHandler?(
    handler: (v: { actionId: string; verdict: "approve" | "reject"; by: string }) => Promise<string>,
  ): void;
  /** Send a voice note (OGG/opus) with optional caption. Channels without it get text fallback. */
  sendVoice?(chatId: string, audioPath: string, caption?: string): Promise<void>;
}

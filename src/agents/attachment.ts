/** A file a specialist agent wants to deliver alongside its text reply. */
export interface Attachment {
  path: string;
  caption?: string;
  /** "voice" → deliver via sendVoice (playable voice note) where the channel supports it. */
  kind?: "voice";
}

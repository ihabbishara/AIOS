import { createInterface, type Interface } from "node:readline";
import type { ChannelAdapter, MessageHandler } from "./types.js";

/** Local REPL channel for development and testing — no external services needed. */
export class CliChannel implements ChannelAdapter {
  readonly name = "cli";
  private rl?: Interface;

  async start(onMessage: MessageHandler): Promise<void> {
    this.rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "you> " });
    this.rl.prompt();
    this.rl.on("line", (line) => {
      const text = line.trim();
      if (!text) return this.rl?.prompt();
      void onMessage({ channel: this.name, chatId: "local", text }).finally(() =>
        this.rl?.prompt(),
      );
    });
  }

  async send(_chatId: string, text: string): Promise<void> {
    process.stdout.write(`\naios> ${text}\n\n`);
    this.rl?.prompt();
  }

  async stop(): Promise<void> {
    this.rl?.close();
  }
}

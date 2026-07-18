import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { realpathSync, statSync } from "node:fs";
import type { Attachment } from "./attachment.js";

/**
 * Returns true when the resolved real path sits under at least one safe dir.
 *
 * Normal entries are treated as directories: the real path must equal the
 * entry or start with `entry + "/"`.  Entries ending with `"/"` or `"-"` are
 * treated as literal string prefixes (e.g. `"/tmp/aios-"` matches any path
 * that starts with `/tmp/aios-`).
 */
function isSafe(filePath: string, safeDirs: string[]): boolean {
  try {
    const real = realpathSync(filePath);
    const st = statSync(real);
    // Reject directories and dangling symlinks.
    if (!st.isFile()) return false;
    return safeDirs.some((d) => {
      // Trailing "/" or "-" → literal prefix match (avoids adding "/" which
      // would break the pattern, e.g. "/tmp/aios-" + "/" = "/tmp/aios-/").
      if (d.endsWith("/") || d.endsWith("-")) return real.startsWith(d);
      // Normal directory: exact match or starts-with-slash child.
      return real === d || real.startsWith(d + "/");
    });
  } catch {
    // File doesn't exist, permission denied, or broken symlink → unsafe.
    return false;
  }
}

/**
 * Builds a minimal in-process MCP server with one tool: `attach_file`.
 *
 * All successful calls push to `collector`; the caller reads it after the
 * agent turn finishes.  Safe-dir validation prevents the agent from
 * exfiltrating arbitrary paths.
 *
 * The server is intended to be instantiated fresh per turn so the collector
 * array is turn-scoped and race-free.
 */
export function buildAttachmentServer(collector: Attachment[], safeDirs: string[]) {
  const attachFile = tool(
    "attach_file",
    "Attach a local file to your reply. The file will be sent to the user via the channel " +
      "(Telegram document, Slack upload, CLI path log). Only files under your working directory " +
      "or the shared downloads/tmp dirs are permitted.",
    {
      path: z.string().describe("Absolute path to the file to attach."),
      caption: z
        .string()
        .optional()
        .describe("Short caption shown with the file (max 1 024 chars for Telegram)."),
      kind: z
        .enum(["voice"])
        .optional()
        .describe('Set to "voice" for synthesized speech so it arrives as a playable voice note.'),
    },
    async (args): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      if (!isSafe(args.path, safeDirs)) {
        return {
          content: [
            {
              type: "text",
              text: `Refused: "${args.path}" is not under a permitted directory or does not exist as a file.`,
            },
          ],
        };
      }
      collector.push({ path: args.path, caption: args.caption, kind: args.kind });
      return {
        content: [{ type: "text", text: `Queued for delivery: ${args.path}` }],
      };
    },
  );

  return createSdkMcpServer({
    name: "aios_attachments",
    version: "0.1.0",
    tools: [attachFile],
  });
}

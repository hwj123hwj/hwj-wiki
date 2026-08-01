import { ToolMessage } from "@langchain/core/messages";
import { createMiddleware } from "langchain";

const PERSONAL_HISTORY_TOOL = "openwiki_read_personal_history_batch";
const WIKI_WRITE_TOOLS = new Set(["write_file", "edit_file"]);

/**
 * Some smaller OpenAI-compatible coding models narrate intended tool calls
 * when the initial choice is left on `auto`. For a personal-history update,
 * force the first evidence read and keep tools required until the wiki has
 * actually been written once. Normal autonomous selection resumes afterwards.
 */
export function createPersonalToolStartMiddleware() {
  return createMiddleware({
    name: "OpenWikiPersonalToolStartMiddleware",
    wrapModelCall: async (request, handler) => {
      if (!requestContainsPersonalEvidence(request.messages)) {
        return handler(request);
      }

      const toolMessages = request.messages.filter((message) =>
        ToolMessage.isInstance(message),
      );
      const hasReadEvidence = toolMessages.some(
        (message) => message.name === PERSONAL_HISTORY_TOOL,
      );
      const hasWrittenWiki = toolMessages.some(
        (message) => message.name && WIKI_WRITE_TOOLS.has(message.name),
      );

      if (!hasReadEvidence) {
        return handler({
          ...request,
          toolChoice: {
            type: "function",
            function: { name: PERSONAL_HISTORY_TOOL },
          },
        });
      }

      return handler({
        ...request,
        toolChoice: hasWrittenWiki ? "auto" : "required",
      });
    },
  });
}

function requestContainsPersonalEvidence(
  messages: { content: unknown }[],
): boolean {
  return messages.some((message) =>
    contentText(message.content).includes(PERSONAL_HISTORY_TOOL),
  );
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as unknown[])
    .map((part) => {
      if (typeof part === "string") return part;
      if (
        typeof part === "object" &&
        part !== null &&
        "text" in part &&
        typeof part.text === "string"
      ) {
        return part.text;
      }
      return "";
    })
    .join("\n");
}

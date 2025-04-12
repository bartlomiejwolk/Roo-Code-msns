import * as vscode from "vscode"
import * as fs from "fs/promises"
import * as fsSync from "fs"
import * as path from "path"
import { Anthropic } from "@anthropic-ai/sdk"
import { ApiHandler } from "../../api"
import { formatContentBlockToMarkdown } from "../../integrations/misc/export-markdown"

function getContextLogPath(): string {
    const logDir = path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd(), '.roo')
    // Ensure directory exists
    if (!fsSync.existsSync(logDir)) {
        fsSync.mkdirSync(logDir, { recursive: true })
    }
    return path.join(logDir, 'context-summary.log')
}

// Helper function to get the content of a prompt file.
// It creates the file with default content if it doesn't exist.
async function getPromptContent(fileName: string, defaultContent: string): Promise<string> {
    // Use a "prompts" subfolder under the .roo directory
    const promptsDir = path.join(
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd(),
        ".roo",
        "prompts"
    );
    try {
        await fs.access(promptsDir);
    } catch {
        await fs.mkdir(promptsDir, { recursive: true });
    }
    const filePath = path.join(promptsDir, fileName);
    try {
        await fs.access(filePath);
    } catch {
        await fs.writeFile(filePath, defaultContent, "utf8");
    }
    return fs.readFile(filePath, "utf8");
}

const outputChannel = vscode.window.createOutputChannel("Anthropic Sliding Window")


/**
 * Number of recent messages to preserve when truncating conversation history
 * These messages are kept regardless of their type (user/assistant/utility)
 */
export const PRESERVE_RECENT_MESSAGES = 3

/**
 * Counts tokens for user content using the provider's token counting implementation.
 *
 * @param {Array<Anthropic.Messages.ContentBlockParam>} content - The content to count tokens for
 * @param {ApiHandler} apiHandler - The API handler to use for token counting
 * @returns {Promise<number>} A promise resolving to the token count
 */
export async function estimateTokenCount(
	content: Array<Anthropic.Messages.ContentBlockParam>,
	apiHandler: ApiHandler,
): Promise<number> {
	if (!content || content.length === 0) return 0
	return apiHandler.countTokens(content)
}

/**
 * Truncates a conversation by removing system messages, files, and search results.
 *
 * The first message is always retained.
 *
 * @param {Anthropic.Messages.MessageParam[]} messages - The conversation messages.
 * @param {number} fracToRemove - The fraction (between 0 and 1) of messages to remove.
 * @returns {Anthropic.Messages.MessageParam[]} The truncated conversation messages.
 */
export function truncateConversation(
	messages: Anthropic.Messages.MessageParam[],
	messagesToPreserve: number = PRESERVE_RECENT_MESSAGES,
): Anthropic.Messages.MessageParam[] {
	outputChannel.appendLine(`Starting truncation of ${messages.length} messages (preserving last ${messagesToPreserve} messages):`)

	// Always preserve the last N messages regardless of type
	const preservedMessages = messages.slice(-messagesToPreserve)
	
	// Filter remaining messages (excluding preserved ones)
	const filtered = messages.slice(0, -messagesToPreserve).filter((message, index) => {
		// Never truncate the last message
		if (index === messages.length - 1) {
			outputChannel.appendLine(
				`- KEEPING last message: role=${message.role} ` +
					`content=${JSON.stringify(message.content).slice(0, 50)}...`,
			)
			return true
		}

		const content =
			typeof message.content === "string"
				? message.content
				: message.content.map((c) => (c.type === "text" ? c.text : "")).join("")
		const isUtilityMessage =
			content.includes("[read_file") ||
			content.includes("[search_files") ||
			content.includes("[list_files") ||
			content.includes("<write_to_file>") ||
			content.includes("[list_code_definition_names") ||
			content.includes("[switch_mode") ||
			content.includes("[ERROR]") ||
			content.includes("[TASK RESUMPTION]")
		const keep = !isUtilityMessage
		outputChannel.appendLine(
			`- ${keep ? "KEEPING" : "REMOVING"} message: role=${message.role} ` +
				`content=${JSON.stringify(content).slice(0, 100)}...`,
		)
		return keep
	})

	const result = [...filtered, ...preservedMessages]
	outputChannel.appendLine(`Truncation complete. Kept ${result.length} of ${messages.length} messages.`)
	return result
}

/**
 * Summarizes conversation history while preserving the last message raw.
 * Maintains maximum technical detail for task continuity.
 *
 * @param {Anthropic.Messages.MessageParam[]} messages - Full conversation history
 * @param {ApiHandler} apiHandler - API handler instance
 * @returns {Promise<Anthropic.Messages.MessageParam[]>} Messages with summarized history + raw last message
 */
export async function summarizeConversation(
  messages: Anthropic.Messages.MessageParam[],
  apiHandler: ApiHandler,
): Promise<Anthropic.Messages.MessageParam[]> {
  if (messages.length <= 1) return messages;
  
  const firstUserMessage = messages[0];  // Assume first message is the full task description.

  // Always keep last message completely raw
  const lastMessage = messages[messages.length - 1];
  const toSummarize = messages.slice(0, -1);

  // Define the default text for the appended user prompt
  const defaultPrompt1 = `Please provide a comprehensive technical summary covering all key points. Include:
- The original task description (first user message) exactly as stated
- All relevant files mentioned with their full paths
- Every important symbol (functions, classes, variables) we discussed
- All major decisions made and the reasoning behind them
- Any errors encountered and how we fixed them
- All commands executed and their outcomes
- The current state of the task

Make it detailed (4-5 paragraphs) while keeping it concise and technical. Avoid conversational openers and focus on factual accuracy.`;

  // Load prompt1 from file (it will be created if missing)
  const prompt1 = await getPromptContent("context-summary-prompt1.txt", defaultPrompt1);

  const messagesToSummarize: Anthropic.Messages.MessageParam[] = [
    ...toSummarize,
    {
      role: "user",
      content: prompt1
    }
  ];

  try {
    // Define the default text for the API call prompt
    const defaultPrompt2 = `You are summarizing a technical conversation in detail. Your summary should:
* Always begin with the original task description (first user message) exactly as stated
* Be direct and factual without conversational openers
* Mention every relevant file with its full path
* Note all important code symbols (functions, classes, variables) we discussed
* Explain technical details concisely
* Maintain the chronological sequence of events
* Highlight all key decisions, actions, and their reasoning
* Include any errors and how they were resolved
* Be comprehensive (4-5 paragraphs) while remaining technical and to-the-point`;

    // Load prompt2 from file (it will be auto-created using defaultPrompt2 if missing)
    const prompt2 = await getPromptContent("context-summary-prompt2.txt", defaultPrompt2);

    const summaryResponse = await apiHandler.createMessage(
      prompt2,
      messagesToSummarize
    );

    let summaryContent: string = ""
    for await (const chunk of summaryResponse) {
        if (chunk.type === "text") {
            summaryContent += chunk.text
        } else if (chunk.type === "reasoning") {
            // Optional: Handle reasoning chunks if needed
        }
    }

    const summarizedMessages: Anthropic.Messages.MessageParam[] = [
      firstUserMessage,  // Prepend the full task description.
      {
        role: "assistant" as const,
        content: `### TECHNICAL CONTEXT RECAP ###\n${summaryContent}`
      },
      lastMessage // Append raw final message
    ];

    // Log only the summarized context that will be sent to the main model
    try {
      const logPath = getContextLogPath()
      const logContent = summarizedMessages
        .map(msg => `${msg.role.toUpperCase()}:\n${
          typeof msg.content === 'string' 
            ? msg.content 
            : msg.content.map(c => c.type === 'text' ? c.text : `[${c.type} content]`).join('\n')
        }`)
        .join('\n\n')
      await fs.writeFile(logPath, logContent)
      outputChannel.appendLine(`Context summary logged to ${logPath}`)
    } catch (logError) {
      outputChannel.appendLine(`Failed to log context summary: ${logError}`)
    }

    return summarizedMessages
  } catch (error) {
    outputChannel.appendLine(`Summarization failed, falling back to original messages: ${error}`);
    return messages; // Fallback to original if summarization fails
  }
}

/**
 * Conditionally truncates the conversation messages if the total token count
 * exceeds the model's limit, considering the size of incoming content.
 *
 * @param {Anthropic.Messages.MessageParam[]} messages - The conversation messages.
 * @param {number} totalTokens - The total number of tokens in the conversation (excluding the last user message).
 * @param {number} contextWindow - The context window size.
 * @param {number} maxTokens - The maximum number of tokens allowed.
 * @param {ApiHandler} apiHandler - The API handler to use for token counting.
 * @returns {Anthropic.Messages.MessageParam[]} The original or truncated conversation messages.
 */

type TruncateOptions = {
	messages: Anthropic.Messages.MessageParam[]
	totalTokens: number
	contextWindow: number
	maxTokens?: number | null
	apiHandler: ApiHandler
}

/**
 * Conditionally truncates the conversation messages if the total token count
 * exceeds the maxTokens limit.
 *
 * @param {TruncateOptions} options - The options for truncation
 * @returns {Promise<Anthropic.Messages.MessageParam[]>} The original or truncated conversation messages.
 */

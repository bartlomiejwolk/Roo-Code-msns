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

async function logApiCall(
  type: 'task' | 'summarization',
  prompt: string,
  messages: Anthropic.Messages.MessageParam[],
  apiHandler: ApiHandler
) {
  try {
    const tokens = await logTokenCount(messages, apiHandler, `${type} call input`);
    outputChannel.appendLine(`Sending ${type} LLM call with ${messages.length} messages (~${tokens} tokens)`);
    outputChannel.appendLine(`System prompt: ${prompt.slice(0, 100)}${prompt.length > 100 ? '...' : ''}`);
    if (messages.length > 0) {
      outputChannel.appendLine(`First message: ${JSON.stringify(messages[0].content).slice(0, 100)}...`);
    }
  } catch (error) {
    outputChannel.appendLine(`Failed to log ${type} LLM call: ${error}`);
  }
}

async function logTokenCount(content: Anthropic.Messages.MessageParam[], apiHandler: ApiHandler, description: string) {
  try {
    const tokens = await estimateTokenCount(
      content.flatMap(m => typeof m.content === 'string' 
        ? [{ type: 'text', text: m.content }] 
        : m.content
      ),
      apiHandler
    );
    outputChannel.appendLine(`${description} token count: ${tokens}`);
    return tokens;
  } catch (error) {
    outputChannel.appendLine(`Failed to count tokens for ${description}: ${error}`);
    return 0;
  }
}


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
  outputChannel.appendLine(`Starting conversation summarization. Total messages: ${messages.length}.`);
  
  // Add token count for full conversation
  await logTokenCount(messages, apiHandler, 'Full conversation');

  if (messages.length <= 1) return messages;
  
  const firstUserMessage = messages[0];  // Assume first message is the full task description.
  const lastMessage = messages[messages.length - 1];
  
  // Add token count for last message
  await logTokenCount([lastMessage], apiHandler, 'Last message');

  outputChannel.appendLine(
    `First message (user query): ${
      typeof firstUserMessage.content === "string"
        ? firstUserMessage.content.slice(0, 50)
        : "[complex content]"
    }, Last message type: ${lastMessage.role}`
  );

  const toSummarize = messages.slice(0, -1);
  
  // Add token count for messages to summarize
  await logTokenCount(toSummarize, apiHandler, 'Messages to summarize');

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
  outputChannel.appendLine(`Loaded prompt1 for context summary (length: ${prompt1.length}).`);

  const messagesToSummarize: Anthropic.Messages.MessageParam[] = [
    ...toSummarize,
    {
      role: "user",
      content: prompt1
    }
  ];
  outputChannel.appendLine(`Prepared summary request with ${messagesToSummarize.length} messages.`);

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
    outputChannel.appendLine(`Loaded prompt2 for API call (length: ${prompt2.length}).`);
    outputChannel.appendLine(`Sending summary request to API. Prompt snippet: "${prompt2.slice(0,50)}...", Messages count: ${messagesToSummarize.length}.`);
    
    // Add token count for summary request
    await logTokenCount(messagesToSummarize, apiHandler, 'Summary request payload');
    await logApiCall('summarization', prompt2, messagesToSummarize, apiHandler);

    const summaryResponse = await apiHandler.createMessage(
      prompt2,
      messagesToSummarize
    );

    let summaryContent: string = "";
    let outputTokens = 0;
    for await (const chunk of summaryResponse) {
        outputChannel.appendLine(`Received summary response chunk of type: ${chunk.type}${
          chunk.type === "text" ? `, snippet: "${chunk.text.slice(0,50)}"` : ""
        }`);
        if (chunk.type === "text") {
            summaryContent += chunk.text;
            outputTokens += await logTokenCount(
              [{ role: 'assistant', content: chunk.text }], 
              apiHandler,
              'Response chunk'
            );
        } else if (chunk.type === "usage") {
            outputChannel.appendLine(`Token usage: input=${chunk.inputTokens}, output=${chunk.outputTokens}`);
            outputTokens = chunk.outputTokens;
        }
    }
    outputChannel.appendLine(`Completed API response. Total summary length: ${summaryContent.length} characters, ~${outputTokens} tokens.`);

    const summarizedMessages: Anthropic.Messages.MessageParam[] = [
      firstUserMessage,  // Prepend the full task description.
      {
        role: "assistant" as const,
        content: `### TECHNICAL CONTEXT RECAP ###\n${summaryContent}`
      },
      lastMessage // Append raw final message
    ];

    // Log only the summarized context that will be sent to the main model
    outputChannel.appendLine(`Attempting to log summarized context to file...`);
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

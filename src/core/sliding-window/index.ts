import * as vscode from "vscode"
import { Anthropic } from "@anthropic-ai/sdk"
import { ApiHandler } from "../../api"

const outputChannel = vscode.window.createOutputChannel("Anthropic Sliding Window")

/**
 * Default percentage of the context window to use as a buffer when deciding when to truncate
 */
export const TOKEN_BUFFER_PERCENTAGE = 0.1

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
	_fracToRemove: number, // Still accept but ignore the parameter for backward compatibility
): Anthropic.Messages.MessageParam[] {
	outputChannel.appendLine(`Starting truncation of ${messages.length} messages:`)

	const filtered = messages.filter((message, index) => {
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
		const isFileOrSearch =
			content.trim().startsWith("[read_file") ||
			content.trim().startsWith("[search_files") ||
			content.trim().startsWith("[list_files")
		const hasError = content.includes("[ERROR]")
		const keep = !isFileOrSearch && !hasError
		outputChannel.appendLine(
			`- ${keep ? "KEEPING" : "REMOVING"} message: role=${message.role} ` +
				`content=${JSON.stringify(content).slice(0, 50)}...`,
		)
		return keep
	})

	outputChannel.appendLine(`Truncation complete. Kept ${filtered.length} of ${messages.length} messages.`)
	return filtered
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

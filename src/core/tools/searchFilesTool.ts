import { Cline } from "../Cline"
import { ToolUse } from "../assistant-message"
import { AskApproval, HandleError, PushToolResult, RemoveClosingTag } from "./types"
import { ClineSayTool } from "../../shared/ExtensionMessage"
import { getReadablePath } from "../../utils/path"
import path from "path"
import { regexSearchFiles } from "../../services/ripgrep"

export async function searchFilesTool(
	cline: Cline,
	block: ToolUse,
	askApproval: AskApproval,
	handleError: HandleError,
	pushToolResult: PushToolResult,
	removeClosingTag: RemoveClosingTag,
) {
	const relDirPath: string | undefined = block.params.path
	// Accept either regex or text parameter, prioritizing text if both are provided
	const searchText: string | undefined = block.params.text || block.params.regex
	const filePattern: string | undefined = block.params.file_pattern
	const sharedMessageProps: ClineSayTool = {
		tool: "searchFiles",
		path: getReadablePath(cline.cwd, removeClosingTag("path", relDirPath)),
		regex: removeClosingTag("text", searchText) || removeClosingTag("regex", searchText),
		filePattern: removeClosingTag("file_pattern", filePattern),
	}
	try {
		if (block.partial) {
			const partialMessage = JSON.stringify({
				...sharedMessageProps,
				content: "",
			} satisfies ClineSayTool)
			await cline.ask("tool", partialMessage, block.partial).catch(() => {})
			return
		} else {
			if (!relDirPath) {
				cline.consecutiveMistakeCount++
				pushToolResult(await cline.sayAndCreateMissingParamError("search_files", "path"))
				return
			}
			if (!searchText) {
				cline.consecutiveMistakeCount++
				// Check if text was provided, if not, show error for text parameter
				pushToolResult(await cline.sayAndCreateMissingParamError("search_files", "text"))
				return
			}
			cline.consecutiveMistakeCount = 0
			const absolutePath = path.resolve(cline.cwd, relDirPath)
			const results = await regexSearchFiles(
				cline.cwd,
				absolutePath,
				searchText,
				filePattern,
				cline.rooIgnoreController,
				true // Make search case-insensitive by default
			)
			const completeMessage = JSON.stringify({
				...sharedMessageProps,
				content: results,
			} satisfies ClineSayTool)
			const didApprove = await askApproval("tool", completeMessage)
			if (!didApprove) {
				return
			}
			pushToolResult(results)
			return
		}
	} catch (error) {
		await handleError("searching files", error)
		return
	}
}

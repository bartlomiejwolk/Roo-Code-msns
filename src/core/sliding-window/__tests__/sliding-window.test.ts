// npx jest src/core/sliding-window/__tests__/sliding-window.test.ts

import { Anthropic } from "@anthropic-ai/sdk"

import { ModelInfo } from "../../../shared/api"
import { BaseProvider } from "../../../api/providers/base-provider"
import { estimateTokenCount, truncateConversation } from "../index"

// Create a mock ApiHandler for testing
class MockApiHandler extends BaseProvider {
	createMessage(): any {
		throw new Error("Method not implemented.")
	}

	getModel(): { id: string; info: ModelInfo } {
		return {
			id: "test-model",
			info: {
				contextWindow: 100000,
				maxTokens: 50000,
				supportsPromptCache: true,
				supportsImages: false,
				inputPrice: 0,
				outputPrice: 0,
				description: "Test model",
			},
		}
	}
}

// Create a singleton instance for tests
const mockApiHandler = new MockApiHandler()

/**
 * Tests for the truncateConversation function
 */
describe("truncateConversation", () => {
	it("should filter messages starting with file operations", () => {
		const messages: Anthropic.Messages.MessageParam[] = [
			{ role: "user", content: "First message" },
			{ role: "assistant", content: "[read_file test.txt]" },
			{ role: "user", content: "Third message" },
			{ role: "assistant", content: "[search_files *.ts]" },
			{ role: "user", content: "Last message" },
		]

		const result = truncateConversation(messages, 0)

		expect(result).toEqual([
			{ role: "user", content: "First message" },
			{ role: "user", content: "Third message" },
			{ role: "user", content: "Last message" },
		])
	})

	it("should always keep the last message", () => {
		const messages: Anthropic.Messages.MessageParam[] = [
			{ role: "user", content: "First message" },
			{ role: "assistant", content: "Second message" },
			{ role: "user", content: "[read_file important.txt]" },
		]

		const result = truncateConversation(messages, 0)

		expect(result).toEqual([
			{ role: "user", content: "First message" },
			{ role: "assistant", content: "Second message" },
			{ role: "user", content: "[read_file important.txt]" },
		])
	})

	it("should handle mixed content types", () => {
		const messages: Anthropic.Messages.MessageParam[] = [
			{ role: "user", content: "First message" },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "[search_files *.ts]" },
					{ type: "text", text: "Some analysis" },
				],
			},
			{ role: "user", content: "Last message" },
		]

		const result = truncateConversation(messages, 0)

		expect(result).toEqual([
			{ role: "user", content: "First message" },
			{ role: "user", content: "Last message" },
		])
	})

	it("should ignore fracToRemove parameter", () => {
		const messages: Anthropic.Messages.MessageParam[] = [
			{ role: "user", content: "First message" },
			{ role: "assistant", content: "[read_file test.txt]" },
			{ role: "user", content: "Last message" },
		]

		const result1 = truncateConversation(messages, 0)
		const result2 = truncateConversation(messages, 0.5)
		const result3 = truncateConversation(messages, 1)

		expect(result1).toEqual(result2)
		expect(result2).toEqual(result3)
	})
})

/**
 * Tests for the estimateTokenCount function
 */
describe("estimateTokenCount", () => {
	it("should return 0 for empty or undefined content", async () => {
		expect(await estimateTokenCount([], mockApiHandler)).toBe(0)
		// @ts-ignore - Testing with undefined
		expect(await estimateTokenCount(undefined, mockApiHandler)).toBe(0)
	})

	it("should estimate tokens for text blocks", async () => {
		const content: Array<Anthropic.Messages.ContentBlockParam> = [
			{ type: "text", text: "This is a text block with 36 characters" },
		]

		// With tiktoken, the exact token count may differ from character-based estimation
		// Instead of expecting an exact number, we verify it's a reasonable positive number
		const result = await estimateTokenCount(content, mockApiHandler)
		expect(result).toBeGreaterThan(0)

		// We can also verify that longer text results in more tokens
		const longerContent: Array<Anthropic.Messages.ContentBlockParam> = [
			{
				type: "text",
				text: "This is a longer text block with significantly more characters to encode into tokens",
			},
		]
		const longerResult = await estimateTokenCount(longerContent, mockApiHandler)
		expect(longerResult).toBeGreaterThan(result)
	})

	it("should estimate tokens for image blocks based on data size", async () => {
		// Small image
		const smallImage: Array<Anthropic.Messages.ContentBlockParam> = [
			{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "small_dummy_data" } },
		]
		// Larger image with more data
		const largerImage: Array<Anthropic.Messages.ContentBlockParam> = [
			{ type: "image", source: { type: "base64", media_type: "image/png", data: "X".repeat(1000) } },
		]

		// Verify the token count scales with the size of the image data
		const smallImageTokens = await estimateTokenCount(smallImage, mockApiHandler)
		const largerImageTokens = await estimateTokenCount(largerImage, mockApiHandler)

		// Small image should have some tokens
		expect(smallImageTokens).toBeGreaterThan(0)

		// Larger image should have proportionally more tokens
		expect(largerImageTokens).toBeGreaterThan(smallImageTokens)

		// Verify the larger image calculation matches our formula including the 50% fudge factor
		expect(largerImageTokens).toBe(48)
	})

	it("should estimate tokens for mixed content blocks", async () => {
		const content: Array<Anthropic.Messages.ContentBlockParam> = [
			{ type: "text", text: "A text block with 30 characters" },
			{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "dummy_data" } },
			{ type: "text", text: "Another text with 24 chars" },
		]

		// We know image tokens calculation should be consistent
		const imageTokens = Math.ceil(Math.sqrt("dummy_data".length)) * 1.5

		// With tiktoken, we can't predict exact text token counts,
		// but we can verify the total is greater than just the image tokens
		const result = await estimateTokenCount(content, mockApiHandler)
		expect(result).toBeGreaterThan(imageTokens)

		// Also test against a version with only the image to verify text adds tokens
		const imageOnlyContent: Array<Anthropic.Messages.ContentBlockParam> = [
			{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "dummy_data" } },
		]
		const imageOnlyResult = await estimateTokenCount(imageOnlyContent, mockApiHandler)
		expect(result).toBeGreaterThan(imageOnlyResult)
	})

	it("should handle empty text blocks", async () => {
		const content: Array<Anthropic.Messages.ContentBlockParam> = [{ type: "text", text: "" }]
		expect(await estimateTokenCount(content, mockApiHandler)).toBe(0)
	})

	it("should handle plain string messages", async () => {
		const content = "This is a plain text message"
		expect(await estimateTokenCount([{ type: "text", text: content }], mockApiHandler)).toBeGreaterThan(0)
	})
})

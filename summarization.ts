import { getPromptContent } from './utils/promptUtils';

const defaultPrompt1 = "Default context summary prompt 1 text...";
const defaultPrompt2 = "Default context summary prompt 2 text...";

async function summarize() {
    const prompt1 = await getPromptContent("context-summary-prompt1.txt", defaultPrompt1);
    const prompt2 = await getPromptContent("context-summary-prompt2.txt", defaultPrompt2);

    someSummarizerFunction({ prompt1, prompt2 });
}

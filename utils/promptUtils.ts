import { promises as fs } from "fs";
import path from "path";

const baseDir = path.join(__dirname, "prompts");

async function getPromptContent(
  fileName: string,
  defaultContent: string
): Promise<string> {
  const filePath = path.join(baseDir, fileName);
  try {
    await fs.access(filePath);
  } catch {
    // File does not exist - create it and populate with default text.
    await fs.mkdir(baseDir, { recursive: true });
    await fs.writeFile(filePath, defaultContent, "utf8");
  }
  return fs.readFile(filePath, "utf8");
}

export { getPromptContent };

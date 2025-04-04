# Roo Conversation Cleaner
# ========================
# 
# Purpose:
# --------
# This script reduces token usage in conversations with large language models (LLMs) like Claude by removing 
# contextual overhead from Roo Code conversations. It was specifically designed to clean up conversations 
# from the Roo Code VSCode extension, which contains significant token overhead from environment details,
# file contents, search results, and other metadata.
#
# Why It's Needed:
# ---------------
# When using LLMs with token limits (like Claude/GPT), conversations that include code exploration can
# quickly accumulate thousands of tokens from:
# 1. Environment details blocks containing system information
# 2. Loaded file contents from the `read_file` tool
# 3. Search results from the `search_files` tool
# 4. Custom instructions and style information
# 5. Other system-level information not essential to the conversation
#
# These elements consume tokens but don't contribute meaningfully to the conversation context once they've
# been processed. Removing them allows you to continue conversations that would otherwise hit token limits.
#
# How It Works:
# ------------
# The script processes a Roo conversation in a markdown file using these steps:
#
# 1. Preprocessing: 
#    - Removes large blocks of system information enclosed in tags like <environment_details>
#    - Strips custom instructions, style information, and other system metadata
#
# 2. Line-by-line Processing:
#    - Parses the conversation line by line to maintain its structure
#    - Uses a "skip mode" flag to track when we're in file content sections
#    - Enters skip mode when encountering file output markers like "[read_file for..." or "[search_files for..."
#    - Preserves essential conversation elements (User/Assistant headers and separators)
#    - Exits skip mode when reaching the next message marker
#
# 3. Content Preservation:
#    - Maintains the actual conversation text between User and Assistant 
#    - Simplifies tool calls to their essential form
#    - Removes confidence level statements that aren't needed for context
#
# 4. Final Cleanup:
#    - Performs pattern matching to remove any remaining file content patterns
#    - Ensures clean transitions between preserved conversation elements
#
# Usage:
# ------
# python clean_roo_conversation.py input_file.md [output_file.md]
#
# If no output file is specified, the script saves to "[input_file].abridged.md"
#
# Key Benefits:
# ------------
# - Reduces token usage by 50-90% depending on the conversation
# - Preserves the essential conversation flow and context
# - Allows continuation of lengthy code exploration conversations
# - Works with any Roo Code conversation format
#
# Limitations:
# -----------
# - Not designed for conversations from other extensions or chat interfaces
# - May remove some content if it closely resembles file content patterns
# - Requires manual checking if the conversation includes critical code snippets

import re
import sys

def clean_conversation(input_file, output_file):
    with open(input_file, 'r', encoding='utf-8') as f:
        content = f.read()
    
    # Remove frequently occurring tags
    content = re.sub(r'<environment_details>[\s\S]*?<\/environment_details>', '', content)
    content = re.sub(r'<custom_instructions>[\s\S]*?<\/custom_instructions>', '', content)
    content = re.sub(r'<styles_info>[\s\S]*?<\/styles_info>', '', content)
    content = re.sub(r'<election_info>[\s\S]*?<\/election_info>', '', content)
    content = re.sub(r'<artifacts_info>[\s\S]*?<\/artifacts_info>', '', content)
    content = re.sub(r'<examples>[\s\S]*?<\/examples>', '', content)
    content = re.sub(r'<functions>[\s\S]*?<\/functions>', '', content)
    content = re.sub(r'<userStyle>.*?<\/userStyle>', '', content)
    
    # Split the content into lines for line-by-line processing
    lines = content.split('\n')
    abridged_lines = []
    
    i = 0
    skip_mode = False
    
    while i < len(lines):
        line = lines[i]
        
        # Check for file output lines
        if re.match(r'\[read_file for ', line):
            abridged_lines.append('[read_file - content removed]')
            skip_mode = True
        elif re.match(r'\[search_files for ', line):
            abridged_lines.append('[search_files - content removed]')
            skip_mode = True
        # User or Assistant headers should always be kept
        elif line.strip() == '**User:**' or line.strip() == '**Assistant:**':
            abridged_lines.append(line)
            skip_mode = False
        # The separator between messages
        elif line.strip() == '---':
            abridged_lines.append(line)
            skip_mode = False
        # Keep non-file content lines when not in skip mode
        elif not skip_mode:
            # Still remove confidence level statements
            if not re.match(r'Confidence level: \d+/10', line):
                # Clean XML tool tags
                line = re.sub(r'<(search_files|read_file)>[\s\S]*?<\/(search_files|read_file)>', 
                          '[TOOL CALL: \\1]', line)
                abridged_lines.append(line)
        # Check if we're exiting skip mode (end of file content)
        elif line.strip() == '' and i+1 < len(lines) and (
                lines[i+1].strip() == '**User:**' or 
                lines[i+1].strip() == '**Assistant:**' or
                lines[i+1].strip() == '---'):
            skip_mode = False
            abridged_lines.append(line)
        
        i += 1
    
    # Join the processed lines
    abridged_content = '\n'.join(abridged_lines)
    
    # Final cleanup for any missed patterns
    # Remove file content with lines and dashed separations
    abridged_content = re.sub(r'\d+ \|.*\n-{4,}', '', abridged_content)
    
    # Write the abridged content to the output file
    with open(output_file, 'w', encoding='utf-8') as f:
        f.write(abridged_content)

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python script.py input_file [output_file]")
        sys.exit(1)
    
    input_file = sys.argv[1]
    
    if len(sys.argv) > 2:
        output_file = sys.argv[2]
    else:
        # Split the filename from its extension and add .abridged
        base_name = input_file.rsplit('.', 1)[0]  # This gets just the filename without extension
        output_file = base_name + ".abridged.md"
    
    clean_conversation(input_file, output_file)
    print(f"abridged conversation saved to {output_file}")

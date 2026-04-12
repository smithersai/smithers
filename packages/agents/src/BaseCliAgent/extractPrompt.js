import { extractTextFromJsonValue } from "./extractTextFromJsonValue.js";
/**
 * @typedef {{ prompt: string; systemFromMessages?: string; }} PromptParts
 */

/**
 * @param {any} content
 * @returns {string}
 */
function contentToText(content) {
    if (typeof content === "string")
        return content;
    if (Array.isArray(content)) {
        return content
            .map((part) => {
            if (typeof part === "string")
                return part;
            if (part && typeof part === "object") {
                if (typeof part.text === "string")
                    return part.text;
                if (typeof part.content === "string")
                    return part.content;
            }
            return "";
        })
            .join("");
    }
    if (content == null)
        return "";
    return String(content);
}
/**
 * @param {ModelMessage[]} messages
 * @returns {PromptParts}
 */
function messagesToPrompt(messages) {
    const systemParts = [];
    const promptParts = [];
    for (const msg of messages) {
        const text = contentToText(msg.content);
        if (!text)
            continue;
        const role = msg.role;
        if (role === "system") {
            systemParts.push(text);
            continue;
        }
        if (role) {
            promptParts.push(`${String(role).toUpperCase()}: ${text}`);
        }
        else {
            promptParts.push(text);
        }
    }
    return {
        prompt: promptParts.join("\n\n"),
        systemFromMessages: systemParts.length
            ? systemParts.join("\n\n")
            : undefined,
    };
}
/**
 * @param {any} options
 * @returns {PromptParts}
 */
export function extractPrompt(options) {
    if (!options)
        return { prompt: "" };
    if ("prompt" in options) {
        const promptInput = options.prompt;
        if (typeof promptInput === "string") {
            return { prompt: promptInput };
        }
        if (Array.isArray(promptInput)) {
            return messagesToPrompt(promptInput);
        }
        return { prompt: "" };
    }
    if (Array.isArray(options.messages)) {
        return messagesToPrompt(options.messages);
    }
    return { prompt: "" };
}

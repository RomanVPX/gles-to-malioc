import { ParsedShaderVariant } from "./types";

// Set to true to enable detailed parsing logs
const DEBUG = true;

/**
 * Parse a compiled shader file (Unity shader disassembly format)
 * into individual variants with their vertex and fragment code.
 */
export function parseCompiledShader(content: string): ParsedShaderVariant[] {
  const variants: ParsedShaderVariant[] = [];

  // Split by the separator line (multiple slashes) but keep track of line numbers
  const allLines = content.split("\n");
  let currentLine = 0;
  let currentBlock = "";
  let blockStartLine = 0;

  for (let i = 0; i < allLines.length; i++) {
    const line = allLines[i];

    // Check if this is a separator line
    if (/^\/{50,}$/.test(line)) {
      // Process accumulated block
      if (currentBlock.trim()) {
        const variant = parseVariantBlock(currentBlock, blockStartLine);
        if (variant && (variant.vertexCode || variant.fragmentCode)) {
          variants.push(variant);
        }
      }
      // Start new block
      currentBlock = "";
      blockStartLine = i + 2; // +1 for next line, +1 for 1-indexed
    } else {
      currentBlock += line + "\n";
    }
  }

  // Process last block
  if (currentBlock.trim()) {
    const variant = parseVariantBlock(currentBlock, blockStartLine);
    if (variant && (variant.vertexCode || variant.fragmentCode)) {
      variants.push(variant);
    }
  }

  if (DEBUG) {
    console.log(`[Parser] Parsed ${content.length} chars → ${variants.length} variant(s)`);
    if (variants.length === 0) {
      // Show what we tried to parse when nothing was found
      const preview = content.substring(0, 500).replace(/\n/g, '\\n');
      console.log(`[Parser] No variants found. First 500 chars: "${preview}"`);
    }
  }
  return variants;
}

function parseVariantBlock(block: string, blockStartLine: number): ParsedShaderVariant | null {
  const lines = block.split("\n");

  // Extract keywords
  let keywords: string[] = [];
  let tier: string | undefined;
  let api: string | undefined;

  for (const line of lines) {
    const trimmed = line.trim();

    // Keywords: <keywords>
    if (trimmed.startsWith("Keywords:")) {
      const keywordsStr = trimmed.replace("Keywords:", "").trim();
      if (keywordsStr && keywordsStr !== "<none>") {
        keywords = keywordsStr.split(/\s+/);
      } else {
        keywords = ["<none>"];
      }
    }

    // -- Hardware tier variant: Tier 1
    if (trimmed.includes("Hardware tier variant:")) {
      const match = trimmed.match(/Tier\s+\d+/i);
      if (match) {
        tier = match[0];
      }
    }

    // -- Vertex shader for "gles3":
    if (trimmed.includes("shader for")) {
      const match = trimmed.match(/shader for ["']([^"']+)["']/i);
      if (match) {
        api = match[1];
      }
    }
  }

  // Extract vertex code with line number
  const vertexResult = extractShaderCodeWithLine(block, "VERTEX", blockStartLine);

  // Extract fragment code with line number
  const fragmentResult = extractShaderCodeWithLine(block, "FRAGMENT", blockStartLine);

  if (!vertexResult && !fragmentResult) {
    return null;
  }

  // Generate unique ID
  const keywordsKey = keywords.join("_").replace(/[<>]/g, "");
  const id = `${keywordsKey}_${tier || "unknown"}_${Math.random().toString(36).substr(2, 9)}`;

  return {
    id,
    keywords,
    tier,
    api,
    vertexCode: vertexResult?.code,
    fragmentCode: fragmentResult?.code,
    vertexLineNumber: vertexResult?.versionLine,
    fragmentLineNumber: fragmentResult?.versionLine,
  };
}

/**
 * Extract shader code between #ifdef SHADER_TYPE and #endif
 * Properly handles nested preprocessor directives (#if/#ifdef/#ifndef/#endif)
 * Returns code and line number of #version in original file
 */
function extractShaderCodeWithLine(
  block: string,
  shaderType: "VERTEX" | "FRAGMENT",
  blockStartLine: number
): { code: string; versionLine: number } | undefined {
  const ifdefPattern = new RegExp(`^\\s*#ifdef\\s+${shaderType}\\s*$`, "i");
  const endifPattern = /^\s*#endif\s*$/i;
  // Patterns for nested preprocessor directives
  const nestedIfPattern = /^\s*#(if|ifdef|ifndef)\b/i;

  const lines = block.split("\n");
  let inShaderBlock = false;
  let nestingLevel = 0;
  const codeLines: string[] = [];
  let shaderStartLine = 0; // Line where #ifdef SHADER_TYPE appears

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmedLine = line.trim();

    // Check if this is the start of our target shader block
    if (!inShaderBlock && ifdefPattern.test(line)) {
      inShaderBlock = true;
      nestingLevel = 1; // Start counting from 1
      shaderStartLine = i; // Remember where shader block starts
      continue;
    }

    if (inShaderBlock) {
      // Check for nested #if/#ifdef/#ifndef
      if (nestedIfPattern.test(trimmedLine)) {
        nestingLevel++;
        codeLines.push(line);
        continue;
      }

      // Check for #endif
      if (endifPattern.test(trimmedLine)) {
        nestingLevel--;

        if (nestingLevel === 0) {
          // This #endif closes our #ifdef SHADER_TYPE
          break;
        } else {
          // This #endif closes a nested block, include it in the code
          codeLines.push(line);
          continue;
        }
      }

      // Regular line inside the shader block
      codeLines.push(line);
    }
  }

  if (codeLines.length === 0) {
    return undefined;
  }

  const code = codeLines.join("\n").trim();

  // Find #version line within extracted code
  let versionLineOffset = 0;
  for (let i = 0; i < codeLines.length; i++) {
    if (codeLines[i].trim().startsWith("#version")) {
      versionLineOffset = i;
      break;
    }
  }

  // Calculate absolute line number in original file
  const versionLine = blockStartLine + shaderStartLine + 1 + versionLineOffset;

  if (DEBUG && code) {
    console.log(`[Parser] ${shaderType}: ${code.length} chars at line ${versionLine}`);
  }

  return { code, versionLine };
}

/**
 * Convert parsed variants into a flat list of items (vertex + fragment separately)
 * for display in List UI.
 */
export function variantsToListItems(variants: ParsedShaderVariant[]): Array<{
  id: string;
  type: "vertex" | "fragment";
  shaderTypeShort: string;
  code: string;
  keywords: string[];
  keywordsDisplay: string;
  tier?: string;
  api?: string;
  lineNumber?: number;
}> {
  const items: Array<{
    id: string;
    type: "vertex" | "fragment";
    shaderTypeShort: string;
    code: string;
    keywords: string[];
    keywordsDisplay: string;
    tier?: string;
    api?: string;
    lineNumber?: number;
  }> = [];

  for (const variant of variants) {
    const keywordsDisplay = variant.keywords.join(" ");

    if (variant.vertexCode) {
      items.push({
        id: `${variant.id}_vertex`,
        type: "vertex",
        shaderTypeShort: "VERT",
        code: variant.vertexCode,
        keywords: variant.keywords,
        keywordsDisplay,
        tier: variant.tier,
        api: variant.api,
        lineNumber: variant.vertexLineNumber,
      });
    }

    if (variant.fragmentCode) {
      items.push({
        id: `${variant.id}_fragment`,
        type: "fragment",
        shaderTypeShort: "FRAG",
        code: variant.fragmentCode,
        keywords: variant.keywords,
        keywordsDisplay,
        tier: variant.tier,
        api: variant.api,
        lineNumber: variant.fragmentLineNumber,
      });
    }
  }

  return items;
}

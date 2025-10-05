import { ParsedShaderVariant } from "./types";

// Set to true to enable detailed parsing logs
const DEBUG = true;

/**
 * Parse a compiled shader file (Unity shader disassembly format)
 * into individual variants with their vertex and fragment code.
 */
export function parseCompiledShader(content: string): ParsedShaderVariant[] {
  const variants: ParsedShaderVariant[] = [];

  // Split by the separator line (multiple slashes)
  const blocks = content.split(/\/{50,}/);

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (!block.trim()) continue;

    const variant = parseVariantBlock(block);
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

function parseVariantBlock(block: string): ParsedShaderVariant | null {
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

  // Extract vertex code
  const vertexCode = extractShaderCode(block, "VERTEX");

  // Extract fragment code
  const fragmentCode = extractShaderCode(block, "FRAGMENT");

  if (!vertexCode && !fragmentCode) {
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
    vertexCode,
    fragmentCode,
  };
}

/**
 * Extract shader code between #ifdef SHADER_TYPE and #endif
 * Properly handles nested preprocessor directives (#if/#ifdef/#ifndef/#endif)
 */
function extractShaderCode(block: string, shaderType: "VERTEX" | "FRAGMENT"): string | undefined {
  const ifdefPattern = new RegExp(`^\\s*#ifdef\\s+${shaderType}\\s*$`, "i");
  const endifPattern = /^\s*#endif\s*$/i;
  // Patterns for nested preprocessor directives
  const nestedIfPattern = /^\s*#(if|ifdef|ifndef)\b/i;

  const lines = block.split("\n");
  let inShaderBlock = false;
  let nestingLevel = 0;
  const codeLines: string[] = [];

  for (const line of lines) {
    const trimmedLine = line.trim();

    // Check if this is the start of our target shader block
    if (!inShaderBlock && ifdefPattern.test(line)) {
      inShaderBlock = true;
      nestingLevel = 1; // Start counting from 1
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

  const code = codeLines.join("\n").trim();
  if (DEBUG && code) {
    console.log(`[Parser] ${shaderType}: ${code.length} chars`);
  }
  return code ? code : undefined;
}

/**
 * Convert parsed variants into a flat list of items (vertex + fragment separately)
 * for display in List UI.
 */
export function variantsToListItems(variants: ParsedShaderVariant[]): Array<{
  id: string;
  type: "vertex" | "fragment";
  code: string;
  keywords: string[];
  keywordsDisplay: string;
  tier?: string;
  api?: string;
}> {
  const items: Array<{
    id: string;
    type: "vertex" | "fragment";
    code: string;
    keywords: string[];
    keywordsDisplay: string;
    tier?: string;
    api?: string;
  }> = [];

  for (const variant of variants) {
    const keywordsDisplay = variant.keywords.join(" ");

    if (variant.vertexCode) {
      items.push({
        id: `${variant.id}_vertex`,
        type: "vertex",
        code: variant.vertexCode,
        keywords: variant.keywords,
        keywordsDisplay,
        tier: variant.tier,
        api: variant.api,
      });
    }

    if (variant.fragmentCode) {
      items.push({
        id: `${variant.id}_fragment`,
        type: "fragment",
        code: variant.fragmentCode,
        keywords: variant.keywords,
        keywordsDisplay,
        tier: variant.tier,
        api: variant.api,
      });
    }
  }

  return items;
}

// Common types used across the extension

export type ShaderType = "vertex" | "fragment";

export interface ParsedShaderVariant {
  /** Unique ID for this variant (for React key) */
  id: string;
  /** Keywords for this variant, e.g., ["LIVERY_MASKS_ENABLED"] or ["<none>"] */
  keywords: string[];
  /** Hardware tier, e.g., "Tier 1" */
  tier?: string;
  /** API version, e.g., "gles3" */
  api?: string;
  /** Vertex shader code (between #ifdef VERTEX and #endif), if present */
  vertexCode?: string;
  /** Fragment shader code (between #ifdef FRAGMENT and #endif), if present */
  fragmentCode?: string;
}

export interface ShaderVariantItem {
  /** Unique ID for List.Item */
  id: string;
  /** Display title */
  title: string;
  /** Shader type */
  type: ShaderType;
  /** Shader source code */
  code: string;
  /** Keywords for filtering */
  keywords: string[];
  /** Subtitle info */
  subtitle: string;
}

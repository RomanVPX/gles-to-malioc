import {
  ActionPanel,
  Action,
  Form,
  showToast,
  Toast,
  getPreferenceValues,
  Detail,
  useNavigation,
  getSelectedText,
  LocalStorage,
} from "@raycast/api";
import { useEffect, useRef, useState } from "react";
import { exec } from "child_process";
import { writeFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

interface Preferences {
  pathToMaliOC: string;
}

const MALIOC_PATH = getPreferenceValues<Preferences>().pathToMaliOC;

// --- Interfaces for MaliOC JSON structure ---
interface MaliProducer {
  name: string;
  version: [number, number, number];
  build: string;
  documentation: string;
}

interface MaliPipeline {
  name: string;
  display_name: string;
  description: string;
}

interface MaliHardware {
  architecture: string;
  core: string;
  revision: string;
  pipelines?: MaliPipeline[];
}

interface MaliShaderType {
  api: string;
  type: string;
}

interface MaliShaderProperty {
  name: string;
  display_name: string;
  description: string;
  value: number | string | boolean;
}

interface MaliVertexAttribute {
  location: number | null;
  symbol: string;
}

interface MaliShaderCost {
  cycle_count: (number | null)[];
  bound_pipelines: (string | null)[];
}

interface MaliVariantPerformance {
  total_cycles: MaliShaderCost;
  shortest_path_cycles: MaliShaderCost;
  longest_path_cycles: MaliShaderCost;
  pipelines: string[];
}

interface MaliShaderVariant {
  name: string;
  performance: MaliVariantPerformance;
  properties: MaliShaderProperty[];
}

interface MaliShaderInfo {
  filename: string;
  hardware: MaliHardware;
  driver: string;
  shader: MaliShaderType;
  notes: string[];
  warnings: string[];
  properties: MaliShaderProperty[];
  variants: MaliShaderVariant[];
  attribute_streams?: {
    position?: MaliVertexAttribute[];
    nonposition?: MaliVertexAttribute[];
  };
  errors?: string[]; // Only present in error reports
}

interface MaliSchema {
  name: "performance" | "error" | "info" | "list";
  version: number;
}

// Base interface for all Mali reports
interface MaliReportBase {
  schema: MaliSchema;
  producer: MaliProducer;
}

// Performance report (successful compilation)
interface MaliPerformanceReport extends MaliReportBase {
  schema: { name: "performance"; version: number };
  shaders: MaliShaderInfo[];
}

// Error report (compilation failed)
interface MaliErrorReport extends MaliReportBase {
  schema: { name: "error"; version: number };
  shaders: (MaliShaderInfo & { errors: string[] })[];
}

// Union type for all possible reports
type MaliJsonOutput = MaliPerformanceReport | MaliErrorReport;

interface GpuCore {
  id: string;
  name: string;
}

type OutputMode = "text" | "json";

// --- GPU Cores Cache (LocalStorage) ---
const GPU_CORES_CACHE_KEY = "gpu_cores_cache";
const GPU_CORES_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

type GpuCoresCache = { cores: GpuCore[]; timestamp: number };

async function loadGpuCoresFromCache(): Promise<GpuCoresCache | null> {
  try {
    const raw = await LocalStorage.getItem<string>(GPU_CORES_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as GpuCoresCache;
    if (!parsed.cores || !Array.isArray(parsed.cores) || typeof parsed.timestamp !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

async function saveGpuCoresToCache(cores: GpuCore[]) {
  const payload: GpuCoresCache = { cores, timestamp: Date.now() };
  await LocalStorage.setItem(GPU_CORES_CACHE_KEY, JSON.stringify(payload));
}

function isCacheFresh(timestamp: number): boolean {
  return Date.now() - timestamp < GPU_CORES_TTL_MS;
}

async function fetchGpuCoresFromMalioc(): Promise<GpuCore[]> {
  return new Promise((resolve, reject) => {
    const command = `"${MALIOC_PATH}" -l`;
    exec(command, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      const lines = stdout.trim().split("\n");
      const cores = lines
        .map((line) => line.split(/\s+/)[0])
        .filter((name) => name.startsWith("Mali-"))
        .map((name) => ({ id: name.replace("Mali-", ""), name }));
      resolve(cores);
    });
  });
}

// --- MaliOC Validation ---
async function validateMaliOC(path: string): Promise<{isValid: boolean, error?: string}> {
  return new Promise((resolve) => {
    exec(`"${path}" --version`, (error, stdout, stderr) => {
      if (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          resolve({ isValid: false, error: "MaliOC executable not found at specified path" });
        } else {
          resolve({ isValid: false, error: `Failed to execute MaliOC: ${error.message}` });
        }
        return;
      }

      // Check if output contains "Mali Offline Compiler"
      const output = stdout + stderr;
      if (output.toLowerCase().includes("mali offline compiler")) {
        resolve({ isValid: true });
      } else {
        resolve({ isValid: false, error: "File is not Mali Offline Compiler executable" });
      }
    });
  });
}

// --- Main Component ---
export default function ProfileShader() {
  const { push } = useNavigation();
  const [shaderType, setShaderType] = useState("auto");
  const [gpuCore, setGpuCore] = useState("G57");
  const [outputMode, setOutputMode] = useState<OutputMode>("json"); // Default to JSON now
  const [gpuCores, setGpuCores] = useState<GpuCore[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [coresError, setCoresError] = useState<string | undefined>(undefined);
  const [maliocValid, setMaliocValid] = useState<boolean | null>(null);
  const [maliocError, setMaliocError] = useState<string | undefined>(undefined);
  const validateMaliocStarted = useRef(false);


  useEffect(() => {
    if (validateMaliocStarted.current) {
        return;
    }
    validateMaliocStarted.current = true;

    async function validateAndFetchCores() {
        try {
            // Load from cache for fast UI
            const cached = await loadGpuCoresFromCache();
            if (cached && cached.cores.length > 0) {
                setGpuCores(cached.cores);
                setGpuCore(cached.cores.find((c) => c.id === "G57")?.id ?? cached.cores[0].id);
                setIsLoading(false);
            }

            // Validate MaliOC
            const validation = await validateMaliOC(MALIOC_PATH);
            setMaliocValid(validation.isValid);

            if (!validation.isValid) {
                setMaliocError(validation.error);
                setIsLoading(false);
                showToast({
                    style: Toast.Style.Failure,
                    title: "MaliOC Path Invalid",
                    message: validation.error || "Please check your MaliOC installation path in preferences"
                });
                return;
            }

            // If cache is missing or stale, fetch fresh cores and cache them
            const cacheIsFresh = cached ? isCacheFresh(cached.timestamp) : false;
            if (!cacheIsFresh) {
                try {
                    const cores = await fetchGpuCoresFromMalioc();
                    setGpuCores(cores);
                    if (cores.length > 0) {
                        setGpuCore(cores.find((c) => c.id === "G57")?.id ?? cores[0].id);
                    }
                    await saveGpuCoresToCache(cores);
                } catch (error) {
                    console.error("MaliOC cores fetch failed:", error);
                    setCoresError("Could not fetch GPU cores. Please enter one manually.");
                }
            }

            setIsLoading(false);
        } catch (e) {
            console.error("Validation error:", e);
            setMaliocError("Unexpected error during MaliOC validation");
            setIsLoading(false);
        }
    }

    validateAndFetchCores();
  }, []);

  async function handleSubmit() {
    setIsLoading(true);
    let shaderContent = "";
    try {
      shaderContent = await getSelectedText();
      if (!shaderContent.trim()) throw new Error("No text selected.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not get selected text.";
      await showToast({ style: Toast.Style.Failure, title: "Error Getting Text", message });
      setIsLoading(false);
      return;
    }
    try {
      const result = await processShader(shaderContent, shaderType, gpuCore, outputMode);
      push(<ResultView output={result} mode={outputMode} />);
    } catch (error) {
      const message = error instanceof Error ? error.message : "An unknown error occurred.";
      await showToast({ style: Toast.Style.Failure, title: "MaliOC Failed", message });
    } finally {
      setIsLoading(false);
    }
  }

  async function handleRefreshCores() {
    if (maliocValid !== true) {
      await showToast({ style: Toast.Style.Failure, title: "MaliOC Not Valid", message: "Cannot refresh cores until MaliOC path is valid." });
      return;
    }
    setIsLoading(true);
    setCoresError(undefined);
    try {
      const cores = await fetchGpuCoresFromMalioc();
      setGpuCores(cores);
      if (cores.length > 0) {
        setGpuCore(cores.find((c) => c.id === "G57")?.id ?? cores[0].id);
      }
      await saveGpuCoresToCache(cores);
      await showToast({ style: Toast.Style.Success, title: "GPU Cores Updated", message: `Loaded ${cores.length} cores` });
    } catch (error) {
      console.error("Manual refresh failed:", error);
      setCoresError("Could not fetch GPU cores. Please enter one manually.");
      await showToast({ style: Toast.Style.Failure, title: "Failed to Refresh Cores" });
    } finally {
      setIsLoading(false);
    }
  }

  // Block UI if MaliOC is invalid
  if (maliocValid === false) {
    return (
      <Form
        actions={
          <ActionPanel>
            <Action title="Fix MaliOC Path" onAction={() => showToast({
              style: Toast.Style.Failure,
              title: "Open Raycast Preferences",
              message: "Go to Extensions → GLES to MaliOC → Configure MaliOC Path"
            })} />
          </ActionPanel>
        }
      >
        <Form.Description
          title="⚠️ MaliOC Path Invalid"
          text={`${maliocError}\n\nPlease check your MaliOC installation path in extension preferences.\n\nExpected: Mali Offline Compiler executable\nCurrent path: ${MALIOC_PATH}`}
        />
      </Form>
    );
  }

  return (
    <Form
      isLoading={isLoading}
      actions={
        maliocValid === true ? (
          <ActionPanel>
            <Action.SubmitForm title="Profile Shader" onSubmit={handleSubmit} />
            <Action title="Refresh GPU Cores" onAction={handleRefreshCores} />
          </ActionPanel>
        ) : (
          <ActionPanel>
            <Action title="Validating MaliOC..." onAction={() => {}} />
          </ActionPanel>
        )
      }
    >
      <Form.Dropdown id="shaderType" title="Shader Type" value={shaderType} onChange={setShaderType} storeValue>
        <Form.Dropdown.Item value="auto" title="Auto-detect" />
        <Form.Dropdown.Item value="vertex" title="Vertex" />
        <Form.Dropdown.Item value="fragment" title="Fragment" />
      </Form.Dropdown>
      {coresError || gpuCores.length === 0 ? (
        <Form.TextField id="gpuCore" title="GPU Core" placeholder="e.g., G57" value={gpuCore} onChange={setGpuCore} error={coresError} />
      ) : (
        <Form.Dropdown id="gpuCore" title="GPU Core" value={gpuCore} onChange={setGpuCore} storeValue>
          {gpuCores.map((core) => (
            <Form.Dropdown.Item key={core.id} value={core.id} title={core.name} />
          ))}
        </Form.Dropdown>
      )}
      <Form.Dropdown id="outputMode" title="Output Mode" value={outputMode} onChange={(value) => setOutputMode(value as OutputMode)} storeValue>
        <Form.Dropdown.Item value="text" title="Plain Text" />
        <Form.Dropdown.Item value="json" title="Structured Report" />
      </Form.Dropdown>
    </Form>
  );
}

// --- Result View and Formatting ---
function ResultView({ output, mode }: { output: string; mode: OutputMode }) {
  if (mode === "json") {
    try {
      const jsonData = JSON.parse(output) as MaliJsonOutput;
      return <Detail markdown={formatJsonReport(jsonData)} />;
    } catch (error) {
      return <Detail markdown={`## Failed to parse JSON\n\n**Error:**\n\`\`\`\n${error}\n\`\`\`\n\n**Raw Output:**\n\`\`\`\n${output}\n\`\`\` `} />;
    }
  }
  return <Detail markdown={`\`\`\`\n${output}\n\`\`\``} />;
}

function formatJsonReport(data: MaliJsonOutput): string {
  // Check report type and handle accordingly
  if (data.schema.name === "error") {
    const errorReport = data as MaliErrorReport;
    const shader = errorReport.shaders[0];
    return formatErrorReport(errorReport, shader);
  }

  const performanceReport = data as MaliPerformanceReport;
  const shader = performanceReport.shaders[0];

  // Handle case where compilation succeeded but no variants (shouldn't happen normally)
  if (!shader.variants || shader.variants.length === 0) {
    return formatBasicInfo(performanceReport, shader);
  }

  return formatPerformanceReport(performanceReport, shader);
}

function formatErrorReport(report: MaliErrorReport, shader: MaliShaderInfo & { errors: string[] }): string {
  return `
# MaliOC Compilation Error

## Configuration
- **Hardware:** ${shader.hardware.architecture} ${shader.hardware.core} ${shader.hardware.revision}
- **Driver:** ${shader.driver}
- **Shader:** ${shader.shader.api} ${shader.shader.type}

## Compilation Errors
${shader.errors.map(error => `- ${error}`).join('\n')}

${shader.warnings.length > 0 ? `## Warnings
${shader.warnings.map(warning => `- ${warning}`).join('\n')}` : ''}

---
*${report.producer.name} v${report.producer.version.join('.')} (Build ${report.producer.build})*
`;
}

function formatBasicInfo(report: MaliPerformanceReport, shader: MaliShaderInfo): string {
  return `
# MaliOC Report: ${shader.hardware.core}

## Configuration
- **Hardware:** ${shader.hardware.architecture} ${shader.hardware.core} ${shader.hardware.revision}
- **Driver:** ${shader.driver}
- **Shader:** ${shader.shader.api} ${shader.shader.type}

${shader.warnings.length > 0 ? `## Warnings
${shader.warnings.map(warning => `- ${warning}`).join('\n')}

` : ''}${shader.notes.length > 0 ? `## Notes
${shader.notes.map(note => `- ${note}`).join('\n')}

` : ''}---
*${report.producer.name} v${report.producer.version.join('.')} (Build ${report.producer.build})*
`;
}

function formatPerformanceReport(report: MaliPerformanceReport, shader: MaliShaderInfo): string {
  const variant = shader.variants[0]; // For now, handle first variant
  const pipelines = variant.performance.pipelines;
  const hardwarePipelines = shader.hardware.pipelines || [];

  // Helper to get property value
  const getProp = (name: string) => variant.properties.find(p => p.name === name)?.value ?? "N/A";

  // Helper to get pipeline display name
  const getPipelineDisplayName = (pipelineName: string) => {
    const hwPipeline = hardwarePipelines.find(p => p.name === pipelineName);
    return hwPipeline?.display_name || pipelineName;
  };

  // Helper to format numbers with reasonable precision
  const formatNumber = (value: number | string | boolean): string => {
    if (typeof value === "number") {
      // Round to 3 decimal places for readability
      return Number(value.toFixed(3)).toString();
    }
    return String(value);
  };

  // Helper to format performance table row
  const perfRow = (title: string, cost: MaliShaderCost) => {
    const cycles = pipelines.map((_, i) => {
      const count = cost.cycle_count[i];
      return count !== null ? formatNumber(count) : "N/A";
    }).map(s => s.padStart(8));

    const boundPipeline = cost.bound_pipelines[0];
    const boundDisplayName = boundPipeline ? getPipelineDisplayName(boundPipeline) : "N/A";

    return `| ${title.padEnd(25)} | ${cycles.join(' | ')} | ${boundDisplayName} |`;
  };

  // Create table header with pipeline names
  const headerRow = pipelines.map(name => getPipelineDisplayName(name).padStart(8)).join(' | ');
  const separatorRow = pipelines.map(() => '--------').join(' | ');

  return `
# MaliOC Report: ${shader.hardware.core}

## Configuration
- **Hardware:** ${shader.hardware.architecture} ${shader.hardware.core} ${shader.hardware.revision}
- **Driver:** ${shader.driver}
- **Shader:** ${shader.shader.api} ${shader.shader.type}

---

## Resource Usage (${variant.name})
- **Work Registers:** ${formatNumber(getProp("work_registers_used"))}
- **Uniform Registers:** ${formatNumber(getProp("uniform_registers_used"))}
- **Stack Spilling:** ${String(getProp("has_stack_spilling"))}${getProp("stack_spill_bytes") !== "N/A" && Number(getProp("stack_spill_bytes")) > 0 ? ` (${formatNumber(getProp("stack_spill_bytes"))} bytes)` : ''}
- **16-bit Arithmetic:** ${formatNumber(getProp("fp16_arithmetic"))}%

---

## Performance Metrics
| Metric                      | ${headerRow}    | Bound       |
| --------------------------- | ${separatorRow} | ----------- |
${perfRow("Total", variant.performance.total_cycles)}
${perfRow("Shortest path", variant.performance.shortest_path_cycles)}
${perfRow("Longest path", variant.performance.longest_path_cycles)}

${shader.warnings.length > 0 ? `## Warnings
${shader.warnings.map(warning => `⚠️ ${warning}`).join('\n')}

` : ''}${shader.notes.length > 0 ? `## Notes
${shader.notes.map(note => `ℹ️ ${note}`).join('\n')}

` : ''}${shader.attribute_streams ? formatAttributeStreams(shader.attribute_streams) : ''}---
*${report.producer.name} v${report.producer.version.join('.')} (Build ${report.producer.build})*
`;
}

function formatAttributeStreams(streams: { position?: MaliVertexAttribute[]; nonposition?: MaliVertexAttribute[] }): string {
  let result = '## Recommended Attribute Streams\n\n';

  if (streams.position && streams.position.length > 0) {
    result += '**Position attributes:**\n';
    streams.position.forEach(attr => {
      const location = attr.location !== null ? `location=${attr.location}` : 'location=dynamic';
      result += `- \`${attr.symbol}\` (${location})\n`;
    });
    result += '\n';
  }

  if (streams.nonposition && streams.nonposition.length > 0) {
    result += '**Non-position attributes:**\n';
    streams.nonposition.forEach(attr => {
      const location = attr.location !== null ? `location=${attr.location}` : 'location=dynamic';
      result += `- \`${attr.symbol}\` (${location})\n`;
    });
    result += '\n';
  }

  return result;
}


// --- Core Shader Processing Logic ---
async function processShader(content: string, type: string, core: string, mode: OutputMode): Promise<string> {
  let processedContent = content.trim();
  let detectedType = type;

  const lines = processedContent.split('\n');

  // Logic from the bash script, translated to TS
  if (lines[0].trim().startsWith("#ifdef VERTEX")) {
    if (type === 'auto') detectedType = 'vertex';
    lines.shift();
  } else if (lines[0].trim().startsWith("#ifdef FRAGMENT")) {
    if (type === 'auto') detectedType = 'fragment';
    lines.shift();
  }

  if (detectedType === 'auto') {
      throw new Error("Auto-detection failed: #ifdef VERTEX/FRAGMENT not found. Please select type manually.");
  }

  if (lines[lines.length - 1].trim() === "#endif") {
    lines.pop();
  }

  processedContent = lines.join('\n').trim();
  if (!processedContent.trim().startsWith("#version")) {
    throw new Error(`Invalid shader: must start with #version. Starts with: "${processedContent.split("\n")[0]}"`);
  }
  if (processedContent.includes("layout") && processedContent.includes("binding") && processedContent.includes("#version 300 es")) {
    processedContent = processedContent.replace("#version 300 es", "#version 310 es");
    await showToast({ style: Toast.Style.Success, title: "Info", message: "Upgraded shader to GLES 3.10" });
  }
  const tempPath = join(tmpdir(), `shader_${Date.now()}.glsl`);
  await writeFile(tempPath, processedContent);
  const formatFlag = mode === "json" ? "--format json" : "";
  const command = `${MALIOC_PATH} ${formatFlag} --${detectedType} --core "Mali-${core}" "${tempPath}"`;

  console.log("Executing command:", command);
  console.log("Shader content:\n---\n", processedContent, "\n---");

  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      unlink(tempPath).catch(console.error);

      if (error) {
        console.error("MaliOC Error:", error);
        console.error("MaliOC Stderr:", stderr);
        console.error("MaliOC Stdout:", stdout);

        // Handle different exit codes according to MaliOC documentation
        const exitCode = error.code;

        if (exitCode === 1) {
          // Compilation error - MaliOC should return error JSON in stdout
          if (mode === "json" && stdout.trim()) {
            console.log("MaliOC returned error JSON, resolving with stdout");
            resolve(stdout);
          } else {
            // Fallback for non-JSON mode or empty stdout
            reject(new Error(stderr || stdout || "Shader compilation failed."));
          }
        } else if (exitCode === 2) {
          // Configuration error (bad command, missing files, etc.)
          reject(new Error(`Configuration error: ${stderr || stdout || "Invalid MaliOC command or missing files."}`));
        } else {
          // Other errors
          reject(new Error(`MaliOC failed (exit code ${exitCode}): ${stderr || stdout || "Unknown error"}`));
        }
      } else {
        // Success (exit code 0)
        resolve(stdout);
      }
    });
  });
}

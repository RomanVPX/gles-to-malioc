import {
  ActionPanel,
  Action,
  Form,
  showToast,
  Toast,
  Detail,
  useNavigation,
  getSelectedText,
} from "@raycast/api";
import { useEffect, useRef, useState } from "react";
import { exec } from "child_process";
import { writeFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

const MALIOC_PATH = "/Applications/Arm_Performance_Studio_2025.4/mali_offline_compiler/malioc";

// --- Interfaces for MaliOC JSON structure ---
interface MaliProducer {
  version: [number, number, number];
  build: string;
}
interface MaliHardware {
  architecture: string;
  core: string;
  revision: string;
}
interface MaliVariantProperty {
  name: string;
  value: number | string | boolean;
}
interface MaliPerformanceEntry {
  ["cycle_count"]: number[];
  ["bound_pipelines"]: string[];
}
interface MaliVariantPerformance {
  ["total_cycles"]: MaliPerformanceEntry;
  ["shortest_path_cycles"]: MaliPerformanceEntry;
  ["longest_path_cycles"]: MaliPerformanceEntry;
}
interface MaliVariant {
  name: string;
  properties: MaliVariantProperty[];
  performance: MaliVariantPerformance;
}
interface MaliShader {
  hardware: MaliHardware;
  driver: string;
  shader: { api: string; type: "vertex" | "fragment" };
  variants: MaliVariant[];
}
interface MaliJsonOutput {
  producer: MaliProducer;
  shaders: [MaliShader];
}

interface GpuCore {
  id: string;
  name: string;
}

type OutputMode = "text" | "json";

// --- Main Component ---
export default function ProfileShader() {
  const { push } = useNavigation();
  const [shaderType, setShaderType] = useState("auto");
  const [gpuCore, setGpuCore] = useState("G57");
  const [outputMode, setOutputMode] = useState<OutputMode>("json"); // Default to JSON now
  const [gpuCores, setGpuCores] = useState<GpuCore[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [coresError, setCoresError] = useState<string | undefined>(undefined);
  const fetchGpuCoresStarted = useRef(false);


  useEffect(() => {
    if (fetchGpuCoresStarted.current) {
        return;
    }
    fetchGpuCoresStarted.current = true;

    async function fetchGpuCores() {
        try {
            const command = `${MALIOC_PATH} -l`;
            exec(command, (error, stdout) => {
                if (error) {
                    console.error("MaliOC not found or failed to execute:", error);
                    setCoresError("MaliOC not found. Please check your installation.");
                    setIsLoading(false);
                    return;
                }
                const lines = stdout.trim().split("\n");
                const cores = lines
                    .map((line) => line.split(/\s+/)[0])
                    .filter((name) => name.startsWith("Mali-"))
                    .map((name) => ({ id: name.replace("Mali-", ""), name: name }));
                setGpuCores(cores);
                if (cores.length > 0) {
                    setGpuCore(cores.find((c) => c.id === "G57")?.id ?? cores[0].id);
                }
                setIsLoading(false);
            });
        } catch (e) {
            console.error(e);
            setCoresError("Could not fetch GPU cores. Please enter one manually.");
            setIsLoading(false);
        }
    }
    fetchGpuCores();
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

  return (
    <Form
      isLoading={isLoading}
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Profile Shader" onSubmit={handleSubmit} />
        </ActionPanel>
      }
    >
      <Form.Dropdown id="shaderType" title="Shader Type" value={shaderType} onChange={setShaderType}>
        <Form.Dropdown.Item value="auto" title="Auto-detect" />
        <Form.Dropdown.Item value="vertex" title="Vertex" />
        <Form.Dropdown.Item value="fragment" title="Fragment" />
      </Form.Dropdown>
      {coresError || gpuCores.length === 0 ? (
        <Form.TextField id="gpuCore" title="GPU Core" placeholder="e.g., G57" value={gpuCore} onChange={setGpuCore} error={coresError} />
      ) : (
        <Form.Dropdown id="gpuCore" title="GPU Core" value={gpuCore} onChange={setGpuCore}>
          {gpuCores.map((core) => (
            <Form.Dropdown.Item key={core.id} value={core.id} title={core.name} />
          ))}
        </Form.Dropdown>
      )}
      <Form.Dropdown id="outputMode" title="Output Mode" value={outputMode} onChange={(value) => setOutputMode(value as OutputMode)}>
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
  const shader = data.shaders[0];
  const variant = shader.variants[0]; // Assuming one variant for now
  const getProp = (name: string) => variant.properties.find(p => p.name === name)?.value ?? "N/A";

  // Helper to format performance table row
  const perfRow = (title: string, perf: MaliPerformanceEntry) =>
    `| ${title.padEnd(25)} | ${String(perf.cycle_count[1]).padStart(5)} | ${String(perf.cycle_count[4]).padStart(5)} | ${String(perf.cycle_count[5]).padStart(5)} | ${String(perf.cycle_count[6]).padStart(5)} | ${perf.bound_pipelines[0]} |`;

  return `
# MaliOC Report: ${shader.hardware.core}

## Configuration
- **Hardware:** ${shader.hardware.architecture} ${shader.hardware.core} ${shader.hardware.revision}
- **Driver:** ${shader.driver}
- **Shader:** ${shader.shader.api} ${shader.shader.type}

---

## Resource Usage (${variant.name})
- **Work Registers:** ${getProp("work_registers_used")} (${getProp("thread_occupancy")}% occupancy)
- **Uniform Registers:** ${getProp("uniform_registers_used")}
- **Stack Spilling:** ${String(getProp("has_stack_spilling"))}
- **16-bit Arithmetic:** ${getProp("fp16_arithmetic")}%

---

## Performance Metrics
| Metric                      |     A |    LS |     V |     T | Bound       |
| --------------------------- | ----: | ----: | ----: | ----: | ----------- |
${perfRow("Total instruction cycles", variant.performance.total_cycles)}
${perfRow("Shortest path cycles", variant.performance.shortest_path_cycles)}
${perfRow("Longest path cycles", variant.performance.longest_path_cycles)}

*A = Arithmetic, LS = Load/Store, V = Varying, T = Texture*
`;
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
        reject(new Error(stderr || stdout || "MaliOC execution failed."));
      } else {
        resolve(stdout);
      }
    });
  });
}

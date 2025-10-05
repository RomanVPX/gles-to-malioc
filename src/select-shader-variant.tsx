import { useState, useRef, useEffect } from "react";
import {
  List,
  ActionPanel,
  Action,
  getSelectedText,
  showToast,
  Toast,
  useNavigation,
  Icon,
  Color,
} from "@raycast/api";
import { parseCompiledShader, variantsToListItems } from "./lib/shader-parser";
import { ResultView, getDefaultGpuCore, processShader } from "./profile-shader";

type ShaderTypeFilter = "all" | "vertex" | "fragment";

/**
 * Generate a deterministic color for a keyword using a simple hash
 */
function getKeywordColor(keyword: string): Color {
  const colors = [
    Color.Blue,
    Color.Green,
    Color.Magenta,
    Color.Orange,
    Color.Purple,
    Color.Red,
    Color.Yellow,
  ];

  // Simple hash function for deterministic color assignment
  let hash = 0;
  for (let i = 0; i < keyword.length; i++) {
    hash = keyword.charCodeAt(i) + ((hash << 5) - hash);
  }
  const index = Math.abs(hash) % colors.length;
  return colors[index];
}

export default function SelectShaderVariant() {
  const [typeFilter, setTypeFilter] = useState<ShaderTypeFilter>("all");
  const [shaderContent, setShaderContent] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Generate unique launch ID to detect new command launches
  const [launchId] = useState(() => Date.now());
  const fetchedLaunchIdRef = useRef<number | null>(null);

  const { push } = useNavigation();

  useEffect(() => {
    // Skip if already fetched for this launch
    if (fetchedLaunchIdRef.current === launchId) {
      console.log(`[SelectVariant] Already fetched for launch ${launchId}, skipping`);
      return;
    }

    async function loadShaderContent() {
      fetchedLaunchIdRef.current = launchId;
      console.log(`[SelectVariant] Loading for launch ${launchId}...`);

      try {
        setIsLoading(true);
        setError(null);

        const text = await getSelectedText();
        console.log(`[SelectVariant] Got ${text.length} chars`);

        if (!text.trim()) {
          throw new Error("No text selected. Please select a compiled shader file content.");
        }

        setShaderContent(text);
      } catch (err) {
        console.error(`[SelectVariant] Error:`, err);
        setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        setIsLoading(false);
      }
    }

    loadShaderContent();
  }, [launchId]); // Re-run when launchId changes (new command launch)

  const revalidate = () => {
    console.log(`[SelectVariant] Manual reload triggered`);
    setShaderContent(null);
    setError(null);
    setIsLoading(true);

    // Reset the fetch flag and fetch again
    fetchedLaunchIdRef.current = null;

    setTimeout(async () => {
      try {
        const text = await getSelectedText();
        console.log(`[SelectVariant] Reload: got ${text.length} chars`);

        if (!text.trim()) {
          throw new Error("No text selected. Please select a compiled shader file content.");
        }

        setShaderContent(text);
        fetchedLaunchIdRef.current = launchId;
      } catch (err) {
        console.error(`[SelectVariant] Reload error:`, err);
        setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        setIsLoading(false);
      }
    }, 100);
  };

  if (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return (
      <List>
        <List.EmptyView
          icon={{ source: "⚠️" }}
          title="Error Loading Shader"
          description={errorMessage}
          actions={
            <ActionPanel>
              <Action
                title="Retry"
                icon={Icon.ArrowClockwise}
                onAction={revalidate}
                shortcut={{ modifiers: ["cmd"], key: "r" }}
              />
              <Action.CopyToClipboard title="Copy Error" content={errorMessage} />
            </ActionPanel>
          }
        />
      </List>
    );
  }

  if (!shaderContent) {
    return <List isLoading={true} />;
  }

  // Parse shader content
  const variants = parseCompiledShader(shaderContent);
  const items = variantsToListItems(variants);

  // Filter by type
  const filteredItems = items.filter((item) => {
    if (typeFilter === "all") return true;
    return item.type === typeFilter;
  });

  // Group by keywords
  const groupedByKeywords = new Map<string, typeof filteredItems>();
  for (const item of filteredItems) {
    const key = item.keywordsDisplay || "<none>";
    if (!groupedByKeywords.has(key)) {
      groupedByKeywords.set(key, []);
    }
    groupedByKeywords.get(key)!.push(item);
  }

  async function handleProfileShader(code: string, type: "vertex" | "fragment") {
    try {
      await showToast({ style: Toast.Style.Animated, title: "Profiling shader..." });

      // Get default GPU core
      const defaultCore = await getDefaultGpuCore();
      if (!defaultCore) {
        throw new Error("No default GPU core set. Please run 'Profile Shader' command first to set one.");
      }

      // Process shader
      const output = await processShader(code, type, defaultCore, "json");

      // Show result in ResultView with json mode
      push(<ResultView output={output} mode="json" />);

      await showToast({
        style: Toast.Style.Success,
        title: "Profiling Complete",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      await showToast({
        style: Toast.Style.Failure,
        title: "Profiling Failed",
        message,
      });
    }
  }

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder="Filter shader variants..."
      navigationTitle={`Shader Variants (${filteredItems.length})`}
      searchBarAccessory={
        <List.Dropdown
          tooltip="Filter by Shader Type"
          value={typeFilter}
          onChange={(value) => setTypeFilter(value as ShaderTypeFilter)}
        >
          <List.Dropdown.Item title="All Types" value="all" />
          <List.Dropdown.Item title="Vertex Only" value="vertex" />
          <List.Dropdown.Item title="Fragment Only" value="fragment" />
        </List.Dropdown>
      }
    >
      {filteredItems.length === 0 ? (
        <List.EmptyView
          icon={{ source: "🔍" }}
          title="No Shader Variants Found"
          description={`Loaded ${shaderContent?.length || 0} chars. Check shader file format or reload.`}
          actions={
            <ActionPanel>
              <Action
                title="Reload Shader Content"
                icon={Icon.ArrowClockwise}
                onAction={revalidate}
                shortcut={{ modifiers: ["cmd"], key: "r" }}
              />
            </ActionPanel>
          }
        />
      ) : (
        Array.from(groupedByKeywords.entries()).map(([keywordsKey, groupItems]) => (
          <List.Section key={keywordsKey} title={`Keywords: ${keywordsKey}`}>
            {groupItems.map((item) => {
              // Build accessories: keyword tags first, then shader type at the end (rightmost)
              const accessories: List.Item.Accessory[] = [];

              // Add keyword tags first (skip <none>)
              if (item.keywords.length > 0 && item.keywords[0] !== "<none>") {
                item.keywords.forEach((keyword) => {
                  accessories.push({
                    tag: {
                      value: keyword,
                      color: getKeywordColor(keyword),
                    },
                  });
                });
              }

              // Add shader type (VERT/FRAG) at the end - it will be rightmost
              accessories.push({ text: item.shaderTypeShort });

              return (
                <List.Item
                  key={item.id}
                  title={item.lineNumber ? `Ln ${item.lineNumber}` : "Unknown Line"}
                  subtitle={item.tier ? `${item.tier}` : undefined}
                  keywords={[item.type, ...item.keywords]}
                  accessories={accessories}
                  actions={
                    <ActionPanel>
                      <Action
                        title="Profile with MaliOC"
                        onAction={() => handleProfileShader(item.code, item.type)}
                      />
                      <Action.CopyToClipboard title="Copy Shader Code" content={item.code} />
                      <Action
                        title="Reload Shader Content"
                        icon={Icon.ArrowClockwise}
                        onAction={revalidate}
                        shortcut={{ modifiers: ["cmd"], key: "r" }}
                      />
                    </ActionPanel>
                  }
                />
              );
            })}
          </List.Section>
        ))
      )}
    </List>
  );
}

import {
    type ContextUsage,
    type ExtensionAPI,
    type ExtensionContext,
    getLastAssistantUsage,
    type ToolInfo,
} from '@earendil-works/pi-coding-agent';

export interface FooterContextUsage extends ContextUsage {
    isStartupEstimate: boolean;
}

export function getFooterContextUsage(
    ctx: ExtensionContext,
    pi: ExtensionAPI
): FooterContextUsage | undefined {
    const usage = ctx.getContextUsage();
    if (!usage) return undefined;

    const hasProviderUsage = getLastAssistantUsage(ctx.sessionManager.getBranch()) !== undefined;
    if (usage.tokens === null || hasProviderUsage) {
        return { ...usage, isStartupEstimate: false };
    }

    const startupTokens = estimateStartupContextTokens(
        ctx.getSystemPrompt(),
        pi.getActiveTools(),
        pi.getAllTools()
    );
    const tokens = usage.tokens + startupTokens;
    return {
        tokens,
        contextWindow: usage.contextWindow,
        percent: (tokens / usage.contextWindow) * 100,
        isStartupEstimate: true,
    };
}

export function estimateStartupContextTokens(
    systemPrompt: string,
    activeToolNames: string[],
    allTools: ToolInfo[]
): number {
    const toolsByName = new Map(allTools.map((tool) => [tool.name, tool]));
    const activeTools = activeToolNames.flatMap((name) => {
        const tool = toolsByName.get(name);
        return tool
            ? [
                  {
                      name: tool.name,
                      description: tool.description,
                      input_schema: tool.parameters,
                  },
              ]
            : [];
    });

    let serializedTools: string;
    try {
        serializedTools = JSON.stringify(activeTools);
    } catch {
        serializedTools = activeTools.map((tool) => `${tool.name}\n${tool.description}`).join('\n');
    }

    return Math.ceil((systemPrompt.length + serializedTools.length) / 4);
}

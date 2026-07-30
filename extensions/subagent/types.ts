import type { Usage } from '@earendil-works/pi-ai';
import type {
    CreateAgentSessionOptions,
    ModelRegistry,
    SessionStats,
} from '@earendil-works/pi-coding-agent';

export type SubagentModel = NonNullable<CreateAgentSessionOptions['model']>;
export type SubagentThinkingLevel = NonNullable<CreateAgentSessionOptions['thinkingLevel']>;

export interface SubagentDetails {
    /** Stable identifier of the isolated in-memory AgentSession. */
    id: string;
    task: string;
    cwd: string;
    model: Pick<SubagentModel, 'provider' | 'id'>;
    thinkingLevel: SubagentThinkingLevel;
    stats?: SessionStats;
}

export interface SubagentRunOptions {
    task: string;
    cwd: string;
    model: SubagentModel;
    /** Parent registry used to inherit its effective provider and resolved runtime auth. */
    modelRegistry: ModelRegistry;
    thinkingLevel: SubagentThinkingLevel;
    projectTrusted: boolean;
    signal?: AbortSignal;
    onUpdate?: (details: SubagentDetails, status: string) => void;
}

export interface SubagentRunResult {
    text: string;
    details: SubagentDetails;
    usage: Usage;
}

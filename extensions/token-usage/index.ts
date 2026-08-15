import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createTokensHandler } from './command.ts';
import { createTokenReportProvider } from './provider.ts';

export default function tokenUsageExtension(pi: ExtensionAPI): void {
    const provider = createTokenReportProvider();

    pi.registerCommand('tokens', {
        description: 'Show historical token usage',
        handler: createTokensHandler(provider),
    });
}

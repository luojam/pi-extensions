import {
    type ExtensionAPI,
    keyHint,
    keyText,
    rawKeyHint,
    type Theme,
    VERSION,
} from '@earendil-works/pi-coding-agent';
import { Text, truncateToWidth } from '@earendil-works/pi-tui';

const LOGO = [
    '            ',
    '  ██████    ',
    '  ██  ██    ',
    '  ████  ██  ',
    '  ██    ██  ',
    '            ',
];

class MyHead {
    private expanded = false;
    private info = new Text('', 1, 0);
    private readonly theme: Theme;

    constructor(theme: Theme) {
        this.theme = theme;
        this.updateInfo();
    }

    setExpanded(expanded: boolean): void {
        this.expanded = expanded;
        this.updateInfo();
    }

    render(width: number): string[] {
        if (width <= 0) return [];

        const logo = LOGO.map((line) => truncateToWidth(this.theme.fg('text', line), width, ''));

        return [...logo, '', ...this.info.render(width)];
    }

    invalidate(): void {
        this.updateInfo();
        this.info.invalidate();
    }

    private updateInfo(): void {
        const theme = this.theme;
        const logo = theme.bold(theme.fg('accent', 'pi')) + theme.fg('dim', ` v${VERSION}`);
        const hint = (keybinding: Parameters<typeof keyHint>[0], description: string) =>
            keyHint(keybinding, description);

        const expandedInstructions = [
            hint('app.interrupt', 'to interrupt'),
            hint('app.clear', 'to clear'),
            rawKeyHint(`${keyText('app.clear')} twice`, 'to exit'),
            hint('app.exit', 'to exit (empty)'),
            hint('app.suspend', 'to suspend'),
            keyHint('tui.editor.deleteToLineEnd', 'to delete to end'),
            hint('app.thinking.cycle', 'to cycle thinking level'),
            rawKeyHint(
                `${keyText('app.model.cycleForward')}/${keyText('app.model.cycleBackward')}`,
                'to cycle models'
            ),
            hint('app.model.select', 'to select model'),
            hint('app.tools.expand', 'to expand tools'),
            hint('app.thinking.toggle', 'to expand thinking'),
            hint('app.editor.external', 'for external editor'),
            rawKeyHint('/', 'for commands'),
            rawKeyHint('!', 'to run bash'),
            rawKeyHint('!!', 'to run bash (no context)'),
            hint('app.message.followUp', 'to queue follow-up'),
            hint('app.message.dequeue', 'to edit all queued messages'),
            hint('app.clipboard.pasteImage', 'to paste image (with text fallback)'),
            rawKeyHint('drop files', 'to attach'),
        ].join('\n');

        const compactInstructions = [
            hint('app.interrupt', 'interrupt'),
            rawKeyHint(`${keyText('app.clear')}/${keyText('app.exit')}`, 'clear/exit'),
            rawKeyHint('/', 'commands'),
            rawKeyHint('!', 'bash'),
            hint('app.tools.expand', 'more'),
        ].join(theme.fg('muted', ' · '));

        const compactOnboarding = theme.fg(
            'dim',
            `Press ${keyText('app.tools.expand')} to show full startup help and loaded resources.`
        );

        this.info.setText(
            this.expanded
                ? `${logo}\n${expandedInstructions}\n`
                : `${logo}\n${compactInstructions}\n${compactOnboarding}\n`
        );
    }
}

export default function setMyHead(pi: ExtensionAPI) {
    pi.on('session_start', (_event, ctx) => {
        if (ctx.mode !== 'tui') return;
        ctx.ui.setHeader((_tui, theme) => new MyHead(theme));
    });
}

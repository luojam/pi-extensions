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
    private info = new Text('', 1, 0);
    private readonly theme: Theme;

    constructor(theme: Theme) {
        this.theme = theme;
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

        const compactInstructions = [
            hint('app.interrupt', 'interrupt'),
            rawKeyHint(`${keyText('app.clear')}/${keyText('app.exit')}`, 'clear/exit'),
            rawKeyHint('/', 'commands'),
            rawKeyHint('!', 'bash'),
            hint('app.tools.expand', 'more'),
        ].join(theme.fg('muted', ' · '));

        this.info.setText(`${logo}\n${compactInstructions}`);
    }
}

export default function setMyHead(pi: ExtensionAPI) {
    pi.on('session_start', (_event, ctx) => {
        if (ctx.mode !== 'tui') return;
        ctx.ui.setHeader((_tui, theme) => new MyHead(theme));
    });
}

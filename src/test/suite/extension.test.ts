import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension activation', () => {
    test('extension is present and activates', async () => {
        const ext = vscode.extensions.getExtension('automat.runtime-python-lsp');
        assert.ok(ext, 'extension should be discoverable by id');
        await ext!.activate();
        assert.strictEqual(ext!.isActive, true);
    });

    test('completion provider returns nothing when no debug session is paused', async () => {
        const doc = await vscode.workspace.openTextDocument({
            language: 'python',
            content: 'foo.bar.',
        });
        await vscode.window.showTextDocument(doc);
        const pos = new vscode.Position(0, 'foo.bar.'.length);

        const result = (await vscode.commands.executeCommand(
            'vscode.executeCompletionItemProvider',
            doc.uri,
            pos,
            '.',
        )) as vscode.CompletionList;

        // Other providers (e.g. word-based) may still produce items; ours should
        // contribute none, so no item should carry our '(runtime)' marker.
        const runtimeItems = (result?.items ?? []).filter((i) =>
            typeof i.detail === 'string' && i.detail.includes('(runtime)'),
        );
        assert.strictEqual(runtimeItems.length, 0);
    });

    test('hover provider returns nothing when no debug session is paused', async () => {
        const doc = await vscode.workspace.openTextDocument({
            language: 'python',
            content: 'thing',
        });
        await vscode.window.showTextDocument(doc);
        const pos = new vscode.Position(0, 2);

        const result = (await vscode.commands.executeCommand(
            'vscode.executeHoverProvider',
            doc.uri,
            pos,
        )) as vscode.Hover[];

        const fromUs = (result ?? []).filter((h) =>
            h.contents.some((c) => {
                const v = typeof c === 'string' ? c : (c as vscode.MarkdownString).value;
                return typeof v === 'string' && v.includes('Defined in');
            }),
        );
        assert.strictEqual(fromUs.length, 0);
    });
});

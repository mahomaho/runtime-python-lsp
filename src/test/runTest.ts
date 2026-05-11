import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
    try {
        // Inherited from a parent VS Code / Electron process; would make the test
        // VS Code binary launch as Node and reject all VS Code CLI flags.
        delete process.env.ELECTRON_RUN_AS_NODE;
        delete process.env.VSCODE_ESM_ENTRYPOINT;

        const extensionDevelopmentPath = path.resolve(__dirname, '../../');
        const extensionTestsPath = path.resolve(__dirname, './suite/index');
        await runTests({
            version: '1.93.1',
            extensionDevelopmentPath,
            extensionTestsPath,
            launchArgs: ['--disable-extensions'],
        });
    } catch (err) {
        console.error('Failed to run tests', err);
        process.exit(1);
    }
}

main();

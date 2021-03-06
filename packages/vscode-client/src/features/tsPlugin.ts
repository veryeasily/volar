import * as vscode from 'vscode';
import * as path from 'upath';
import * as fs from 'fs';
import { userPick } from './formatAll';

export async function activate(context: vscode.ExtensionContext) {

    const tsPluginEnabled = isPluginEnabled();
    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right);
    statusBar.command = 'volar.action.switchTsPlugin';
    onConfigUpdated();

    context.subscriptions.push(vscode.commands.registerCommand('volar.action.switchTsPlugin', async () => {
        const options = new Map<number, string>();
        options.set(1, (isConfigEnabled() ? '• ' : '') + 'Enable TS Plugin');
        options.set(2, (!isConfigEnabled() ? '• ' : '') + 'Disable TS Plugin');
        options.set(3, 'Hide TS Plugin Status (or config "volar.tsPluginStatus")');

        const select = await userPick(options);
        if (select === undefined) return; // cancle

        if (select === 1) {
            await vscode.workspace.getConfiguration('volar').update('tsPlugin', true);
        }
        if (select === 2) {
            await vscode.workspace.getConfiguration('volar').update('tsPlugin', false);
        }
        if (select === 3) {
            await vscode.workspace.getConfiguration('volar').update('tsPluginStatus', false);
        }
    }));
    vscode.workspace.onDidChangeConfiguration(onConfigUpdated);

    function onConfigUpdated() {
        if (isConfigEnabled() !== tsPluginEnabled) {
            switchTsPlugin();
        }
        updateStatusBar();
        if (vscode.workspace.getConfiguration('volar').get<boolean>('tsPluginStatus')) {
            statusBar.show();
        }
        else {
            statusBar.hide();
        }
    }
    function switchTsPlugin() {
        const volar = vscode.extensions.getExtension('johnsoncodehk.volar');
        if (!volar) {
            vscode.window.showWarningMessage('Extension [Volar - johnsoncodehk.volar] not found.');
            return;
        }

        const packageJson = path.join(volar.extensionPath, 'package.json');
        try {
            const packageText = fs.readFileSync(packageJson, 'utf8');
            if (packageText.indexOf(`"typescriptServerPlugins-off"`) >= 0) {
                const newText = packageText.replace(`"typescriptServerPlugins-off"`, `"typescriptServerPlugins"`);
                fs.writeFileSync(packageJson, newText, 'utf8');
                showReload(true);
            }
            else if (packageText.indexOf(`"typescriptServerPlugins"`) >= 0) {
                const newText = packageText.replace(`"typescriptServerPlugins"`, `"typescriptServerPlugins-off"`);
                fs.writeFileSync(packageJson, newText, 'utf8');
                showReload(false);
            }
            else {
                vscode.window.showWarningMessage('Unknow package.json status.');
            }
        }
        catch (err) {
            vscode.window.showWarningMessage('Volar package.json update failed.');
        }
    }
    async function showReload(enabled: boolean) {
        const reload = await vscode.window.showInformationMessage(`Volar TS Plugin ${enabled ? 'enabled' : 'disabled'}, please reload VSCode to refresh TS Server.`, 'Reload Window');
        if (reload === undefined) return; // cancel
        vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
    function updateStatusBar() {
        if (tsPluginEnabled) {
            statusBar.text = '[Volar] TS Plugin: On';
            statusBar.color = undefined;
            statusBar.backgroundColor = undefined;
        }
        else {
            statusBar.text = '[Volar] TS Plugin: Off';
            statusBar.color = undefined;
            statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        }
        if (isConfigEnabled() !== tsPluginEnabled) {
            statusBar.text += ' -> ' + (isConfigEnabled() ? 'On' : 'Off');
            statusBar.color = new vscode.ThemeColor('titleBar.inactiveForeground');
            statusBar.backgroundColor = undefined;
        }
    }
    function isPluginEnabled() {
        const volar = vscode.extensions.getExtension('johnsoncodehk.volar');
        if (!volar) {
            return false;
        }

        const packageJson = path.join(volar.extensionPath, 'package.json');
        try {
            const packageText = fs.readFileSync(packageJson, 'utf8');
            if (packageText.indexOf(`"typescriptServerPlugins"`) >= 0) {
                return true;
            }
        } catch { }

        return false;
    }
    function isConfigEnabled() {
        return !!vscode.workspace.getConfiguration('volar').get<boolean>('tsPlugin');
    }
}

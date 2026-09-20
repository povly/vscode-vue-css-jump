import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
    getStyleSources,
    resolveClass,
    findModuleUsageAt,
    findClassAttrUsageAt,
    findStyleSrcAt,
    findStyleSrcIssues,
    collectModuleClassNames,
    isOnStyleBase,
    positionInText,
    camelize,
    type ResolveHit,
    type StyleSources,
} from './lib';

function activate(context: vscode.ExtensionContext): void {
    const selector: vscode.DocumentSelector = [{ language: 'vue', scheme: 'file' }];

    function workspaceRootOf(document: vscode.TextDocument): string {
        const folder = vscode.workspace.getWorkspaceFolder(document.uri);
        return folder ? folder.uri.fsPath : path.dirname(document.uri.fsPath);
    }

    function toLocation(hit: ResolveHit, sfcText: string, document: vscode.TextDocument): vscode.Location {
        if (hit.kind === 'file') {
            const raw = fs.readFileSync(hit.path, 'utf8');
            const p = positionInText(raw, hit.entry.offset);
            return new vscode.Location(vscode.Uri.file(hit.path), new vscode.Position(p.line, p.character));
        }
        const p = positionInText(sfcText, hit.vueOffset);
        return new vscode.Location(document.uri, new vscode.Position(p.line, p.character));
    }

    function resolveSrcFile(src: string, document: vscode.TextDocument): string {
        const base = src.startsWith('/') ? workspaceRootOf(document) : path.dirname(document.uri.fsPath);
        return path.resolve(base, src);
    }

    function styleSrcLocationAt(
        text: string,
        offset: number,
        document: vscode.TextDocument,
    ): vscode.Location | null {
        const range = findStyleSrcAt(text, offset);
        if (!range || (!range.src.startsWith('.') && !range.src.startsWith('/'))) {
            return null;
        }
        const file = resolveSrcFile(range.src, document);
        if (fs.existsSync(file)) {
            return new vscode.Location(vscode.Uri.file(file), new vscode.Position(0, 0));
        }
        return null;
    }

    function provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
    ): vscode.Location[] | null {
        const text = document.getText();
        const offset = document.offsetAt(position);
        const sources: StyleSources = getStyleSources(
            text,
            document.uri.fsPath,
            workspaceRootOf(document),
        );

        const usage = findModuleUsageAt(text, offset);
        if (usage) {
            const hits = resolveClass(sources, usage.name, {
                prefix: usage.prefix,
                modulesOnly: true,
            });
            return hits.length ? hits.map((h) => toLocation(h, text, document)) : null;
        }

        const attrUsage = findClassAttrUsageAt(text, offset);
        if (attrUsage) {
            const hits = resolveClass(sources, attrUsage.name);
            return hits.length ? hits.map((h) => toLocation(h, text, document)) : null;
        }

        const srcLocation = styleSrcLocationAt(text, offset, document);
        if (srcLocation) {
            return [srcLocation];
        }

        if (isOnStyleBase(text, offset)) {
            const locations: vscode.Location[] = [];
            for (const f of sources.files) {
                if (f.module) {
                    locations.push(new vscode.Location(vscode.Uri.file(f.path), new vscode.Position(0, 0)));
                }
            }
            for (const inline of sources.inlines) {
                if (inline.module) {
                    const p = positionInText(text, inline.offset);
                    locations.push(
                        new vscode.Location(document.uri, new vscode.Position(p.line, p.character)),
                    );
                }
            }
            return locations.length ? locations : null;
        }

        return null;
    }

    function provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
    ): vscode.Hover | null {
        const text = document.getText();
        const offset = document.offsetAt(position);

        const srcRange = findStyleSrcAt(text, offset);
        if (srcRange) {
            const abs = resolveSrcFile(srcRange.src, document);
            const md = new vscode.MarkdownString();
            md.appendMarkdown('**Vue CSS Jump — style source**\n\n`' + abs + '`\n\n');
            if (fs.existsSync(abs)) {
                const sources = getStyleSources(text, document.uri.fsPath, workspaceRootOf(document));
                const inThisFile = sources.files.find((f) => f.path === abs);
                const count = inThisFile ? collectModuleClassNames({
                    files: [inThisFile],
                    inlines: [],
                }).length : 0;
                md.appendMarkdown(`✓ file exists — ${count} class${count === 1 ? '' : 'es'} indexed`);
            } else {
                md.appendMarkdown('✗ file not found');
            }
            const range = new vscode.Range(
                document.positionAt(srcRange.start),
                document.positionAt(srcRange.end),
            );
            return new vscode.Hover(md, range);
        }

        const usage = findModuleUsageAt(text, offset);
        if (usage) {
            const sources = getStyleSources(text, document.uri.fsPath, workspaceRootOf(document));
            const hits = resolveClass(sources, usage.name, {
                prefix: usage.prefix,
                modulesOnly: true,
            });
            if (!hits.length) {
                return null;
            }
            const md = new vscode.MarkdownString();
            md.appendMarkdown(`**Vue CSS Jump — \`$style.${usage.name}\`**\n\n`);
            for (const h of hits.slice(0, 8)) {
                if (h.kind === 'file') {
                    const raw = fs.readFileSync(h.path, 'utf8');
                    const p = positionInText(raw, h.entry.offset);
                    md.appendMarkdown(`- \`.${h.entry.name}\` — ${path.basename(h.path)}:${p.line + 1}\n`);
                } else {
                    const p = positionInText(text, h.vueOffset);
                    md.appendMarkdown(`- \`.${h.entry.name}\` — inline &lt;style&gt;:${p.line + 1}\n`);
                }
            }
            const range = new vscode.Range(
                document.positionAt(usage.start),
                document.positionAt(usage.end),
            );
            return new vscode.Hover(md, range);
        }

        return null;
    }

    const STYLE_MEMBER_DOT_RE = /\$style\.([A-Za-z_$][\w$]*)?$/;
    const STYLE_MEMBER_BRACKET_RE = /\$style\[\s*(["'`])([^"'`\]]*)$/;

    function provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
    ): vscode.CompletionItem[] | null {
        const linePrefix = document.getText(
            new vscode.Range(position.with({ character: 0 }), position),
        );

        let typed = '';
        let bracket = false;
        const dot = STYLE_MEMBER_DOT_RE.exec(linePrefix);
        if (dot) {
            typed = dot[1] ?? '';
        } else {
            const br = STYLE_MEMBER_BRACKET_RE.exec(linePrefix);
            if (!br) {
                return null;
            }
            typed = br[2] ?? '';
            bracket = true;
        }

        const text = document.getText();
        const sources = getStyleSources(text, document.uri.fsPath, workspaceRootOf(document));
        const names = collectModuleClassNames(sources);
        const items: vscode.CompletionItem[] = [];
        for (const name of names) {
            // After `$style.` only identifier-safe names are insertable;
            // dashed names need the bracket form `$style['kebab-name']`.
            if (!bracket && !/^[A-Za-z_$][\w$]*$/.test(name)) {
                continue;
            }
            if (typed && !name.startsWith(typed) && !camelize(name).startsWith(typed)) {
                continue;
            }
            const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Value);
            item.detail = 'vue-css-jump: CSS module class';
            items.push(item);
        }
        return items.length ? items : null;
    }

    function refreshDiagnostics(document: vscode.TextDocument): void {
        const exists = (src: string): boolean =>
            fs.existsSync(resolveSrcFile(src, document));
        const issues = findStyleSrcIssues(document.getText(), exists);
        diagnostics.set(
            document.uri,
            issues.map((i) => {
                const range = new vscode.Range(
                    document.positionAt(i.start),
                    document.positionAt(i.end),
                );
                return new vscode.Diagnostic(
                    range,
                    i.message,
                    i.severity === 'error'
                        ? vscode.DiagnosticSeverity.Error
                        : vscode.DiagnosticSeverity.Warning,
                );
            }),
        );
    }

    const diagnostics = vscode.languages.createDiagnosticCollection('vue-css-jump');

    context.subscriptions.push(
        vscode.languages.registerDefinitionProvider(selector, { provideDefinition }),
        vscode.languages.registerHoverProvider(selector, { provideHover }),
        vscode.languages.registerCompletionItemProvider(
            selector,
            { provideCompletionItems },
            '.',
            '[',
            "'",
            '"',
            '`',
        ),
        diagnostics,
        vscode.workspace.onDidOpenTextDocument(refreshDiagnostics),
        vscode.workspace.onDidChangeTextDocument((e) => {
            if (e.document.languageId === 'vue') {
                refreshDiagnostics(e.document);
            }
        }),
        vscode.workspace.onDidCloseTextDocument((d) => diagnostics.delete(d.uri)),
    );

    for (const doc of vscode.workspace.textDocuments) {
        if (doc.languageId === 'vue') {
            refreshDiagnostics(doc);
        }
    }
}

export { activate };
export function deactivate(): void {}

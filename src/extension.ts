import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
    parseStyleBlocks,
    getStyleSources,
    resolveClass,
    findModuleUsageAt,
    findClassAttrUsageAt,
    isOnStyleBase,
    positionInText,
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

    function styleSrcLocationAt(
        text: string,
        offset: number,
        document: vscode.TextDocument,
    ): vscode.Location | null {
        const root = workspaceRootOf(document);
        const dir = path.dirname(document.uri.fsPath);
        for (const b of parseStyleBlocks(text)) {
            if (!b.src || (!b.src.startsWith('.') && !b.src.startsWith('/'))) {
                continue;
            }
            const srcRe = new RegExp(`src\\s*=\\s*(["'])${escapeRegExp(b.src)}\\1`);
            const m = srcRe.exec(text);
            if (!m) {
                continue;
            }
            const start = m.index + m[0].indexOf(b.src);
            if (offset < start || offset > start + b.src.length) {
                continue;
            }
            const base = b.src.startsWith('/') ? root : dir;
            const file = path.resolve(base, b.src);
            if (fs.existsSync(file)) {
                return new vscode.Location(vscode.Uri.file(file), new vscode.Position(0, 0));
            }
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

    context.subscriptions.push(
        vscode.languages.registerDefinitionProvider(selector, { provideDefinition }),
    );
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export { activate };
export function deactivate(): void {}
